/**
 * Auto-chunking orchestrator.
 *
 * Given a big goal, this coordinator:
 *   1. asks a planner sub-agent to decompose it into independent chunks (JSON),
 *   2. dispatches worker sub-agents in dependency-ordered waves (parallel,
 *      bounded by concurrency),
 *   3. optionally validates each chunk against success criteria with a
 *      reviewer sub-agent, retrying failed chunks once with feedback,
 *   4. optionally synthesizes all chunk outputs into a final deliverable.
 *
 * The whole job runs in the background as a group; the orchestrating agent
 * spawns it, keeps working, then awaits or polls it.
 */

import type { GroupRecord, OrchestrateSpec, PlannedChunk, TaskRecord } from "./types.ts";
import { capBytes, extractJson, mapWithConcurrency } from "./util.ts";
import type { CoordinatorDeps } from "./workflow.ts";

const DEFAULT_MAX_CHUNKS = 8;

export function startOrchestration(deps: CoordinatorDeps, spec: OrchestrateSpec): GroupRecord {
	const group = deps.groups.create("orchestrate", "orchestrate", spec.goal, {
		criteria: spec.criteria ?? null,
		validate: spec.validate !== false,
		synthesize: spec.synthesize !== false,
	});

	void runOrchestration(deps, spec, group).catch((err) => {
		deps.groups.finish(group.id, "failed", group.output, `Orchestration crashed: ${(err as Error).message}`);
	});

	return group;
}

async function runOrchestration(deps: CoordinatorDeps, spec: OrchestrateSpec, group: GroupRecord): Promise<void> {
	const cap = deps.config.perTaskOutputCap;
	const cwd = spec.cwd ?? deps.cwd;
	const concurrency = spec.concurrency && spec.concurrency > 0 ? spec.concurrency : deps.config.maxConcurrency;
	const maxChunks = spec.maxChunks && spec.maxChunks > 0 ? spec.maxChunks : DEFAULT_MAX_CHUNKS;

	const enqueueAndWait = async (
		task: string,
		agent: string | undefined,
		label: string,
		meta: Record<string, unknown>,
	): Promise<TaskRecord> => {
		const record = deps.runner.enqueue({ task, agent, label, model: spec.model, tools: spec.tools, cwd, groupId: group.id, meta });
		group.taskIds.push(record.id);
		deps.groups.update(group);
		const [done] = await deps.runner.waitFor([record.id]);
		return done ?? record;
	};

	// 1. Plan ------------------------------------------------------------------
	group.note = "planning";
	deps.groups.update(group);
	const plannerPrompt = buildPlannerPrompt(spec, maxChunks);
	const planRecord = await enqueueAndWait(plannerPrompt, spec.plannerAgent ?? "planner", "planner", { role: "planner" });
	if (planRecord.status !== "succeeded") {
		deps.groups.finish(group.id, "failed", planRecord.output, `Planner failed: ${planRecord.errorMessage ?? planRecord.status}`);
		return;
	}

	const chunks = parseChunks(planRecord.output, maxChunks);
	if (chunks.length === 0) {
		deps.groups.finish(
			group.id,
			"failed",
			planRecord.output,
			"Planner did not return a parseable chunk list. Raw planner output preserved.",
		);
		return;
	}
	group.meta = { ...group.meta, chunkCount: chunks.length };

	// 2. Dispatch in dependency waves -----------------------------------------
	const chunkById = new Map(chunks.map((c) => [c.id, c]));
	const results = new Map<string, TaskRecord>();
	const succeeded = new Set<string>();
	const failed = new Set<string>();
	const started = new Set<string>();

	let wave = 0;
	while (started.size < chunks.length) {
		const ready = chunks.filter(
			(c) => !started.has(c.id) && c.dependsOn.every((d) => succeeded.has(d) || !chunkById.has(d)),
		);
		if (ready.length === 0) break; // remaining chunks blocked by failed deps or a cycle
		wave += 1;
		for (const c of ready) started.add(c.id);
		group.note = `wave ${wave}: ${succeeded.size}/${chunks.length} done, running ${ready.length}`;
		deps.groups.update(group);

		const waveResults = await mapWithConcurrency(ready, concurrency, async (chunk) => {
			const prompt = buildWorkerPrompt(chunk, spec, results, cap);
			const record = await enqueueAndWait(prompt, spec.workerAgent ?? "worker", chunk.title || chunk.id, {
				role: "worker",
				chunk: chunk.id,
			});
			return { chunk, record };
		});
		for (const { chunk, record } of waveResults) {
			results.set(chunk.id, record);
			if (record.status === "succeeded") succeeded.add(chunk.id);
			else failed.add(chunk.id);
		}
	}

	const blocked = chunks.filter((c) => !started.has(c.id)).map((c) => c.id);

	if (succeeded.size === 0) {
		deps.groups.finish(group.id, "failed", renderChunkReport(chunks, results, blocked, cap), "All chunks failed.");
		return;
	}

	// 3. Validate (optional) ---------------------------------------------------
	const validate = spec.validate !== false && Boolean(spec.criteria || spec.validatorAgent);
	if (validate) {
		group.note = `validating ${succeeded.size} chunk(s)`;
		deps.groups.update(group);

		const toValidate = chunks.filter((c) => succeeded.has(c.id));
		const verdicts = await mapWithConcurrency(toValidate, concurrency, async (chunk) => {
			const record = results.get(chunk.id);
			if (!record) return { chunk, verdict: "pass" as const, feedback: "" };
			const prompt = buildValidatorPrompt(chunk, spec, record, cap);
			const vr = await enqueueAndWait(prompt, spec.validatorAgent ?? "reviewer", `validate:${chunk.id}`, {
				role: "validator",
				chunk: chunk.id,
			});
			const parsed = parseVerdict(vr.output);
			return { chunk, verdict: parsed.verdict, feedback: parsed.feedback };
		});

		const failedValidation = verdicts.filter((v) => v.verdict === "fail");
		if (failedValidation.length > 0) {
			group.note = `retrying ${failedValidation.length} chunk(s) after validation feedback`;
			deps.groups.update(group);
			await mapWithConcurrency(failedValidation, concurrency, async ({ chunk, feedback }) => {
				const prompt = buildRetryPrompt(chunk, spec, results, feedback, cap);
				const record = await enqueueAndWait(prompt, spec.workerAgent ?? "worker", `retry:${chunk.title || chunk.id}`, {
					role: "worker-retry",
					chunk: chunk.id,
				});
				results.set(chunk.id, record);
				if (record.status !== "succeeded") {
					succeeded.delete(chunk.id);
					failed.add(chunk.id);
				}
			});
		}
	}

	// 4. Synthesize (optional) -------------------------------------------------
	const report = renderChunkReport(chunks, results, blocked, cap);
	if (spec.synthesize !== false) {
		group.note = "synthesizing";
		deps.groups.update(group);
		const prompt = buildSynthPrompt(spec, chunks, results, cap);
		const synth = await enqueueAndWait(prompt, spec.synthesizerAgent ?? "synthesizer", "synthesizer", { role: "synthesizer" });
		if (synth.status === "succeeded" && synth.output.trim()) {
			const finalOut = `${synth.output}\n\n---\n\n<details: per-chunk results>\n\n${report}`;
			deps.groups.finish(group.id, failed.size > 0 ? "succeeded" : "succeeded", capBytes(finalOut, cap * 4));
			return;
		}
	}

	deps.groups.finish(group.id, "succeeded", report);
}

// --- Prompt builders --------------------------------------------------------

function buildPlannerPrompt(spec: OrchestrateSpec, maxChunks: number): string {
	const lines = [
		"Decompose the following goal into independent, parallelizable chunks of work.",
		"",
		"GOAL:",
		spec.goal,
	];
	if (spec.context?.trim()) lines.push("", "CONTEXT:", spec.context.trim());
	if (spec.criteria?.trim()) lines.push("", "SUCCESS CRITERIA:", spec.criteria.trim());
	lines.push(
		"",
		"Rules:",
		`- Produce at most ${maxChunks} chunks.`,
		"- Each chunk must be self-contained: a fresh agent that has NOT seen this conversation must be able to execute it from the chunk text alone. Include concrete paths, names, and requirements.",
		"- Prefer independent chunks. Only set dependsOn when a chunk genuinely needs another chunk's result.",
		"- Do NOT do the work now. Only plan.",
		"",
		"Output ONLY a JSON array (no prose, no code fence needed) in exactly this shape:",
		'[{"id":"c1","title":"short title","task":"detailed self-contained instructions","dependsOn":[]}]',
	);
	return lines.join("\n");
}

function buildWorkerPrompt(
	chunk: PlannedChunk,
	spec: OrchestrateSpec,
	results: Map<string, TaskRecord>,
	cap: number,
): string {
	const lines = [chunk.task];
	const depOutputs = chunk.dependsOn
		.map((d) => results.get(d)?.output)
		.filter((o): o is string => Boolean(o && o.trim()));
	if (depOutputs.length > 0) {
		lines.push("", "Context from prerequisite chunks:", capBytes(depOutputs.join("\n\n---\n\n"), cap));
	}
	if (spec.criteria?.trim()) lines.push("", `Success criteria for the overall goal: ${spec.criteria.trim()}`);
	lines.push("", "When finished, report concisely what you did, including any files changed.");
	return lines.join("\n");
}

function buildValidatorPrompt(chunk: PlannedChunk, spec: OrchestrateSpec, record: TaskRecord, cap: number): string {
	return [
		"Validate whether the following completed work satisfies its task and the success criteria.",
		"",
		"TASK:",
		chunk.task,
		"",
		"SUCCESS CRITERIA:",
		spec.criteria?.trim() || "The task was completed as described.",
		"",
		"WORK RESULT:",
		capBytes(record.output || "(no output)", cap),
		"",
		'Respond with ONLY a JSON object: {"verdict":"pass"|"fail","feedback":"specific actionable feedback when fail"}',
	].join("\n");
}

function buildRetryPrompt(
	chunk: PlannedChunk,
	spec: OrchestrateSpec,
	results: Map<string, TaskRecord>,
	feedback: string,
	cap: number,
): string {
	return [
		buildWorkerPrompt(chunk, spec, results, cap),
		"",
		"A previous attempt did not pass validation. Address this feedback:",
		feedback || "(no specific feedback provided; re-check the task and criteria carefully)",
	].join("\n");
}

function buildSynthPrompt(
	spec: OrchestrateSpec,
	chunks: PlannedChunk[],
	results: Map<string, TaskRecord>,
	cap: number,
): string {
	const chunkText = chunks
		.map((c) => {
			const r = results.get(c.id);
			return `### ${c.title || c.id} (${r?.status ?? "skipped"})\n\n${r?.output || r?.errorMessage || "(not run)"}`;
		})
		.join("\n\n---\n\n");
	return [
		"Combine the results of these parallel work chunks into a single coherent deliverable for the overall goal.",
		"",
		"GOAL:",
		spec.goal,
		"",
		"CHUNK RESULTS:",
		capBytes(chunkText, cap * 3),
		"",
		"Produce a clear final summary: what was accomplished, how the pieces fit together, and any gaps or follow-ups.",
	].join("\n");
}

// --- Parsing helpers --------------------------------------------------------

function parseChunks(text: string, maxChunks: number): PlannedChunk[] {
	const raw = extractJson<unknown>(text);
	if (!Array.isArray(raw)) return [];
	const chunks: PlannedChunk[] = [];
	for (let i = 0; i < raw.length && chunks.length < maxChunks; i++) {
		const item = raw[i] as Record<string, unknown>;
		if (!item || typeof item !== "object") continue;
		const task = typeof item.task === "string" ? item.task : typeof item.description === "string" ? item.description : "";
		if (!task.trim()) continue;
		const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `c${chunks.length + 1}`;
		const title = typeof item.title === "string" ? item.title : id;
		const dependsOn = Array.isArray(item.dependsOn)
			? item.dependsOn.filter((d): d is string => typeof d === "string")
			: [];
		chunks.push({ id, title, task, dependsOn });
	}
	// Drop self-references and unknown dep ids to avoid deadlocks.
	const ids = new Set(chunks.map((c) => c.id));
	for (const c of chunks) c.dependsOn = c.dependsOn.filter((d) => d !== c.id && ids.has(d));
	return chunks;
}

function parseVerdict(text: string): { verdict: "pass" | "fail"; feedback: string } {
	const json = extractJson<{ verdict?: string; feedback?: string }>(text);
	if (json && typeof json.verdict === "string") {
		const verdict = /fail/i.test(json.verdict) ? "fail" : "pass";
		return { verdict, feedback: typeof json.feedback === "string" ? json.feedback : "" };
	}
	// Fallback heuristic.
	const hasFail = /\bfail(ed|ure)?\b/i.test(text);
	const hasPass = /\bpass(ed|es)?\b/i.test(text);
	if (hasFail && !hasPass) return { verdict: "fail", feedback: text.slice(0, 2000) };
	return { verdict: "pass", feedback: "" };
}

function renderChunkReport(
	chunks: PlannedChunk[],
	results: Map<string, TaskRecord>,
	blocked: string[],
	cap: number,
): string {
	const parts = chunks.map((c) => {
		const r = results.get(c.id);
		const status = blocked.includes(c.id) ? "blocked" : (r?.status ?? "skipped");
		return `### ${c.title || c.id} [${status}]\n\n${r?.output || r?.errorMessage || "(not run)"}`;
	});
	return capBytes(parts.join("\n\n---\n\n"), cap * 4);
}

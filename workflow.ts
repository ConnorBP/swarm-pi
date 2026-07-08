/**
 * Workflow engine.
 *
 * A workflow is an ordered list of steps executed with a barrier between each.
 * Step kinds:
 *   - task:   run one sub-agent.
 *   - map:    fan out one sub-agent per item (literal list or split from a
 *             prior step's output), bounded by concurrency.
 *   - reduce: run one sub-agent that receives prior step outputs as {inputs}.
 *
 * Prompt templates may reference: {goal} {previous} {steps.<id>} {inputs}
 * and, inside a map step, {item} {index}.
 *
 * The whole workflow runs as a background group so the orchestrator can poll
 * or await it while doing other work.
 */

import type { GroupRegistry } from "./groups.ts";
import type { SwarmRunner } from "./runner.ts";
import type { GroupRecord, SwarmConfig, TaskRecord, WorkflowSpec, WorkflowStep } from "./types.ts";
import { capBytes, fillTemplate, mapWithConcurrency } from "./util.ts";

export interface CoordinatorDeps {
	runner: SwarmRunner;
	groups: GroupRegistry;
	config: SwarmConfig;
	cwd: string;
}

export function validateWorkflow(spec: WorkflowSpec): string | null {
	if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) {
		return "Workflow must have a non-empty `steps` array.";
	}
	const seen = new Set<string>();
	for (const step of spec.steps) {
		if (!step.id) return "Every workflow step needs an `id`.";
		if (seen.has(step.id)) return `Duplicate step id: "${step.id}".`;
		seen.add(step.id);
		if (!["task", "map", "reduce"].includes(step.kind)) {
			return `Step "${step.id}" has invalid kind "${step.kind}".`;
		}
		if (!step.prompt || !step.prompt.trim()) return `Step "${step.id}" needs a \`prompt\`.`;
		if (step.kind === "map" && !step.items && !step.itemsFromStep) {
			return `Map step "${step.id}" needs \`items\` or \`itemsFromStep\`.`;
		}
	}
	return null;
}

function combineTaskOutputs(records: TaskRecord[], cap: number): string {
	const parts = records.map((r, i) => {
		const status = r.status === "succeeded" ? "" : ` (${r.status})`;
		const head = `### [${r.label || `item ${i + 1}`}]${status}`;
		return `${head}\n\n${r.output || r.errorMessage || "(no output)"}`;
	});
	return capBytes(parts.join("\n\n---\n\n"), cap);
}

/** Kick off a workflow in the background. Returns the group record immediately. */
export function startWorkflow(deps: CoordinatorDeps, spec: WorkflowSpec, goal: string): GroupRecord {
	const name = spec.name ?? "workflow";
	const group = deps.groups.create("workflow", name, goal, { steps: spec.steps.length });

	void runWorkflow(deps, spec, goal, group).catch((err) => {
		deps.groups.finish(group.id, "failed", group.output, `Workflow crashed: ${(err as Error).message}`);
	});

	return group;
}

async function runWorkflow(
	deps: CoordinatorDeps,
	spec: WorkflowSpec,
	goal: string,
	group: GroupRecord,
): Promise<void> {
	const cap = deps.config.perTaskOutputCap;
	const stepOutputs = new Map<string, string>();
	let previous = "";

	for (let i = 0; i < spec.steps.length; i++) {
		const step = spec.steps[i];
		group.note = `step ${i + 1}/${spec.steps.length}: ${step.kind}(${step.id})`;
		deps.groups.update(group);

		const baseVars: Record<string, string> = { goal, previous };
		for (const [id, out] of stepOutputs) baseVars[`steps.${id}`] = out;

		let combined: string;
		let stepRecords: TaskRecord[];
		try {
			stepRecords = await runStep(deps, step, baseVars, stepOutputs, group, cap);
		} catch (err) {
			deps.groups.finish(group.id, "failed", combineOutputsSoFar(stepOutputs, previous), (err as Error).message);
			return;
		}

		const anySuccess = stepRecords.some((r) => r.status === "succeeded");
		if (stepRecords.length > 0 && !anySuccess) {
			const failOutput = combineTaskOutputs(stepRecords, cap);
			deps.groups.finish(group.id, "failed", failOutput, `Step "${step.id}" failed: all tasks errored.`);
			return;
		}

		combined = combineTaskOutputs(stepRecords, cap);
		stepOutputs.set(step.id, combined);
		previous = combined;
	}

	deps.groups.finish(group.id, "succeeded", previous);
}

function combineOutputsSoFar(stepOutputs: Map<string, string>, previous: string): string {
	if (stepOutputs.size === 0) return previous;
	return Array.from(stepOutputs.entries())
		.map(([id, out]) => `## ${id}\n\n${out}`)
		.join("\n\n");
}

async function runStep(
	deps: CoordinatorDeps,
	step: WorkflowStep,
	baseVars: Record<string, string>,
	stepOutputs: Map<string, string>,
	group: GroupRecord,
	cap: number,
): Promise<TaskRecord[]> {
	const enqueueAndWait = async (task: string, label: string, meta: Record<string, unknown>): Promise<TaskRecord> => {
		const record = deps.runner.enqueue({
			task,
			agent: step.agent,
			label,
			model: step.model,
			tools: step.tools,
			cwd: step.cwd ?? deps.cwd,
			groupId: group.id,
			meta,
		});
		group.taskIds.push(record.id);
		deps.groups.update(group);
		const [done] = await deps.runner.waitFor([record.id]);
		return done ?? record;
	};

	if (step.kind === "task") {
		const prompt = fillTemplate(step.prompt, baseVars);
		const record = await enqueueAndWait(prompt, step.label ?? step.agent ?? step.id, { step: step.id });
		return [record];
	}

	if (step.kind === "reduce") {
		const sources = step.from && step.from.length > 0 ? step.from : Array.from(stepOutputs.keys());
		const inputs = sources
			.map((id) => `## ${id}\n\n${stepOutputs.get(id) ?? "(missing)"}`)
			.join("\n\n---\n\n");
		const prompt = fillTemplate(step.prompt, { ...baseVars, inputs: capBytes(inputs, cap * 4) });
		const record = await enqueueAndWait(prompt, step.label ?? step.agent ?? step.id, { step: step.id, role: "reduce" });
		return [record];
	}

	// map
	const items = resolveMapItems(step, stepOutputs);
	if (items.length === 0) return [];
	const concurrency = step.concurrency && step.concurrency > 0 ? step.concurrency : items.length;
	return mapWithConcurrency(items, concurrency, async (item, index) => {
		const prompt = fillTemplate(step.prompt, { ...baseVars, item, index });
		const label = `${step.label ?? step.id}[${index + 1}]`;
		return enqueueAndWait(prompt, label, { step: step.id, item, index });
	});
}

function resolveMapItems(step: WorkflowStep, stepOutputs: Map<string, string>): string[] {
	if (step.items && step.items.length > 0) return step.items;
	if (step.itemsFromStep) {
		const source = stepOutputs.get(step.itemsFromStep) ?? "";
		const delimiter = step.itemsDelimiter ?? "\n";
		return source
			.split(delimiter === "\\n" ? "\n" : delimiter)
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [];
}

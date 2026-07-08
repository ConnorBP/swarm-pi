/**
 * LLM-callable swarm tools.
 *
 *   swarm_spawn       - launch background sub-agent tasks (async by default)
 *   swarm_status      - poll task / job status
 *   swarm_await       - block until targeted tasks/jobs finish, return outputs
 *   swarm_result      - fetch one task's or job's full output
 *   swarm_cancel      - stop running tasks/jobs
 *   swarm_workflow    - run a declarative multi-stage workflow
 *   swarm_orchestrate - auto-chunk a big goal, delegate, validate, synthesize
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentScope } from "./agents.ts";
import { startOrchestration } from "./orchestrate.ts";
import { renderDashboard, renderTaskResult } from "./render.ts";
import type { SwarmRuntime } from "./runtime.ts";
import type { GroupRecord, SpawnSpec, TaskRecord, WorkflowSpec } from "./types.ts";
import { capBytes, formatDuration, formatUsage } from "./util.ts";
import { startWorkflow, validateWorkflow } from "./workflow.ts";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Agent-profile directories to search. Default from config (usually "user").',
});

const TaskItemSchema = Type.Object({
	task: Type.String({ description: "The instruction for this sub-agent." }),
	agent: Type.Optional(Type.String({ description: "Agent profile name (e.g. worker, scout, reviewer)." })),
	label: Type.Optional(Type.String({ description: "Short display label." })),
	model: Type.Optional(Type.String({ description: 'Model override "provider/id" (default inherits your model).' })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Allowlist of tools for this sub-agent." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this sub-agent." })),
});

function plainTaskLine(r: TaskRecord): string {
	const dur = r.endedAt && r.startedAt ? ` ${formatDuration(r.endedAt - r.startedAt)}` : r.startedAt && r.status === "running" ? ` ${formatDuration(Date.now() - r.startedAt)}` : "";
	const cost = r.usage.cost ? ` $${r.usage.cost.toFixed(4)}` : "";
	const extra = r.status === "failed" && r.errorMessage ? ` - ${r.errorMessage.slice(0, 80)}` : "";
	return `${r.id} [${r.status}] ${r.label || r.agent || "task"}${dur}${cost}${extra}`;
}

function plainGroupLine(g: GroupRecord): string {
	const note = g.note ? ` ${g.note}` : "";
	return `${g.id} [${g.status}] ${g.kind}: ${g.goal.slice(0, 60)}${note} (${g.taskIds.length} tasks)`;
}

function statusText(tasks: TaskRecord[], groups: GroupRecord[]): string {
	const lines: string[] = [];
	if (groups.length > 0) {
		lines.push("Jobs:");
		for (const g of groups) lines.push(`  ${plainGroupLine(g)}`);
	}
	lines.push(tasks.length > 0 ? "Tasks:" : "No tasks.");
	for (const t of tasks) lines.push(`  ${plainTaskLine(t)}`);
	return lines.join("\n");
}

function taskOutputBlock(r: TaskRecord, cap: number): string {
	const status = r.status === "succeeded" ? "" : ` (${r.status})`;
	const body = r.status === "failed" ? r.errorMessage || r.output || "(no output)" : r.output || "(no output)";
	return `### ${r.label || r.id}${status}\n\n${capBytes(body, cap)}`;
}

/** Combine an AbortSignal with an optional timeout into one signal. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
	signal: AbortSignal;
	cleanup: () => void;
	timedOut: () => boolean;
} {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs && timeoutMs > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
		timedOut: () => timedOut,
	};
}

export function registerTools(pi: ExtensionAPI, rt: SwarmRuntime): void {
	// --- swarm_spawn ---------------------------------------------------------
	pi.registerTool({
		name: "swarm_spawn",
		label: "Swarm Spawn",
		description: [
			"Launch one or more sub-agents, each in an isolated pi process with its own context window.",
			"By default runs in the BACKGROUND (async) and returns task ids immediately - keep working, then collect with swarm_status / swarm_await / swarm_result.",
			"Set wait=true to block until all spawned tasks finish and return their outputs inline.",
			"Provide either a single {task, agent?} or a `tasks` array for parallel fan-out.",
		].join(" "),
		promptSnippet: "Delegate work to background sub-agents (single or parallel), async or blocking",
		promptGuidelines: [
			"Use swarm_spawn to parallelize independent sub-tasks across isolated sub-agents instead of doing them sequentially yourself.",
			"For long work, prefer async swarm_spawn (wait omitted) with notify: true (or a follow-up swarm_watch), then END YOUR TURN - you will be re-activated with results when the tasks finish. Do not block in swarm_await for long jobs.",
		],
		parameters: Type.Object({
			tasks: Type.Optional(Type.Array(TaskItemSchema, { description: "Parallel sub-agent tasks." })),
			task: Type.Optional(Type.String({ description: "Single-task shorthand: the instruction." })),
			agent: Type.Optional(Type.String({ description: "Single-task shorthand: agent profile name." })),
			label: Type.Optional(Type.String({ description: "Single-task shorthand: display label." })),
			model: Type.Optional(Type.String({ description: "Single-task shorthand: model override." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Single-task shorthand: tool allowlist." })),
			cwd: Type.Optional(Type.String({ description: "Single-task shorthand: working directory." })),
			agentScope: Type.Optional(AgentScopeSchema),
			wait: Type.Optional(Type.Boolean({ description: "Block until all tasks finish (default false = async background)." })),
			notify: Type.Optional(Type.Boolean({ description: "When async, auto-register a watch so you are re-activated when these tasks finish (lets you end your turn instead of blocking)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope: AgentScope = params.agentScope ?? rt.config.defaultAgentScope;
			const specs: SpawnSpec[] = [];
			if (params.tasks && params.tasks.length > 0) {
				for (const t of params.tasks) {
					specs.push({ task: t.task, agent: t.agent, label: t.label, model: t.model, tools: t.tools, cwd: t.cwd, agentScope: scope });
				}
			} else if (params.task) {
				specs.push({ task: params.task, agent: params.agent, label: params.label, model: params.model, tools: params.tools, cwd: params.cwd, agentScope: scope });
			}

			if (specs.length === 0) {
				const available = rt.getDiscovery(scope).profiles.map((p) => `${p.name} (${p.source})`).join(", ") || "none";
				throw new Error(`swarm_spawn needs a \`task\` or a non-empty \`tasks\` array. Available agents: ${available}`);
			}
			if (specs.length > rt.config.maxSpawnBatch) {
				throw new Error(`Too many tasks (${specs.length}). Max per call is ${rt.config.maxSpawnBatch}.`);
			}

			// Confirm project-local agent profiles (repo-controlled) before running.
			if ((scope === "project" || scope === "both") && rt.config.confirmProjectAgents && ctx.hasUI) {
				const discovery = rt.getDiscovery(scope);
				const requested = new Set(specs.map((s) => s.agent).filter((a): a is string => Boolean(a)));
				const projectAgents = Array.from(requested)
					.map((name) => discovery.profiles.find((p) => p.name === name))
					.filter((p) => p?.source === "project");
				if (projectAgents.length > 0) {
					const names = projectAgents.map((p) => p?.name).join(", ");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: { taskIds: [] } };
					}
				}
			}

			const records = specs.map((s) => rt.runner.enqueue(s));
			const ids = records.map((r) => r.id);

			if (!params.wait) {
				let watchNote = "Use swarm_status to poll, swarm_await to block for results, or swarm_watch to be re-activated when they finish.";
				if (params.notify) {
					try {
						const watchId = rt.watch.add({ ids });
						watchNote = watchId
							? `A watch (${watchId}) is set: you can end your turn now and will be re-activated when these tasks finish. No need to block.`
							: "These tasks already finished; read their output now with swarm_await/swarm_result.";
					} catch {
						// max watches reached, etc.; fall back to the default note
					}
				}
				const text = [`Spawned ${ids.length} background sub-agent task(s): ${ids.join(", ")}.`, watchNote].join("\n");
				return { content: [{ type: "text", text }], details: { taskIds: ids, mode: "async" } };
			}

			const done = await rt.runner.waitFor(ids, signal);
			const ok = done.filter((r) => r.status === "succeeded").length;
			const blocks = done.map((r) => taskOutputBlock(r, rt.config.perTaskOutputCap)).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text: `${ok}/${done.length} succeeded.\n\n${blocks}` }],
				details: { taskIds: ids, mode: "wait" },
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { taskIds?: string[] } | undefined;
			const ids = details?.taskIds ?? [];
			const tasks = ids.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			if (tasks.length === 0) {
				const text = result.content[0];
				return renderDashboardFallback(text);
			}
			if (tasks.length === 1) return renderTaskResult(tasks[0], theme, expanded);
			return renderDashboard(tasks, [], theme, expanded);
		},
	});

	// --- swarm_status --------------------------------------------------------
	pi.registerTool({
		name: "swarm_status",
		label: "Swarm Status",
		description: "Report the status of swarm sub-agent tasks and workflow/orchestration jobs. Optionally filter by task ids or a job (group) id.",
		promptSnippet: "Check status/progress of background swarm tasks and jobs",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Task ids to report (default: all)." })),
			group: Type.Optional(Type.String({ description: "Job/group id: report that job and its tasks." })),
			verbose: Type.Optional(Type.Boolean({ description: "Include latest output snippets." })),
		}),
		async execute(_id, params) {
			let tasks: TaskRecord[];
			let groups: GroupRecord[];
			if (params.group) {
				const g = rt.groups.get(params.group);
				groups = g ? [g] : [];
				tasks = (g?.taskIds ?? []).map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			} else if (params.ids && params.ids.length > 0) {
				groups = [];
				tasks = params.ids.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			} else {
				groups = rt.groups.list();
				tasks = rt.runner.list();
			}
			let text = statusText(tasks, groups);
			if (params.verbose) {
				const snippets = tasks
					.filter((t) => t.output)
					.map((t) => `--- ${t.id} ---\n${capBytes(t.output, 800)}`)
					.join("\n\n");
				if (snippets) text += `\n\n${snippets}`;
			}
			return { content: [{ type: "text", text }], details: { taskIds: tasks.map((t) => t.id), groupIds: groups.map((g) => g.id) } };
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { taskIds?: string[]; groupIds?: string[] } | undefined;
			const tasks = (details?.taskIds ?? []).map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			const groups = (details?.groupIds ?? []).map((id) => rt.groups.get(id)).filter((g): g is GroupRecord => Boolean(g));
			return renderDashboard(tasks, groups, theme, expanded);
		},
	});

	// --- swarm_await ---------------------------------------------------------
	pi.registerTool({
		name: "swarm_await",
		label: "Swarm Await",
		description: [
			"Block until targeted background tasks (or a job) complete, then return their outputs.",
			"Target by task `ids`, a `group` job id, or nothing to await all currently-active work.",
			"Press Esc to stop waiting (tasks keep running in the background).",
			"Note: this BLOCKS the session on 'Working...'. For long jobs prefer swarm_watch (or spawn with notify: true) so you can end your turn and be re-activated when the work finishes.",
		].join(" "),
		promptSnippet: "Wait (blocking) for background swarm work to finish and collect results",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Task ids to await." })),
			group: Type.Optional(Type.String({ description: "Job/group id to await." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Give up waiting after this many ms." })),
		}),
		async execute(_id, params, signal) {
			const timing = withTimeout(signal, params.timeoutMs);
			const cap = rt.config.perTaskOutputCap;
			try {
				// Case 1: await a specific job (workflow / orchestration).
				if (params.group) {
					let group = rt.groups.get(params.group);
					if (!group) throw new Error(`Unknown job id: ${params.group}`);
					await rt.groups.waitFor([group.id], timing.signal);
					group = rt.groups.get(params.group) ?? group;
					const header = timing.timedOut()
						? `Timed out after ${params.timeoutMs}ms. Job ${group.id} status: ${group.status}.`
						: `Job ${group.id} [${group.status}].`;
					const err = group.errorMessage ? `\n${group.errorMessage}` : "";
					return {
						content: [{ type: "text", text: `${header}${err}\n\n${capBytes(group.output || "(no output yet)", cap * 4)}` }],
						details: { taskIds: group.taskIds, groupIds: [group.id] },
					};
				}

				// Case 2: await a specific set of tasks.
				if (params.ids && params.ids.length > 0) {
					await rt.runner.waitFor(params.ids, timing.signal);
					const tasks = params.ids.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
					const stillRunning = tasks.filter((t) => t.status === "queued" || t.status === "running").length;
					const blocks = tasks.map((t) => taskOutputBlock(t, cap)).join("\n\n---\n\n");
					const header = timing.timedOut()
						? `Timed out after ${params.timeoutMs}ms. ${stillRunning} still running.`
						: `${tasks.filter((t) => t.status === "succeeded").length}/${tasks.length} succeeded.`;
					return { content: [{ type: "text", text: `${header}\n\n${blocks}` }], details: { taskIds: params.ids } };
				}

				// Case 3: await ALL currently-active work - loose tasks AND jobs.
				// Jobs enqueue later-stage tasks lazily, so we must await the group
				// itself, not just the tasks that happen to be running right now.
				const activeTaskIds = rt.runner.list().filter((t) => t.status === "queued" || t.status === "running").map((t) => t.id);
				const activeGroupIds = rt.groups.list().filter((g) => g.status === "running").map((g) => g.id);
				if (activeTaskIds.length === 0 && activeGroupIds.length === 0) {
					return { content: [{ type: "text", text: "Nothing to await: no active swarm work." }], details: { taskIds: [] } };
				}
				await Promise.all([
					rt.runner.waitFor(activeTaskIds, timing.signal),
					activeGroupIds.length > 0 ? rt.groups.waitFor(activeGroupIds, timing.signal) : Promise.resolve([]),
				]);

				const groups = activeGroupIds.map((id) => rt.groups.get(id)).filter((g): g is GroupRecord => Boolean(g));
				const tasks = activeTaskIds.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
				const parts: string[] = [];
				if (timing.timedOut()) {
					const running = tasks.filter((t) => t.status === "queued" || t.status === "running").length + groups.filter((g) => g.status === "running").length;
					parts.push(`Timed out after ${params.timeoutMs}ms. ${running} item(s) still running.`);
				}
				for (const g of groups) {
					const err = g.errorMessage ? ` - ${g.errorMessage}` : "";
					parts.push(`## Job ${g.id} [${g.status}] ${g.kind}${err}\n\n${capBytes(g.output || "(no output yet)", cap * 2)}`);
				}
				for (const t of tasks) parts.push(taskOutputBlock(t, cap));
				return {
					content: [{ type: "text", text: parts.join("\n\n---\n\n") || "All active swarm work finished." }],
					details: { taskIds: activeTaskIds, groupIds: activeGroupIds },
				};
			} finally {
				timing.cleanup();
			}
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { taskIds?: string[]; groupIds?: string[] } | undefined;
			const tasks = (details?.taskIds ?? []).map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			const groups = (details?.groupIds ?? []).map((id) => rt.groups.get(id)).filter((g): g is GroupRecord => Boolean(g));
			if (groups.length === 0 && tasks.length === 1) return renderTaskResult(tasks[0], theme, expanded);
			return renderDashboard(tasks, groups, theme, expanded);
		},
	});

	// --- swarm_result --------------------------------------------------------
	pi.registerTool({
		name: "swarm_result",
		label: "Swarm Result",
		description: "Fetch the full final output of a single completed task id or job (group) id.",
		promptSnippet: "Get the full output of one finished swarm task or job",
		parameters: Type.Object({
			id: Type.String({ description: "Task id (t#) or job id (g#)." }),
			full: Type.Optional(Type.Boolean({ description: "Return complete output (default true)." })),
		}),
		async execute(_id, params) {
			const cap = params.full === false ? 2000 : rt.config.perTaskOutputCap * 4;
			if (params.id.startsWith("g")) {
				const g = rt.groups.get(params.id);
				if (!g) throw new Error(`Unknown job id: ${params.id}`);
				return {
					content: [{ type: "text", text: `Job ${g.id} [${g.status}] ${g.kind}\n\n${capBytes(g.output || "(no output)", cap)}` }],
					details: { groupIds: [g.id] },
				};
			}
			const r = rt.runner.get(params.id);
			if (!r) throw new Error(`Unknown task id: ${params.id}`);
			const parts = [`Task ${r.id} [${r.status}] ${r.label}`];
			if (r.toolCalls.length > 0) parts.push(`Tools used: ${r.toolCalls.map((c) => c.name).join(", ")}`);
			const usage = formatUsage(r.usage, r.model);
			if (usage) parts.push(usage);
			parts.push("", capBytes(r.status === "failed" ? r.errorMessage || r.output : r.output || "(no output)", cap));
			return { content: [{ type: "text", text: parts.join("\n") }], details: { taskIds: [r.id] } };
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { taskIds?: string[] } | undefined;
			const tasks = (details?.taskIds ?? []).map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			if (tasks.length === 1) return renderTaskResult(tasks[0], theme, expanded);
			const text = result.content[0];
			return renderDashboardFallback(text);
		},
	});

	// --- swarm_cancel --------------------------------------------------------
	pi.registerTool({
		name: "swarm_cancel",
		label: "Swarm Cancel",
		description: "Cancel running/queued sub-agent tasks. Target by task ids, a job (group) id, or all=true.",
		promptSnippet: "Stop running swarm tasks or jobs",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Task ids to cancel." })),
			group: Type.Optional(Type.String({ description: "Cancel all tasks belonging to this job." })),
			all: Type.Optional(Type.Boolean({ description: "Cancel every active task." })),
		}),
		async execute(_id, params) {
			let n = 0;
			if (params.all) {
				n = rt.runner.cancelAll();
			} else if (params.group) {
				const g = rt.groups.get(params.group);
				for (const id of g?.taskIds ?? []) if (rt.runner.cancel(id)) n++;
			} else if (params.ids) {
				for (const id of params.ids) if (rt.runner.cancel(id)) n++;
			} else {
				throw new Error("swarm_cancel needs `ids`, `group`, or all=true.");
			}
			return { content: [{ type: "text", text: `Cancelled ${n} task(s).` }], details: {} };
		},
	});

	// --- swarm_watch ---------------------------------------------------------
	pi.registerTool({
		name: "swarm_watch",
		label: "Swarm Watch",
		description: [
			"Ask to be re-activated later instead of blocking. Registers a wake-up that resumes your turn (with a status summary) when the watched work finishes, or after a timer.",
			"Target by task `ids`, a `group` job id, `all` active work, and/or `checkInMs` for a timed check-back.",
			"After calling this you can END YOUR TURN (e.g. tell the user what you dispatched). You will be re-activated automatically - no need to sit blocked in swarm_await.",
		].join(" "),
		promptSnippet: "Be re-activated when background swarm work finishes or a timer elapses (non-blocking)",
		promptGuidelines: [
			"Use swarm_watch to run a non-blocking orchestration loop: spawn async, set a swarm_watch, end your turn; when work completes you are woken with results and can dispatch more, validate, or report.",
			"Prefer swarm_watch over swarm_await for anything long-running so the session is not stuck on 'Working...'. Use checkInMs to poll on a timer if you want periodic check-ins.",
		],
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Wake when all these tasks finish." })),
			group: Type.Optional(Type.String({ description: "Wake when this job (workflow/orchestration) finishes." })),
			all: Type.Optional(Type.Boolean({ description: "Wake when ALL active swarm work finishes." })),
			checkInMs: Type.Optional(Type.Number({ description: "Also wake after this many ms (a timed check-back), even if work is unfinished. Clamped to 1s..1h." })),
			mode: Type.Optional(StringEnum(["wake", "steer"] as const, { description: "wake = resume when idle (default); steer = interrupt the current turn." })),
			note: Type.Optional(Type.String({ description: "A short note to yourself about why you are waiting (echoed back on wake)." })),
		}),
		async execute(_id, params) {
			const watchId = rt.watch.add({
				ids: params.ids,
				group: params.group,
				all: params.all,
				checkInMs: params.checkInMs,
				mode: params.mode,
				note: params.note,
			});
			if (!watchId) {
				return {
					content: [
						{
							type: "text",
							text: "That work is already complete - no watch needed. Use swarm_status / swarm_result to review the results now.",
						},
					],
					details: { alreadyComplete: true },
				};
			}
			const parts: string[] = [];
			if (params.ids?.length) parts.push(`tasks ${params.ids.join(", ")}`);
			if (params.group) parts.push(`job ${params.group}`);
			if (params.all) parts.push("all active work");
			const cond = parts.join(" / ") || "the requested condition";
			const timer = params.checkInMs ? ` (or after ${params.checkInMs}ms)` : "";
			return {
				content: [
					{
						type: "text",
						text: `Watch ${watchId} set. You will be re-activated when ${cond} completes${timer}. End your turn now - you do not need to block.`,
					},
				],
				details: { watchId },
			};
		},
	});

	registerWorkflowTool(pi, rt);
	registerOrchestrateTool(pi, rt);
}

function renderDashboardFallback(text: { type: string; text?: string } | undefined): Text {
	return new Text(text?.type === "text" && text.text ? text.text : "(no output)", 0, 0);
}

const WorkflowStepSchema = Type.Object({
	id: Type.String({ description: "Unique step id, referenced by later steps via {steps.<id>}." }),
	kind: StringEnum(["task", "map", "reduce"] as const, { description: "task=one agent, map=fan out over items, reduce=merge prior outputs." }),
	prompt: Type.String({ description: "Prompt template. Vars: {goal} {previous} {steps.<id>} {inputs}; in map: {item} {index}." }),
	agent: Type.Optional(Type.String({ description: "Agent profile for this step." })),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	cwd: Type.Optional(Type.String()),
	items: Type.Optional(Type.Array(Type.String(), { description: "map: literal list of items to fan out over." })),
	itemsFromStep: Type.Optional(Type.String({ description: "map: split a prior step's output into items." })),
	itemsDelimiter: Type.Optional(Type.String({ description: "map: delimiter for itemsFromStep (default newline)." })),
	from: Type.Optional(Type.Array(Type.String(), { description: "reduce: step ids to gather into {inputs} (default: all prior)." })),
	concurrency: Type.Optional(Type.Number({ description: "map: max items of this step in flight at once." })),
	label: Type.Optional(Type.String()),
});

function registerWorkflowTool(pi: ExtensionAPI, rt: SwarmRuntime): void {
	pi.registerTool({
		name: "swarm_workflow",
		label: "Swarm Workflow",
		description: [
			"Run a declarative multi-stage workflow of sub-agents with a barrier between stages.",
			"Steps run in order; each may be a single task, a map (fan out over items), or a reduce (merge prior outputs).",
			"Runs in the background by default (returns a job id); set wait=true to block and return the final output.",
		].join(" "),
		promptSnippet: "Run a staged sub-agent workflow (map/reduce/chain) as a background job",
		parameters: Type.Object({
			spec: Type.Object(
				{ name: Type.Optional(Type.String()), steps: Type.Array(WorkflowStepSchema) },
				{ description: "The workflow specification." },
			),
			goal: Type.Optional(Type.String({ description: "Top-level goal, available to every step as {goal}." })),
			wait: Type.Optional(Type.Boolean({ description: "Block until the workflow finishes (default false)." })),
			notify: Type.Optional(Type.Boolean({ description: "When async, auto-register a watch so you are re-activated when the workflow finishes." })),
		}),
		async execute(_id, params, signal) {
			const spec = params.spec as WorkflowSpec;
			const err = validateWorkflow(spec);
			if (err) throw new Error(`Invalid workflow: ${err}`);
			const group = startWorkflow(rt.coordinatorDeps(), spec, params.goal ?? spec.name ?? "workflow");
			if (!params.wait) {
				let note = `Poll with swarm_status group="${group.id}", block with swarm_await group="${group.id}", or swarm_watch group="${group.id}" to be re-activated when it finishes.`;
				if (params.notify) {
					try {
						rt.watch.add({ group: group.id });
						note = `A watch is set: end your turn and you will be re-activated when job ${group.id} finishes.`;
					} catch {
						// fall back to default note
					}
				}
				return {
					content: [{ type: "text", text: `Started workflow job ${group.id} (${spec.steps.length} steps) in the background. ${note}` }],
					details: { groupIds: [group.id] },
				};
			}
			const [done] = await rt.groups.waitFor([group.id], signal);
			const final = done ?? group;
			return {
				content: [{ type: "text", text: `Workflow ${final.id} [${final.status}].\n\n${capBytes(final.output || "(no output)", rt.config.perTaskOutputCap * 4)}` }],
				details: { groupIds: [final.id] },
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { groupIds?: string[] } | undefined;
			const groups = (details?.groupIds ?? []).map((id) => rt.groups.get(id)).filter((g): g is GroupRecord => Boolean(g));
			const taskIds = groups.flatMap((g) => g.taskIds);
			const tasks = taskIds.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			return renderDashboard(tasks, groups, theme, expanded);
		},
	});
}

function registerOrchestrateTool(pi: ExtensionAPI, rt: SwarmRuntime): void {
	pi.registerTool({
		name: "swarm_orchestrate",
		label: "Swarm Orchestrate",
		description: [
			"Autonomously tackle a large, complex goal: a planner sub-agent breaks it into chunks, worker sub-agents execute them in parallel (respecting dependencies), an optional reviewer validates each chunk against your criteria (retrying failures once), and a synthesizer merges the results.",
			"Runs as a background job by default (returns a job id); set wait=true to block until it completes.",
			"This is the tool for 'do this big thing end to end and check it'.",
		].join(" "),
		promptSnippet: "Auto-decompose a big goal into validated, parallel sub-agent work",
		promptGuidelines: [
			"Use swarm_orchestrate when the user asks for a large multi-part task that benefits from decomposition, parallelism, and validation rather than one long linear effort.",
			"Give swarm_orchestrate a concrete `goal` and, when quality matters, `criteria` so the reviewer can validate each chunk.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "The overall objective to accomplish." }),
			context: Type.Optional(Type.String({ description: "Background the planner should know (paths, constraints, prior findings)." })),
			criteria: Type.Optional(Type.String({ description: "Success criteria used to validate each chunk." })),
			maxChunks: Type.Optional(Type.Number({ description: "Maximum number of chunks (default 8)." })),
			concurrency: Type.Optional(Type.Number({ description: "Max chunks running at once (default from config)." })),
			plannerAgent: Type.Optional(Type.String({ description: "Agent profile for planning (default 'planner')." })),
			workerAgent: Type.Optional(Type.String({ description: "Agent profile for chunks (default 'worker')." })),
			validatorAgent: Type.Optional(Type.String({ description: "Agent profile for validation (default 'reviewer')." })),
			synthesizerAgent: Type.Optional(Type.String({ description: "Agent profile for synthesis (default 'synthesizer')." })),
			validate: Type.Optional(Type.Boolean({ description: "Validate each chunk (default true when criteria given)." })),
			synthesize: Type.Optional(Type.Boolean({ description: "Merge chunk outputs into a final deliverable (default true)." })),
			model: Type.Optional(Type.String({ description: "Model override for all sub-agents." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for worker sub-agents." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for sub-agents." })),
			wait: Type.Optional(Type.Boolean({ description: "Block until the job finishes (default false)." })),
			notify: Type.Optional(Type.Boolean({ description: "When async, auto-register a watch so you are re-activated when the job finishes." })),
		}),
		async execute(_id, params, signal) {
			const group = startOrchestration(rt.coordinatorDeps(), {
				goal: params.goal,
				context: params.context,
				criteria: params.criteria,
				maxChunks: params.maxChunks,
				concurrency: params.concurrency,
				plannerAgent: params.plannerAgent,
				workerAgent: params.workerAgent,
				validatorAgent: params.validatorAgent,
				synthesizerAgent: params.synthesizerAgent,
				validate: params.validate,
				synthesize: params.synthesize,
				model: params.model,
				tools: params.tools,
				cwd: params.cwd,
			});
			if (!params.wait) {
				let note = `Poll with swarm_status group="${group.id}", block with swarm_await group="${group.id}", or swarm_watch group="${group.id}" to be re-activated when it finishes.`;
				if (params.notify) {
					try {
						rt.watch.add({ group: group.id });
						note = `A watch is set: end your turn and you will be re-activated when job ${group.id} finishes.`;
					} catch {
						// fall back to default note
					}
				}
				return {
					content: [{ type: "text", text: `Started orchestration job ${group.id} in the background. It will plan, delegate, validate, and synthesize. ${note}` }],
					details: { groupIds: [group.id] },
				};
			}
			const [done] = await rt.groups.waitFor([group.id], signal);
			const final = done ?? group;
			return {
				content: [{ type: "text", text: `Orchestration ${final.id} [${final.status}].\n\n${capBytes(final.output || "(no output)", rt.config.perTaskOutputCap * 4)}` }],
				details: { groupIds: [final.id] },
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { groupIds?: string[] } | undefined;
			const groups = (details?.groupIds ?? []).map((id) => rt.groups.get(id)).filter((g): g is GroupRecord => Boolean(g));
			const taskIds = groups.flatMap((g) => g.taskIds);
			const tasks = taskIds.map((id) => rt.runner.get(id)).filter((t): t is TaskRecord => Boolean(t));
			return renderDashboard(tasks, groups, theme, expanded);
		},
	});
}

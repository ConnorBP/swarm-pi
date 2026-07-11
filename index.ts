/**
 * swarm - a sub-agent orchestration toolkit for the pi harness.
 *
 * Adds tools and commands for delegating work to swarms of isolated sub-agents,
 * running declarative multi-stage workflows, and auto-decomposing large goals
 * into validated, parallel, asynchronously-executed chunks.
 *
 * Tools:   swarm_spawn, swarm_status, swarm_await, swarm_result, swarm_cancel,
 *          swarm_watch, swarm_rechunk, swarm_workflow, swarm_orchestrate, swarm_schedule
 * Commands: /swarm, /swarm-config, /swarm-cron, /swarm-stats, /swarm-cancel,
 *           /swarm-agents, /swarm-clear
 *
 * Also: complexity-based duration learning, expected-time re-checks, recurring
 * schedules, and overrun-driven re-chunking. See README.md for usage.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentDiscovery, type AgentProfile, type AgentScope, discoverAgents } from "./agents.ts";
import { registerCommands } from "./commands.ts";
import { ComplexityModel } from "./complexity.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { EscalationMonitor } from "./escalation.ts";
import { GroupRegistry } from "./groups.ts";
import { rechunkTask, startOrchestration } from "./orchestrate.ts";
import { buildSwarmPrimer } from "./primer.ts";
import { renderTaskResult, widgetLines, type ThemeLike } from "./render.ts";
import { SwarmRunner } from "./runner.ts";
import type { SwarmRuntime } from "./runtime.ts";
import { Scheduler } from "./schedule.ts";
import { SwarmStore } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { ScheduleAction, ScheduleRecord, SwarmConfig, TaskRecord } from "./types.ts";
import { WatchManager, type WakeMode } from "./watch.ts";
import type { CoordinatorDeps } from "./workflow.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

export default function swarm_extension(pi: ExtensionAPI) {
	// Mutable internals, rebuilt on every session_start. Tools/commands capture
	// the stable `rt` object and read these through getters, so a rebind here is
	// transparent to already-registered tools.
	let config: SwarmConfig = { ...DEFAULT_CONFIG };
	let store = new SwarmStore("ephemeral");
	let runner: SwarmRunner;
	let groups: GroupRegistry;
	let cwd = process.cwd();
	let uiApi: ExtensionContext["ui"] | undefined;
	let hasUI = false;
	const discoveryCache = new Map<AgentScope, AgentDiscovery>();
	let widgetTimer: ReturnType<typeof setTimeout> | undefined;
	// Sub-agent spend not yet folded into pi's session cost counter. Applied to
	// the next assistant message's usage.cost.total (money only; token/context
	// counters are left untouched so context accounting stays accurate).
	let pendingSubagentCost = 0;
	let watchManager: WatchManager | undefined;
	let escalationMonitor: EscalationMonitor | undefined;
	// Global (cross-session) learning of complexity -> actual duration.
	const complexityModel = new ComplexityModel();

	const getDiscovery = (scope: AgentScope): AgentDiscovery => {
		let cached = discoveryCache.get(scope);
		if (!cached) {
			cached = discoverAgents({ extensionDir: EXTENSION_DIR, cwd, scope, extraDirs: config.agentDirs });
			discoveryCache.set(scope, cached);
		}
		return cached;
	};

	const resolveProfile = (name: string, scope: AgentScope): AgentProfile | undefined => {
		return getDiscovery(scope).profiles.find((p) => p.name === name);
	};

	const doRefreshUI = () => {
		widgetTimer = undefined;
		if (!uiApi || !hasUI || !config.widget || !runner) return;
		try {
			const theme = uiApi.theme as unknown as ThemeLike;
			const lines = widgetLines(runner.list(), groups.list(), theme);
			uiApi.setWidget("swarm", lines.length > 0 ? lines : undefined);
		} catch {
			// UI not available in this mode; ignore.
		}
	};

	// Debounce widget refreshes: streaming produces many rapid change events.
	const refreshUI = () => {
		if (widgetTimer) return;
		widgetTimer = setTimeout(doRefreshUI, 120);
	};

	// Every task/job state change refreshes the widget (debounced) and evaluates
	// watches immediately so completions re-activate the agent promptly.
	const handleChange = () => {
		refreshUI();
		watchManager?.check();
	};

	// Re-activate (or steer) the main agent with a wake message. Uses triggerTurn
	// so an idle agent resumes; a busy agent gets it as a follow-up / steer.
	const wake = (summary: string, mode: WakeMode, details: Record<string, unknown>) => {
		try {
			pi.sendMessage(
				{ customType: "swarm-wake", content: summary, display: true, details },
				{ deliverAs: mode === "steer" ? "steer" : "followUp", triggerTurn: true },
			);
		} catch {
			// ignore (e.g. mode without UI)
		}
	};

	const onTaskComplete = (record: TaskRecord) => {
		if (config.countSubagentCost && record.usage.cost > 0) {
			pendingSubagentCost += record.usage.cost;
		}
		// Learn how long this complexity actually took (successful runs only).
		if (record.status === "succeeded" && record.complexity !== undefined && record.startedAt && record.endedAt) {
			complexityModel.record(record.complexity, record.endedAt - record.startedAt);
		}
		if (!config.notifyOnComplete) return;
		if (runner.activeCount() > 0 || groups.activeCount() > 0) return;
		try {
			pi.sendMessage(
				{ customType: "swarm-note", content: "[swarm] all background sub-agent work has finished. Use swarm_status to review.", display: true },
				{ deliverAs: "followUp" },
			);
		} catch {
			// ignore
		}
	};

	const coordinatorDeps = (): CoordinatorDeps => ({ runner, groups, config, cwd });

	// Executes a fired schedule against the current session's runtime.
	const scheduleExecute = (action: ScheduleAction, record: ScheduleRecord) => {
		try {
			if (action.type === "spawn") {
				runner.enqueue({
					task: action.task,
					agent: action.agent,
					model: action.model,
					tools: action.tools,
					cwd: action.cwd ?? cwd,
					complexity: action.complexity,
					label: `cron:${record.name}`,
				});
			} else if (action.type === "orchestrate") {
				startOrchestration(coordinatorDeps(), {
					goal: action.goal,
					criteria: action.criteria,
					maxChunks: action.maxChunks,
					complexity: action.complexity,
					cwd: action.cwd ?? cwd,
				});
			} else if (action.type === "prompt") {
				pi.sendMessage(
					{ customType: "swarm-wake", content: `[swarm schedule "${record.name}"] ${action.text}`, display: true },
					{ deliverAs: action.mode === "steer" ? "steer" : "followUp", triggerTurn: true },
				);
			}
		} catch (err) {
			console.error("swarm: schedule execute failed:", (err as Error).message);
		}
	};

	// Session-scoped scheduler (constructed in rebuild() with the session key).
	let scheduler: Scheduler;

	// When a task overruns its complexity estimate: notify the model, or (auto) stop
	// it and re-chunk the remaining work across a fresh swarm.
	const onEscalate = (task: TaskRecord) => {
		const liveEst = task.complexity !== undefined ? complexityModel.estimateMs(task.complexity) : task.estimatedMs;
		const estS = liveEst ? Math.round(liveEst / 1000) : undefined;
		const elapsedS = task.startedAt ? Math.round((Date.now() - task.startedAt) / 1000) : undefined;
		const over = `~${estS ?? "?"}s estimated, ${elapsedS ?? "?"}s elapsed`;
		if (config.escalation === "auto") {
			try {
				const group = rechunkTask(coordinatorDeps(), task, {});
				wake(
					`[swarm] Task ${task.id} ("${task.label}") overran its estimate (${over}, >${config.escalationFactor}x). It was stopped and its remaining work re-chunked into job ${group.id}. Track it with swarm_status group="${group.id}".`,
					"wake",
					{ taskId: task.id, groupId: group.id },
				);
			} catch (err) {
				console.error("swarm: auto re-chunk failed:", (err as Error).message);
			}
		} else {
			wake(
				`[swarm] Task ${task.id} ("${task.label}") is running long (${over}, over ${config.escalationFactor}x its estimate). It may be too complex for one agent. Options: swarm_rechunk({ id: "${task.id}" }) to stop it and split the remaining work across a fresh swarm; swarm_result to inspect progress; or leave it running.`,
				"wake",
				{ taskId: task.id },
			);
		}
	};

	const rt: SwarmRuntime = {
		get runner() {
			return runner;
		},
		get groups() {
			return groups;
		},
		get store() {
			return store;
		},
		get watch() {
			if (!watchManager) throw new Error("swarm watch manager not initialized");
			return watchManager;
		},
		get complexity() {
			return complexityModel;
		},
		get scheduler() {
			return scheduler;
		},
		get config() {
			return config;
		},
		get cwd() {
			return cwd;
		},
		extensionDir: EXTENSION_DIR,
		getDiscovery,
		coordinatorDeps,
		refreshUI,
	};

	// Build an initial (ephemeral) runtime so pre-session access is safe.
	const rebuild = (ctx?: ExtensionContext) => {
		if (ctx) {
			pendingSubagentCost = 0;
			cwd = ctx.cwd;
			let trusted = false;
			try {
				trusted = ctx.isProjectTrusted();
			} catch {
				trusted = false;
			}
			config = loadConfig({ extensionDir: EXTENSION_DIR, cwd, projectTrusted: trusted });
			uiApi = ctx.ui;
			hasUI = ctx.hasUI;
		}
		discoveryCache.clear();
		watchManager?.clearAll();
		escalationMonitor?.stop();
		scheduler?.stop();
		const sessionKey = deriveSessionKey(ctx);
		store = new SwarmStore(sessionKey);
		scheduler = new Scheduler({ sessionKey, execute: scheduleExecute, onChange: refreshUI, now: () => Date.now() });
		if (ctx) {
			try {
				store.purgeOldSessions({
					retentionDays: config.retentionDays,
					maxSessions: config.maxSessions,
				});
			} catch {
				// best effort: never block session rebuild on cleanup
			}
		}
		groups = new GroupRegistry(store, handleChange);
		runner = new SwarmRunner({
			config,
			store,
			cwd,
			resolveProfile,
			onChange: handleChange,
			onTaskComplete,
			estimateMs: (c) => complexityModel.estimateMs(c),
		});
		watchManager = new WatchManager({ runner, groups, wake, maxWatches: 8 });
		escalationMonitor = new EscalationMonitor({
			runner,
			config,
			isConfident: (c, m) => complexityModel.isConfident(c, m),
			estimateMs: (c) => complexityModel.estimateMs(c),
			onEscalate,
			now: () => Date.now(),
		});
		// Recover prior task/job snapshots for this session (read-only history).
		try {
			runner.adopt(store.loadTasks());
			groups.adopt(store.loadGroups());
		} catch {
			// ignore corrupt store
		}
	};

	rebuild();

	registerTools(pi, rt);
	registerCommands(pi, rt);

	// Inject the swarm primer into the system prompt each turn when enabled.
	// Returns { systemPrompt } to replace this turn's prompt (chained across
	// extensions); returns undefined (no-op) when the primer is off or empty, or
	// on any error so a primer failure never breaks the agent loop.
	pi.on("before_agent_start", async (event, _ctx) => {
		try {
			if (!config.swarmPrimer) return;
			const primer = buildSwarmPrimer(config);
			if (!primer) return;
			return {
				systemPrompt: (event.systemPrompt ?? "") + "\n\n" + primer,
			};
		} catch (err) {
			console.error("swarm: before_agent_start primer failed:", (err as Error).message);
			return;
		}
	});

	// Fold sub-agent spend into pi's session cost counter by augmenting the next
	// assistant message's usage.cost.total. Only the money is adjusted; token and
	// context counters are intentionally left alone.
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		if (!config.countSubagentCost || pendingSubagentCost <= 0) return;
		const usage = event.message.usage;
		if (!usage || !usage.cost) return; // need an existing cost object to augment
		const add = pendingSubagentCost;
		pendingSubagentCost = 0;
		return {
			message: {
				...event.message,
				usage: {
					...usage,
					cost: {
						...usage.cost,
						total: (usage.cost.total ?? 0) + add,
					},
				},
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			rebuild(ctx);
			refreshUI();
			escalationMonitor?.start();
			scheduler.start();
		} catch (err) {
			console.error("swarm: session_start failed:", (err as Error).message);
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		try {
			if (widgetTimer) {
				clearTimeout(widgetTimer);
				widgetTimer = undefined;
			}
			watchManager?.clearAll();
			escalationMonitor?.stop();
			scheduler?.stop();
			runner?.shutdown();
			uiApi?.setWidget("swarm", undefined);
		} catch {
			// ignore
		}
	});
}

function deriveSessionKey(ctx?: ExtensionContext): string {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		if (file) return path.basename(file).replace(/\.[^.]+$/, "");
	} catch {
		// ignore
	}
	return "ephemeral";
}

// Re-export for potential SDK / test consumers.
export { renderTaskResult };

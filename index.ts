/**
 * swarm - a sub-agent orchestration toolkit for the pi harness.
 *
 * Adds tools and commands for delegating work to swarms of isolated sub-agents,
 * running declarative multi-stage workflows, and auto-decomposing large goals
 * into validated, parallel, asynchronously-executed chunks.
 *
 * Tools:   swarm_spawn, swarm_status, swarm_await, swarm_result, swarm_cancel,
 *          swarm_watch, swarm_workflow, swarm_orchestrate
 * Commands: /swarm, /swarm-config, /swarm-cancel, /swarm-agents, /swarm-clear
 *
 * See README.md for usage.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentDiscovery, type AgentProfile, type AgentScope, discoverAgents } from "./agents.ts";
import { registerCommands } from "./commands.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { GroupRegistry } from "./groups.ts";
import { renderTaskResult, widgetLines, type ThemeLike } from "./render.ts";
import { SwarmRunner } from "./runner.ts";
import type { SwarmRuntime } from "./runtime.ts";
import { SwarmStore } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { SwarmConfig, TaskRecord } from "./types.ts";
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
		const sessionKey = deriveSessionKey(ctx);
		store = new SwarmStore(sessionKey);
		groups = new GroupRegistry(store, handleChange);
		runner = new SwarmRunner({ config, store, cwd, resolveProfile, onChange: handleChange, onTaskComplete });
		watchManager = new WatchManager({ runner, groups, wake, maxWatches: 8 });
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

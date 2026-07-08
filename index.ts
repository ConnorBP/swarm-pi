/**
 * swarm - a sub-agent orchestration toolkit for the pi harness.
 *
 * Adds tools and commands for delegating work to swarms of isolated sub-agents,
 * running declarative multi-stage workflows, and auto-decomposing large goals
 * into validated, parallel, asynchronously-executed chunks.
 *
 * Tools:   swarm_spawn, swarm_status, swarm_await, swarm_result, swarm_cancel,
 *          swarm_workflow, swarm_orchestrate
 * Commands: /swarm, /swarm-cancel, /swarm-agents, /swarm-clear
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

	const onTaskComplete = (_record: TaskRecord) => {
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
		const sessionKey = deriveSessionKey(ctx);
		store = new SwarmStore(sessionKey);
		groups = new GroupRegistry(store, refreshUI);
		runner = new SwarmRunner({ config, store, cwd, resolveProfile, onChange: refreshUI, onTaskComplete });
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

	// Custom renderer for the injected completion note handled in commands.ts.

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

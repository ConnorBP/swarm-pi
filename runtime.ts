/**
 * Shared runtime wiring passed to tool and command registrations.
 */

import type { AgentDiscovery, AgentScope } from "./agents.ts";
import type { ComplexityModel } from "./complexity.ts";
import type { GroupRegistry } from "./groups.ts";
import type { SwarmRunner } from "./runner.ts";
import type { Scheduler } from "./schedule.ts";
import type { SwarmStore } from "./store.ts";
import type { SwarmConfig } from "./types.ts";
import type { WatchManager } from "./watch.ts";
import type { CoordinatorDeps } from "./workflow.ts";

export interface SwarmRuntime {
	runner: SwarmRunner;
	groups: GroupRegistry;
	store: SwarmStore;
	watch: WatchManager;
	complexity: ComplexityModel;
	scheduler: Scheduler;
	config: SwarmConfig;
	cwd: string;
	extensionDir: string;
	getDiscovery: (scope: AgentScope) => AgentDiscovery;
	coordinatorDeps: () => CoordinatorDeps;
	refreshUI: () => void;
}

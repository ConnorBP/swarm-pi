/**
 * EscalationMonitor - watches running sub-agent tasks and flags ones that have
 * overrun the duration estimated from their complexity score, so they can be
 * stopped and their remaining work re-chunked across a fresh swarm.
 *
 * A task escalates when it is still running and its elapsed time exceeds
 * `escalationFactor` x its estimated duration, provided the estimate is backed by
 * at least `escalationMinSamples` observations (so we don't act on shaky priors).
 */

import type { SwarmRunner } from "./runner.ts";
import type { SwarmConfig, TaskRecord } from "./types.ts";

export interface EscalationDeps {
	runner: SwarmRunner;
	config: SwarmConfig;
	isConfident: (complexity: number | undefined, minSamples: number) => boolean;
	/** Current learned estimate for a complexity (evaluated live, not frozen at spawn). */
	estimateMs: (complexity: number) => number;
	onEscalate: (task: TaskRecord) => void;
	now: () => number;
}

export class EscalationMonitor {
	private readonly deps: EscalationDeps;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(deps: EscalationDeps) {
		this.deps = deps;
	}

	start(intervalMs = 30_000): void {
		this.stop();
		this.timer = setInterval(() => this.tick(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Public so callers can also trigger a check on demand. */
	tick(): void {
		if (this.deps.config.escalation === "off") return;
		const now = this.deps.now();

		for (const task of this.deps.runner.list()) {
			if (task.status !== "running") continue;
			if (task.escalated) continue;
			// Only standalone tasks escalate. Coordinator-owned workers are validated
			// and retried by their orchestration, and cancelling one mid-flight would
			// conflict with the coordinator that is awaiting it.
			if (task.groupId) continue;
			if (task.complexity === undefined || !task.startedAt) continue;
			// Do not act on estimates that are not yet backed by real data.
			if (!this.deps.isConfident(task.complexity, this.deps.config.escalationMinSamples)) continue;

			// Use the CURRENT learned estimate, not the frozen spawn-time snapshot, so
			// the threshold and the confidence gate are derived from the same data.
			const estimate = this.deps.estimateMs(task.complexity);
			if (!(estimate > 0)) continue;

			const elapsed = now - task.startedAt;
			if (elapsed > estimate * this.deps.config.escalationFactor) {
				task.escalated = true;
				try {
					this.deps.onEscalate(task);
				} catch {
					// escalation handling must not break the monitor
				}
			}
		}
	}
}

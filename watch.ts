/**
 * WatchManager - re-activates the main agent when background swarm work reaches
 * a checkpoint, so the model can spawn work, end its turn, and be woken later
 * instead of blocking in swarm_await.
 *
 * A watch fires when its completion condition is met (specific tasks done, a job
 * done, or all active work done) OR when its optional timer elapses ("check back
 * in N ms"). Firing injects a wake message via the host `wake` callback, which
 * uses pi.sendMessage({ triggerTurn: true }) to resume an idle agent (or steer a
 * busy one).
 */

import type { GroupRegistry } from "./groups.ts";
import type { SwarmRunner } from "./runner.ts";

export type WakeMode = "wake" | "steer";

export interface WatchSpec {
	ids?: string[];
	group?: string;
	all?: boolean;
	checkInMs?: number;
	mode?: WakeMode;
	note?: string;
}

interface Watch {
	id: string;
	ids?: string[];
	group?: string;
	all?: boolean;
	checkInMs?: number;
	mode: WakeMode;
	note?: string;
	timer?: ReturnType<typeof setTimeout>;
	timedOut: boolean;
	fired: boolean;
	createdAt: number;
}

export interface WatchDeps {
	runner: SwarmRunner;
	groups: GroupRegistry;
	wake: (summary: string, mode: WakeMode, details: Record<string, unknown>) => void;
	maxWatches: number;
}

const MIN_CHECK_MS = 1000;
const MAX_CHECK_MS = 60 * 60 * 1000;

export class WatchManager {
	private readonly deps: WatchDeps;
	private readonly watches: Watch[] = [];
	private counter = 0;

	constructor(deps: WatchDeps) {
		this.deps = deps;
	}

	count(): number {
		return this.watches.length;
	}

	list(): Array<{ id: string; note?: string; mode: WakeMode }> {
		return this.watches.map((w) => ({ id: w.id, note: w.note, mode: w.mode }));
	}

	/** True if the spec's completion condition (ignoring any timer) is already met. */
	conditionAlreadyMet(spec: WatchSpec): boolean {
		if (spec.all) return this.deps.runner.activeCount() === 0 && this.deps.groups.activeCount() === 0;
		if (spec.group) {
			const group = this.deps.groups.get(spec.group);
			return !group || group.status !== "running";
		}
		if (spec.ids && spec.ids.length > 0) {
			return spec.ids.every((id) => {
				const task = this.deps.runner.get(id);
				return !task || (task.status !== "running" && task.status !== "queued");
			});
		}
		return false; // pure timer watch, or nothing to wait on
	}

	/**
	 * Register a watch. Returns the watch id, `null` if the completion condition
	 * is already satisfied (so no watch is created - avoids tight wake loops on
	 * already-finished work), or throws on an empty/invalid spec.
	 */
	add(spec: WatchSpec): string | null {
		const hasCondition = Boolean((spec.ids && spec.ids.length > 0) || spec.group || spec.all || spec.checkInMs);
		if (!hasCondition) {
			throw new Error("swarm_watch needs at least one of: ids, group, all, or checkInMs.");
		}
		// A completion watch on already-finished work would fire instantly; if the
		// model then re-watched it, that is a no-progress loop. Report done instead.
		const hasCompletionCondition = Boolean((spec.ids && spec.ids.length > 0) || spec.group || spec.all);
		if (hasCompletionCondition && this.conditionAlreadyMet(spec)) {
			return null;
		}
		if (this.watches.length >= this.deps.maxWatches) {
			throw new Error(`Too many active watches (max ${this.deps.maxWatches}). Let some fire first.`);
		}

		this.counter += 1;
		const id = `w${this.counter}`;
		const watch: Watch = {
			id,
			ids: spec.ids,
			group: spec.group,
			all: spec.all,
			checkInMs: spec.checkInMs,
			mode: spec.mode === "steer" ? "steer" : "wake",
			note: spec.note,
			timedOut: false,
			fired: false,
			createdAt: Date.now(),
		};

		if (spec.checkInMs && spec.checkInMs > 0) {
			const delay = Math.max(MIN_CHECK_MS, Math.min(MAX_CHECK_MS, spec.checkInMs));
			watch.timer = setTimeout(() => {
				watch.timedOut = true;
				this.check();
			}, delay);
			watch.timer.unref?.();
		}

		this.watches.push(watch);
		// A watch on already-finished work should fire promptly.
		this.check();
		return id;
	}

	/** Cancel a watch by id. Returns true if it existed. */
	cancel(id: string): boolean {
		const idx = this.watches.findIndex((w) => w.id === id);
		if (idx < 0) return false;
		const [watch] = this.watches.splice(idx, 1);
		if (watch.timer) clearTimeout(watch.timer);
		return true;
	}

	/** Evaluate all watches; fire (coalesced) any whose condition is met. */
	check(): void {
		const ready = this.watches.filter((w) => !w.fired && this.isReady(w));
		if (ready.length === 0) return;

		for (const w of ready) {
			w.fired = true;
			if (w.timer) clearTimeout(w.timer);
		}
		// Remove fired watches from the active list.
		for (const w of ready) {
			const idx = this.watches.indexOf(w);
			if (idx >= 0) this.watches.splice(idx, 1);
		}

		const mode: WakeMode = ready.some((w) => w.mode === "steer") ? "steer" : "wake";
		const summary = this.buildSummary(ready);
		this.deps.wake(summary, mode, {
			watchIds: ready.map((w) => w.id),
			taskIds: ready.flatMap((w) => w.ids ?? []),
			groupIds: ready.map((w) => w.group).filter((g): g is string => Boolean(g)),
		});
	}

	private isReady(watch: Watch): boolean {
		if (watch.timedOut) return true;
		if (watch.all) {
			return this.deps.runner.activeCount() === 0 && this.deps.groups.activeCount() === 0;
		}
		if (watch.group) {
			const group = this.deps.groups.get(watch.group);
			return !group || group.status !== "running";
		}
		if (watch.ids && watch.ids.length > 0) {
			return watch.ids.every((id) => {
				const task = this.deps.runner.get(id);
				return !task || (task.status !== "running" && task.status !== "queued");
			});
		}
		// Pure timer watch (no completion condition): only the timer fires it.
		return false;
	}

	private buildSummary(ready: Watch[]): string {
		const lines: string[] = ["[swarm] Re-activated: watched background work reached a checkpoint."];

		for (const w of ready) {
			if (w.note) lines.push(`- (${w.id}) ${w.note}`);
			if (w.group) {
				const g = this.deps.groups.get(w.group);
				lines.push(`- job ${w.group}: ${g ? g.status : "gone"}${g?.note ? ` (${g.note})` : ""}`);
			}
			if (w.ids && w.ids.length > 0) {
				const done = w.ids.filter((id) => {
					const t = this.deps.runner.get(id);
					return t && (t.status === "succeeded" || t.status === "failed" || t.status === "cancelled");
				}).length;
				lines.push(`- tasks ${w.ids.join(", ")}: ${done}/${w.ids.length} finished`);
			}
			if (w.all) lines.push("- all active swarm work has finished");
			if (w.timedOut && !w.group && !w.all && !(w.ids && w.ids.length)) {
				lines.push(`- timer elapsed (${w.checkInMs}ms) - time to check back`);
			}
		}

		const running = this.deps.runner.activeCount();
		const jobs = this.deps.groups.activeCount();
		lines.push("");
		lines.push(`Still active: ${running} task(s), ${jobs} job(s).`);
		lines.push(
			"Inspect with swarm_status / swarm_result, then continue orchestrating. If work is still running and you want to keep waiting without blocking, set another swarm_watch and end your turn.",
		);
		return lines.join("\n");
	}

	clearAll(): void {
		for (const w of this.watches) {
			if (w.timer) clearTimeout(w.timer);
		}
		this.watches.length = 0;
	}
}

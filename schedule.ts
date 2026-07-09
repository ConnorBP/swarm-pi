/**
 * Scheduler - recurring "cron-like" swarm tasks.
 *
 * Schedules are persisted globally (~/.pi/agent/swarm/schedules.json) so they
 * survive restarts, and armed with in-process timers while pi is running. Each
 * schedule fires a ScheduleAction (spawn work, orchestrate, or prompt the main
 * agent) on its interval.
 *
 * Honest limitation: timers only fire while a pi process is alive. There is no
 * background daemon, so "every 6h" only fires if pi runs that long. A schedule
 * due while pi was off fires shortly after the next startup only when catchUp is
 * set. A best-effort disk guard avoids double-firing across concurrent pi
 * instances.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { swarmStateRoot } from "./config.ts";
import type { ScheduleAction, ScheduleRecord } from "./types.ts";

const MIN_INTERVAL_MS = 10_000; // guard against runaway fast schedules
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year sanity cap
// Node clamps setTimeout delays above ~2^31-1 ms to 1ms; stay safely under it and
// re-arm in hops for anything longer, so long schedules do not fire early / spin.
const TIMER_MAX_MS = 2_147_483_000;
const CATCHUP_DELAY_MS = 5_000;

export interface ScheduleInput {
	name: string;
	everyMs: number;
	action: ScheduleAction;
	createdBy: "user" | "model";
	enabled?: boolean;
	catchUp?: boolean;
}

export interface SchedulerDeps {
	execute: (action: ScheduleAction, record: ScheduleRecord) => void;
	onChange?: () => void;
	now: () => number;
}

export class Scheduler {
	private readonly file: string;
	private readonly deps: SchedulerDeps;
	private records: Map<string, ScheduleRecord> = new Map();
	private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private counter = 0;
	private armed = false;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
		this.file = path.join(swarmStateRoot(), "schedules.json");
		this.load();
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.file)) return;
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { schedules?: ScheduleRecord[] };
			for (const rec of parsed.schedules ?? []) {
				if (rec && typeof rec.id === "string" && rec.action && Number.isFinite(rec.everyMs) && rec.everyMs > 0) {
					rec.everyMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(rec.everyMs)));
					this.records.set(rec.id, rec);
					const n = Number(rec.id.replace(/^s/, ""));
					if (Number.isFinite(n)) this.counter = Math.max(this.counter, n);
				}
			}
		} catch {
			// start fresh on corrupt data
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(swarmStateRoot(), { recursive: true });
			// Preserve any newer fire markers another pi instance wrote, so this
			// whole-file write does not revert another instance's de-dup progress.
			const disk = this.readDiskAll();
			for (const record of this.records.values()) {
				const d = disk.get(record.id);
				if (d && (d.lastRunAt ?? 0) > (record.lastRunAt ?? 0)) {
					record.lastRunAt = d.lastRunAt;
					record.runCount = Math.max(record.runCount, d.runCount ?? 0);
					record.nextRunAt = d.nextRunAt;
				}
			}
			const out = { version: 1, schedules: Array.from(this.records.values()) };
			const tmp = `${this.file}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
			fs.renameSync(tmp, this.file);
		} catch {
			// best effort
		}
	}

	private readDiskAll(): Map<string, ScheduleRecord> {
		const map = new Map<string, ScheduleRecord>();
		try {
			if (!fs.existsSync(this.file)) return map;
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { schedules?: ScheduleRecord[] };
			for (const r of parsed.schedules ?? []) if (r && typeof r.id === "string") map.set(r.id, r);
		} catch {
			// ignore
		}
		return map;
	}

	list(): ScheduleRecord[] {
		return Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): ScheduleRecord | undefined {
		return this.records.get(id);
	}

	add(input: ScheduleInput): ScheduleRecord {
		const everyMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(input.everyMs)));
		this.counter += 1;
		const id = `s${this.counter}`;
		const now = this.deps.now();
		const record: ScheduleRecord = {
			id,
			name: input.name,
			everyMs,
			action: input.action,
			enabled: input.enabled !== false,
			createdBy: input.createdBy,
			createdAt: now,
			nextRunAt: now + everyMs,
			runCount: 0,
			catchUp: input.catchUp,
		};
		this.records.set(id, record);
		this.save();
		if (this.armed && record.enabled) this.arm(record);
		this.deps.onChange?.();
		return record;
	}

	remove(id: string): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		this.disarm(id);
		this.records.delete(id);
		this.save();
		this.deps.onChange?.();
		return true;
	}

	setEnabled(id: string, enabled: boolean): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		record.enabled = enabled;
		if (enabled) {
			record.nextRunAt = this.deps.now() + record.everyMs;
			if (this.armed) this.arm(record);
		} else {
			this.disarm(id);
		}
		this.save();
		this.deps.onChange?.();
		return true;
	}

	/** Fire a schedule immediately (does not disturb its normal cadence much). */
	runNow(id: string): boolean {
		const record = this.records.get(id);
		if (!record) return false;
		this.fire(record, true);
		return true;
	}

	/** Arm all enabled schedules. Call once per session after the executor is ready. */
	start(): void {
		this.armed = true;
		const now = this.deps.now();
		for (const record of this.records.values()) {
			if (!record.enabled) continue;
			const dueAt = record.lastRunAt !== undefined ? record.lastRunAt + record.everyMs : (record.nextRunAt ?? now + record.everyMs);
			if (dueAt <= now) {
				// Overdue (missed while pi was off).
				if (record.catchUp) {
					this.arm(record, CATCHUP_DELAY_MS);
				} else {
					record.nextRunAt = now + record.everyMs;
					this.save();
					this.arm(record);
				}
			} else {
				record.nextRunAt = dueAt;
				this.arm(record);
			}
		}
	}

	private arm(record: ScheduleRecord, overrideDelayMs?: number): void {
		this.disarm(record.id);
		const now = this.deps.now();
		const target = overrideDelayMs !== undefined ? now + overrideDelayMs : (record.nextRunAt ?? now + record.everyMs);
		const remaining = Math.max(MIN_INTERVAL_MS, target - now);

		if (remaining > TIMER_MAX_MS) {
			// Too far out for a single setTimeout (would overflow to ~1ms). Hop, then
			// re-evaluate against the wall clock so it neither fires early nor spins.
			const timer = setTimeout(() => this.arm(record), TIMER_MAX_MS);
			timer.unref?.();
			this.timers.set(record.id, timer);
			return;
		}

		const timer = setTimeout(() => this.fire(record, false), remaining);
		timer.unref?.();
		this.timers.set(record.id, timer);
	}

	private disarm(id: string): void {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}

	private fire(record: ScheduleRecord, manual: boolean): void {
		const live = this.records.get(record.id);
		if (!live) return;

		if (!manual) {
			// Cross-instance de-dup: skip if another pi instance fired this recently.
			const disk = this.readDiskRecord(record.id);
			const now = this.deps.now();
			if (disk?.lastRunAt !== undefined && now - disk.lastRunAt < live.everyMs / 2) {
				live.lastRunAt = disk.lastRunAt;
				live.nextRunAt = disk.lastRunAt + live.everyMs;
				this.save();
				if (live.enabled) this.arm(live);
				return;
			}
		}

		live.lastRunAt = this.deps.now();
		live.runCount += 1;
		live.nextRunAt = live.lastRunAt + live.everyMs;
		this.save();

		try {
			this.deps.execute(live.action, live);
		} catch {
			// executor errors must not break the scheduler
		}

		if (!manual && live.enabled) this.arm(live);
		this.deps.onChange?.();
	}

	private readDiskRecord(id: string): ScheduleRecord | undefined {
		return this.readDiskAll().get(id);
	}

	stop(): void {
		this.armed = false;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}

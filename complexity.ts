/**
 * ComplexityModel - learns how long tasks of a given estimated complexity (0-10)
 * actually take, so callback / re-check timers can be sized from real data.
 *
 * When a task is spawned with a complexity score, that score is remembered; when
 * it finishes we record (complexity -> actual duration). The running per-bucket
 * mean then drives estimateMs(), which sizes swarm_await/swarm_watch timers and
 * the overrun threshold used for escalation.
 *
 * Persisted globally under ~/.pi/agent/swarm/complexity.json so learning
 * accumulates across sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { swarmStateRoot } from "./config.ts";
import type { ComplexityBucket } from "./types.ts";

const BUCKETS = 11; // 0..10
// Prior used before any data exists: base + perPoint * complexity.
const PRIOR_BASE_MS = 15_000;
const PRIOR_PER_POINT_MS = 15_000;

export function clampComplexity(value: number | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(10, Math.round(value)));
}

function priorMs(complexity: number): number {
	return PRIOR_BASE_MS + PRIOR_PER_POINT_MS * complexity;
}

interface Persisted {
	version: number;
	buckets: Record<string, ComplexityBucket>;
}

function isValidBucket(b: unknown): b is ComplexityBucket {
	if (!b || typeof b !== "object") return false;
	const x = b as Record<string, unknown>;
	for (const k of ["count", "totalMs", "meanMs", "minMs", "maxMs", "lastMs"]) {
		if (typeof x[k] !== "number" || !Number.isFinite(x[k] as number)) return false;
	}
	return (x.count as number) > 0;
}

export class ComplexityModel {
	private readonly file: string;
	private buckets: Map<number, ComplexityBucket> = new Map();

	constructor() {
		this.file = path.join(swarmStateRoot(), "complexity.json");
		this.load();
	}

	private load(): void {
		this.buckets.clear();
		try {
			if (!fs.existsSync(this.file)) return;
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Persisted;
			if (!parsed || typeof parsed !== "object" || !parsed.buckets) return;
			for (const [key, bucket] of Object.entries(parsed.buckets)) {
				const c = Number(key);
				if (Number.isInteger(c) && c >= 0 && c <= 10 && isValidBucket(bucket)) {
					this.buckets.set(c, bucket);
				}
			}
		} catch {
			// start fresh on corrupt data
			this.buckets.clear();
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(swarmStateRoot(), { recursive: true });
			const out: Persisted = { version: 1, buckets: {} };
			for (const [c, bucket] of this.buckets) out.buckets[String(c)] = bucket;
			const tmp = `${this.file}.tmp`;
			fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
			fs.renameSync(tmp, this.file);
		} catch {
			// best effort
		}
	}

	/** Record an observed duration for a completed task of the given complexity. */
	record(complexity: number | undefined, durationMs: number): void {
		const c = clampComplexity(complexity);
		if (c === undefined) return;
		if (!Number.isFinite(durationMs) || durationMs <= 0) return;

		// Refresh from disk first so concurrent pi sessions accumulate additively
		// (last-writer-wins would otherwise drop the other session's samples).
		this.load();

		const existing = this.buckets.get(c);
		if (!existing) {
			this.buckets.set(c, {
				count: 1,
				totalMs: durationMs,
				meanMs: durationMs,
				minMs: durationMs,
				maxMs: durationMs,
				lastMs: durationMs,
			});
		} else {
			existing.count += 1;
			existing.totalMs += durationMs;
			existing.meanMs = existing.totalMs / existing.count;
			existing.minMs = Math.min(existing.minMs, durationMs);
			existing.maxMs = Math.max(existing.maxMs, durationMs);
			existing.lastMs = durationMs;
		}
		this.save();
	}

	/** Number of recorded samples at (rounded) complexity. */
	samples(complexity: number | undefined): number {
		const c = clampComplexity(complexity);
		if (c === undefined) return 0;
		return this.buckets.get(c)?.count ?? 0;
	}

	/**
	 * Estimated duration (ms) for a task of the given complexity: the bucket mean
	 * when data exists, otherwise interpolated from neighbouring buckets, otherwise
	 * the prior curve.
	 */
	estimateMs(complexity: number | undefined): number {
		const c = clampComplexity(complexity);
		if (c === undefined) return priorMs(5);

		const own = this.buckets.get(c);
		if (own && own.count > 0) return own.meanMs;

		// Interpolate from the nearest lower/upper buckets that have data.
		let lower: { c: number; mean: number } | undefined;
		let upper: { c: number; mean: number } | undefined;
		for (let d = c - 1; d >= 0; d--) {
			const b = this.buckets.get(d);
			if (b && b.count > 0) {
				lower = { c: d, mean: b.meanMs };
				break;
			}
		}
		for (let d = c + 1; d < BUCKETS; d++) {
			const b = this.buckets.get(d);
			if (b && b.count > 0) {
				upper = { c: d, mean: b.meanMs };
				break;
			}
		}

		if (lower && upper) {
			const t = (c - lower.c) / (upper.c - lower.c);
			return lower.mean + t * (upper.mean - lower.mean);
		}
		if (lower) return lower.mean;
		if (upper) return upper.mean;
		return priorMs(c);
	}

	/** Whether the estimate for a complexity is backed by at least `minSamples`. */
	isConfident(complexity: number | undefined, minSamples: number): boolean {
		return this.samples(complexity) >= Math.max(1, minSamples);
	}

	/** Snapshot for display: one row per complexity that has data. */
	table(): Array<{ complexity: number } & ComplexityBucket> {
		const rows: Array<{ complexity: number } & ComplexityBucket> = [];
		for (let c = 0; c < BUCKETS; c++) {
			const b = this.buckets.get(c);
			if (b && b.count > 0) rows.push({ complexity: c, ...b });
		}
		return rows;
	}
}

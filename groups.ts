/**
 * GroupRegistry - tracks workflow and orchestration coordinators.
 *
 * A group is a long-running background job that spawns many sub-agent tasks
 * (via SwarmRunner) and coordinates them. Like tasks, groups are accepted
 * immediately and run across turns; callers await or poll them later.
 */

import type { SwarmStore } from "./store.ts";
import type { GroupKind, GroupRecord, GroupStatus } from "./types.ts";

export class GroupRegistry {
	private readonly records = new Map<string, GroupRecord>();
	private readonly dones = new Map<string, Promise<GroupRecord>>();
	private readonly resolvers = new Map<string, (r: GroupRecord) => void>();
	private counter = 0;

	constructor(
		private readonly store: SwarmStore,
		private readonly onChange: () => void,
	) {}

	adopt(records: GroupRecord[]): void {
		for (const record of records) {
			if (this.records.has(record.id)) continue;
			if (record.status === "running") {
				record.status = "failed";
				record.errorMessage = record.errorMessage ?? "Interrupted: process exited before completion.";
			}
			this.records.set(record.id, record);
			const idNum = Number(record.id.replace(/^g/, ""));
			if (Number.isFinite(idNum)) this.counter = Math.max(this.counter, idNum);
		}
	}

	create(kind: GroupKind, label: string, goal: string, meta?: Record<string, unknown>): GroupRecord {
		this.counter += 1;
		const id = `g${this.counter}`;
		const record: GroupRecord = {
			id,
			kind,
			label,
			goal,
			status: "running",
			createdAt: Date.now(),
			taskIds: [],
			output: "",
			meta,
		};
		let resolve!: (r: GroupRecord) => void;
		const done = new Promise<GroupRecord>((res) => {
			resolve = res;
		});
		this.records.set(id, record);
		this.dones.set(id, done);
		this.resolvers.set(id, resolve);
		this.store.saveGroup(record);
		this.onChange();
		return record;
	}

	update(record: GroupRecord): void {
		this.records.set(record.id, record);
		this.store.saveGroup(record);
		this.onChange();
	}

	finish(id: string, status: GroupStatus, output: string, errorMessage?: string): void {
		const record = this.records.get(id);
		if (!record) return;
		if (record.status !== "running") return;
		record.status = status;
		record.output = output;
		record.endedAt = Date.now();
		if (errorMessage) record.errorMessage = errorMessage;
		this.store.saveGroup(record);
		this.resolvers.get(id)?.(record);
		this.onChange();
	}

	get(id: string): GroupRecord | undefined {
		return this.records.get(id);
	}

	list(): GroupRecord[] {
		return Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	activeCount(): number {
		let n = 0;
		for (const r of this.records.values()) if (r.status === "running") n++;
		return n;
	}

	async waitFor(ids: string[], signal?: AbortSignal): Promise<GroupRecord[]> {
		const promises = ids.map((id) => this.dones.get(id) ?? Promise.resolve(this.records.get(id)));
		if (!signal) {
			await Promise.all(promises);
		} else {
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => finish();
				if (signal.aborted) return finish();
				signal.addEventListener("abort", onAbort, { once: true });
				Promise.all(promises).then(finish, finish);
			});
		}
		return ids.map((id) => this.records.get(id)).filter((r): r is GroupRecord => Boolean(r));
	}

	clearFinished(): number {
		let n = 0;
		for (const [id, record] of this.records) {
			if (record.status === "running") continue;
			this.records.delete(id);
			this.dones.delete(id);
			this.resolvers.delete(id);
			n++;
		}
		return n;
	}
}

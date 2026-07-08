/**
 * Disk persistence for swarm tasks and groups.
 *
 * Layout:
 *   ~/.pi/agent/swarm/<sessionKey>/tasks/<taskId>.json   task record snapshots
 *   ~/.pi/agent/swarm/<sessionKey>/tasks/<taskId>.jsonl  raw child event stream
 *   ~/.pi/agent/swarm/<sessionKey>/groups/<groupId>.json group record snapshots
 *
 * Snapshots are written on every state transition so that `/swarm` and
 * swarm_result keep working after a reload, even for tasks whose live process
 * belonged to a previous module instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { swarmStateRoot } from "./config.ts";
import type { GroupRecord, TaskRecord } from "./types.ts";

export class SwarmStore {
	private readonly baseDir: string;
	private readonly tasksDir: string;
	private readonly groupsDir: string;

	constructor(sessionKey: string) {
		const safeKey = sessionKey.replace(/[^\w.-]+/g, "_") || "ephemeral";
		this.baseDir = path.join(swarmStateRoot(), safeKey);
		this.tasksDir = path.join(this.baseDir, "tasks");
		this.groupsDir = path.join(this.baseDir, "groups");
	}

	private ensureDirs(): void {
		try {
			fs.mkdirSync(this.tasksDir, { recursive: true });
			fs.mkdirSync(this.groupsDir, { recursive: true });
		} catch {
			// best effort
		}
	}

	taskLogPath(taskId: string): string {
		return path.join(this.tasksDir, `${taskId}.jsonl`);
	}

	saveTask(record: TaskRecord): void {
		this.ensureDirs();
		try {
			fs.writeFileSync(path.join(this.tasksDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8");
		} catch {
			// best effort
		}
	}

	appendTaskEvent(taskId: string, line: string): void {
		this.ensureDirs();
		try {
			fs.appendFileSync(this.taskLogPath(taskId), `${line}\n`, "utf-8");
		} catch {
			// best effort
		}
	}

	saveGroup(record: GroupRecord): void {
		this.ensureDirs();
		try {
			fs.writeFileSync(path.join(this.groupsDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8");
		} catch {
			// best effort
		}
	}

	loadTasks(): TaskRecord[] {
		return this.loadDir<TaskRecord>(this.tasksDir, ".json");
	}

	loadGroups(): GroupRecord[] {
		return this.loadDir<GroupRecord>(this.groupsDir, ".json");
	}

	private loadDir<T>(dir: string, ext: string): T[] {
		const out: T[] = [];
		if (!fs.existsSync(dir)) return out;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return out;
		}
		for (const name of entries) {
			if (!name.endsWith(ext)) continue;
			try {
				const raw = fs.readFileSync(path.join(dir, name), "utf-8");
				out.push(JSON.parse(raw) as T);
			} catch {
				// skip corrupt snapshot
			}
		}
		return out;
	}

	/** Remove all snapshots for finished tasks/groups. Returns the count removed. */
	prune(isTaskActive: (r: TaskRecord) => boolean, isGroupActive: (r: GroupRecord) => boolean): number {
		let removed = 0;
		for (const task of this.loadTasks()) {
			if (isTaskActive(task)) continue;
			removed += this.unlink(path.join(this.tasksDir, `${task.id}.json`));
			this.unlink(this.taskLogPath(task.id));
		}
		for (const group of this.loadGroups()) {
			if (isGroupActive(group)) continue;
			removed += this.unlink(path.join(this.groupsDir, `${group.id}.json`));
		}
		return removed;
	}

	private unlink(file: string): number {
		try {
			if (fs.existsSync(file)) {
				fs.unlinkSync(file);
				return 1;
			}
		} catch {
			// best effort
		}
		return 0;
	}
}

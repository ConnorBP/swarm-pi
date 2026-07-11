/**
 * SwarmRunner - spawns and supervises sub-agent subprocesses.
 *
 * Each task runs an isolated `pi --mode json -p --no-session` child process.
 * Tasks are accepted immediately (returning at once) and executed in the
 * background, bounded by a global concurrency limit. This is what makes
 * delegation asynchronous: the orchestrating agent's tool call returns while
 * work continues across turns, then later collects results via the runner.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentProfile, AgentScope } from "./agents.ts";
import { clampComplexity } from "./complexity.ts";
import type { SwarmStore } from "./store.ts";
import type { SpawnSpec, SwarmConfig, TaskRecord } from "./types.ts";
import { collectToolCalls, emptyUsage, finalAssistantText } from "./util.ts";

/** Live, non-serializable state for a task. */
interface TaskHandle {
	proc?: ChildProcess;
	done: Promise<TaskRecord>;
	resolve: (record: TaskRecord) => void;
	messages: Message[];
	tmpPromptPath?: string;
	tmpPromptDir?: string;
	aborted: boolean;
	started: boolean;
}

export interface RunnerDeps {
	config: SwarmConfig;
	store: SwarmStore;
	cwd: string;
	resolveProfile: (name: string, scope: AgentScope) => AgentProfile | undefined;
	onChange: () => void;
	onTaskComplete?: (record: TaskRecord) => void;
	appendEntry?: (record: TaskRecord) => void;
	/** Estimated duration (ms) for a complexity score, from the learned model. */
	estimateMs?: (complexity: number) => number;
}

/** Resolve how to re-invoke the running `pi` binary for a child process. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") || currentScript?.includes("~BUN");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export class SwarmRunner {
	private readonly deps: RunnerDeps;
	private readonly records = new Map<string, TaskRecord>();
	private readonly handles = new Map<string, TaskHandle>();
	private readonly queue: string[] = [];
	private running = 0;
	private counter = 0;

	constructor(deps: RunnerDeps) {
		this.deps = deps;
	}

	get config(): SwarmConfig {
		return this.deps.config;
	}

	/** Adopt records recovered from disk (e.g. after a reload). Read-only history. */
	adopt(records: TaskRecord[]): void {
		for (const record of records) {
			if (this.records.has(record.id)) continue;
			// Backfill fields that older or hand-edited snapshots may lack, so the
			// status/render paths never dereference an undefined usage/toolCalls.
			record.usage = record.usage ?? emptyUsage();
			if (!Array.isArray(record.toolCalls)) record.toolCalls = [];
			if (typeof record.output !== "string") record.output = "";
			// A task that a previous process left mid-flight can no longer be
			// supervised: its child died with that process. Mark it detached.
			if (record.status === "running" || record.status === "queued") {
				record.status = "detached";
			}
			this.records.set(record.id, record);
			const idNum = Number(record.id.replace(/^t/, ""));
			if (Number.isFinite(idNum)) this.counter = Math.max(this.counter, idNum);
		}
	}

	private nextId(): string {
		this.counter += 1;
		return `t${this.counter}`;
	}

	list(): TaskRecord[] {
		return Array.from(this.records.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): TaskRecord | undefined {
		return this.records.get(id);
	}

	activeCount(): number {
		let n = 0;
		for (const r of this.records.values()) if (r.status === "running" || r.status === "queued") n++;
		return n;
	}

	/** Accept a task for background execution and return its record immediately. */
	enqueue(spec: SpawnSpec): TaskRecord {
		const id = this.nextId();
		const scope: AgentScope = spec.agentScope ?? this.deps.config.defaultAgentScope;
		const profile = spec.agent ? this.deps.resolveProfile(spec.agent, scope) : undefined;

		// Model precedence: explicit call arg > /swarm-config per-agent override >
		// profile frontmatter > config default > inherit the user's active model.
		const configModel = spec.agent ? this.deps.config.agentModels?.[spec.agent] : undefined;
		const model = spec.model ?? (configModel || undefined) ?? profile?.model ?? (this.deps.config.defaultModel || undefined);
		const tools = spec.tools ?? profile?.tools;
		const complexity = clampComplexity(spec.complexity);
		const estimatedMs = complexity !== undefined ? this.deps.estimateMs?.(complexity) : undefined;

		const record: TaskRecord = {
			id,
			label: spec.label ?? spec.agent ?? "task",
			agent: spec.agent,
			agentSource: profile?.source ?? (spec.agent ? "unknown" : undefined),
			task: spec.task,
			model,
			tools,
			cwd: spec.cwd ?? this.deps.cwd,
			status: "queued",
			createdAt: Date.now(),
			output: "",
			toolCalls: [],
			usage: emptyUsage(),
			logPath: this.deps.store.taskLogPath(id),
			groupId: spec.groupId,
			complexity,
			estimatedMs,
			meta: { ...spec.meta, agentScope: scope },
		};

		let resolve!: (r: TaskRecord) => void;
		const done = new Promise<TaskRecord>((res) => {
			resolve = res;
		});
		const handle: TaskHandle = { done, resolve, messages: [], aborted: false, started: false };

		// Missing agent profile: fail fast without spawning.
		if (spec.agent && !profile) {
			record.status = "failed";
			record.endedAt = Date.now();
			record.errorMessage = `Unknown agent profile: "${spec.agent}".`;
			record.stopReason = "error";
			this.records.set(id, record);
			this.handles.set(id, handle);
			this.persist(record);
			resolve(record);
			this.deps.onChange();
			this.deps.onTaskComplete?.(record);
			return record;
		}

		this.records.set(id, record);
		this.handles.set(id, handle);
		this.persist(record);
		this.queue.push(id);
		this.deps.onChange();
		this.pump();
		return record;
	}

	/** Await completion of the given task ids (or all known tasks). */
	async waitFor(ids?: string[], signal?: AbortSignal): Promise<TaskRecord[]> {
		const targetIds = ids ?? this.list().map((r) => r.id);
		const promises = targetIds.map((id) => {
			const handle = this.handles.get(id);
			const record = this.records.get(id);
			if (!handle) return Promise.resolve(record);
			return handle.done;
		});

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

		return targetIds.map((id) => this.records.get(id)).filter((r): r is TaskRecord => Boolean(r));
	}

	cancel(id: string, reason = "cancelled by user"): boolean {
		const record = this.records.get(id);
		const handle = this.handles.get(id);
		if (!record) return false;
		if (record.status === "queued") {
			const idx = this.queue.indexOf(id);
			if (idx >= 0) this.queue.splice(idx, 1);
			this.finalizeCancelled(record, handle, reason);
			this.pump();
			return true;
		}
		if (record.status === "running" && handle?.proc) {
			handle.aborted = true;
			this.killProc(handle.proc);
			// finalize happens on the process 'close' handler.
			return true;
		}
		return false;
	}

	cancelAll(reason = "cancelled by user"): number {
		let n = 0;
		for (const record of this.list()) {
			if (record.status === "queued" || record.status === "running") {
				if (this.cancel(record.id, reason)) n++;
			}
		}
		return n;
	}

	private killProc(proc: ChildProcess): void {
		try {
			proc.kill("SIGTERM");
			const timer = setTimeout(() => {
				if (!proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						// ignore
					}
				}
			}, 5000);
			// Don't let the escalation timer keep the pi process alive at exit.
			timer.unref?.();
		} catch {
			// ignore
		}
	}

	private finalizeCancelled(record: TaskRecord, handle: TaskHandle | undefined, reason: string): void {
		record.status = "cancelled";
		record.endedAt = Date.now();
		record.stopReason = "cancelled";
		record.errorMessage = reason;
		this.persist(record);
		handle?.resolve(record);
		this.deps.onChange();
		this.deps.onTaskComplete?.(record);
	}

	private pump(): void {
		while (this.running < this.deps.config.maxConcurrency && this.queue.length > 0) {
			const id = this.queue.shift();
			if (!id) break;
			const record = this.records.get(id);
			const handle = this.handles.get(id);
			if (!record || !handle || record.status !== "queued") continue;
			this.running += 1;
			this.startTask(id, record, handle);
		}
	}

	private buildArgs(record: TaskRecord, handle: TaskHandle): string[] {
		const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
		if (record.model) args.push("--model", record.model);
		if (record.tools && record.tools.length > 0) args.push("--tools", record.tools.join(","));

		const scope: AgentScope = (record.meta?.agentScope as AgentScope) ?? this.deps.config.defaultAgentScope;
		const profile = record.agent ? this.deps.resolveProfile(record.agent, scope) : undefined;
		if (profile?.systemPrompt.trim()) {
			try {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-"));
				const safe = record.agent?.replace(/[^\w.-]+/g, "_") ?? "agent";
				const file = path.join(dir, `prompt-${safe}.md`);
				fs.writeFileSync(file, profile.systemPrompt, { encoding: "utf-8", mode: 0o600 });
				handle.tmpPromptDir = dir;
				handle.tmpPromptPath = file;
				args.push("--append-system-prompt", file);
			} catch {
				// If we cannot write the prompt file, run without it.
			}
		}
		args.push(`Task: ${record.task}`);
		return args;
	}

	private startTask(id: string, record: TaskRecord, handle: TaskHandle): void {
		handle.started = true;
		record.status = "running";
		record.startedAt = Date.now();
		this.persist(record);
		this.deps.onChange();

		const args = this.buildArgs(record, handle);
		const invocation = piInvocation(args);

		let proc: ChildProcess;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: record.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			record.errorMessage = `Failed to spawn subagent: ${(err as Error).message}`;
			this.finalizeTask(id, record, handle, 1, "error");
			return;
		}

		handle.proc = proc;
		record.pid = proc.pid;
		let stderr = "";
		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			if (this.deps.config.logEvents) this.deps.store.appendTaskEvent(id, line);
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			// `--mode json` emits message_end for user, assistant, AND toolResult
			// messages; that single event type covers everything we derive output
			// and tool-call display from.
			if (event.type === "message_end" && event.message) {
				handle.messages.push(event.message);
				this.applyMessage(record, handle, event.message);
				this.persist(record);
				this.deps.onChange();
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			stderr += `\n[spawn error] ${err.message}`;
			if (buffer.trim()) processLine(buffer);
			record.errorMessage = record.errorMessage ?? (stderr.trim() || err.message);
			this.finalizeTask(id, record, handle, 1, "error");
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			if (handle.aborted) {
				record.errorMessage = "Subagent cancelled";
				this.finalizeTask(id, record, handle, code ?? 1, "cancelled");
				return;
			}
			if ((code ?? 0) !== 0 && !record.errorMessage) {
				record.errorMessage = stderr.trim() || `exit code ${code}`;
			}
			this.finalizeTask(id, record, handle, code ?? 0, undefined);
		});
	}

	private applyMessage(record: TaskRecord, handle: TaskHandle, message: Message): void {
		if (message.role === "assistant") {
			record.usage.turns += 1;
			const usage = message.usage;
			if (usage) {
				record.usage.input += usage.input || 0;
				record.usage.output += usage.output || 0;
				record.usage.cacheRead += usage.cacheRead || 0;
				record.usage.cacheWrite += usage.cacheWrite || 0;
				record.usage.cost += usage.cost?.total || 0;
				record.usage.contextTokens = usage.totalTokens || record.usage.contextTokens;
			}
			if (!record.model && message.model) record.model = message.model;
			if (message.stopReason) record.stopReason = message.stopReason;
			if (message.errorMessage) record.errorMessage = message.errorMessage;
		}
		record.output = finalAssistantText(handle.messages) || record.output;
		record.toolCalls = collectToolCalls(handle.messages);
	}

	private finalizeTask(
		id: string,
		record: TaskRecord,
		handle: TaskHandle,
		exitCode: number,
		forcedStatus: "error" | "cancelled" | undefined,
	): void {
		if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
			// Already finalized (e.g. error then close). Avoid double-decrement.
			return;
		}
		record.exitCode = exitCode;
		record.endedAt = Date.now();
		record.output = finalAssistantText(handle.messages) || record.output;
		record.toolCalls = collectToolCalls(handle.messages);

		const failedByReason = record.stopReason === "error" || record.stopReason === "aborted";
		if (forcedStatus === "cancelled") record.status = "cancelled";
		else if (forcedStatus === "error" || exitCode !== 0 || failedByReason) record.status = "failed";
		else record.status = "succeeded";

		this.cleanupTemp(handle);
		this.running = Math.max(0, this.running - 1);
		this.persist(record);
		handle.resolve(record);
		this.deps.onChange();
		this.deps.onTaskComplete?.(record);
		this.pump();
	}

	private cleanupTemp(handle: TaskHandle): void {
		if (handle.tmpPromptPath) {
			try {
				fs.unlinkSync(handle.tmpPromptPath);
			} catch {
				// ignore
			}
		}
		if (handle.tmpPromptDir) {
			try {
				fs.rmdirSync(handle.tmpPromptDir);
			} catch {
				// ignore
			}
		}
		handle.tmpPromptPath = undefined;
		handle.tmpPromptDir = undefined;
	}

	private persist(record: TaskRecord): void {
		this.deps.store.saveTask(record);
		this.deps.appendEntry?.(record);
	}

	/** Drop finished tasks from the in-memory registry. Returns count removed. */
	clearFinished(): number {
		let n = 0;
		for (const [id, record] of this.records) {
			if (record.status === "running" || record.status === "queued") continue;
			this.records.delete(id);
			this.handles.delete(id);
			n++;
		}
		return n;
	}

	/** Kill everything still running (used on session shutdown). */
	shutdown(): void {
		for (const handle of this.handles.values()) {
			// Use the same SIGTERM -> SIGKILL escalation as cancel so a child that
			// ignores SIGTERM is not orphaned past session/reload teardown (POSIX).
			if (handle.proc && !handle.proc.killed) this.killProc(handle.proc);
			this.cleanupTemp(handle);
		}
	}
}

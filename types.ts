/**
 * Shared types for the swarm extension.
 *
 * A "task" is a single sub-agent run (one isolated `pi` subprocess).
 * A "group" is a coordinator (workflow or orchestration) that owns many tasks.
 */

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "detached";

export type GroupKind = "workflow" | "orchestrate";

export type GroupStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface DisplayToolCall {
	name: string;
	args: Record<string, unknown>;
}

/**
 * Serializable record for a single sub-agent task. This is the persisted,
 * branch-safe representation. Live handles (child process, promises) live
 * separately in the runner's handle map, keyed by `id`.
 */
export interface TaskRecord {
	id: string;
	label: string;
	agent?: string;
	agentSource?: "user" | "project" | "builtin" | "unknown";
	task: string;
	model?: string;
	tools?: string[];
	cwd: string;
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	output: string;
	toolCalls: DisplayToolCall[];
	usage: UsageStats;
	pid?: number;
	logPath?: string;
	/** Grouping for workflow / orchestration coordinators. */
	groupId?: string;
	/** Model-estimated complexity 0-10, used for duration estimates and escalation. */
	complexity?: number;
	/** Estimated duration (ms) from the complexity model at spawn time. */
	estimatedMs?: number;
	/** True once this task has been flagged/handled for overrun escalation. */
	escalated?: boolean;
	/** Free-form coordinator metadata (step id, chunk id, attempt, role, ...). */
	meta?: Record<string, unknown>;
}

export interface GroupRecord {
	id: string;
	kind: GroupKind;
	label: string;
	goal: string;
	status: GroupStatus;
	createdAt: number;
	endedAt?: number;
	/** Ordered task ids belonging to this group. */
	taskIds: string[];
	/** Final combined output the coordinator produced. */
	output: string;
	/** Short human-readable progress note (e.g. "step 2/4: map(6)"). */
	note?: string;
	errorMessage?: string;
	/** Model-estimated complexity 0-10 for the overall job. */
	complexity?: number;
	meta?: Record<string, unknown>;
}

/** Specification for a single spawned sub-agent. */
export interface SpawnSpec {
	task: string;
	agent?: string;
	label?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	groupId?: string;
	/** Estimated complexity 0-10, drives duration estimates and overrun escalation. */
	complexity?: number;
	meta?: Record<string, unknown>;
	/** Which agent directories to search for `agent`. Defaults to config. */
	agentScope?: "user" | "project" | "both";
}

/** A workflow is an ordered list of steps with barriers between them. */
export type WorkflowStepKind = "task" | "map" | "reduce";

export interface WorkflowStep {
	id: string;
	kind: WorkflowStepKind;
	agent?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	/** Prompt template. Supports {goal} {previous} {steps.<id>} {item} {index} {inputs}. */
	prompt: string;
	/** map: literal list of items to fan out over. */
	items?: string[];
	/** map: derive items by splitting a prior step's combined output on a delimiter. */
	itemsFromStep?: string;
	itemsDelimiter?: string;
	/** reduce: which step outputs to gather into {inputs} (default: all prior steps). */
	from?: string[];
	/** Per-step concurrency override. */
	concurrency?: number;
	label?: string;
}

export interface WorkflowSpec {
	name?: string;
	steps: WorkflowStep[];
}

/** Input to the auto-chunking orchestrator. */
export interface OrchestrateSpec {
	goal: string;
	context?: string;
	criteria?: string;
	maxChunks?: number;
	concurrency?: number;
	plannerAgent?: string;
	workerAgent?: string;
	validatorAgent?: string;
	synthesizerAgent?: string;
	validate?: boolean;
	synthesize?: boolean;
	model?: string;
	tools?: string[];
	cwd?: string;
	/** Overall complexity 0-10 (recorded on the job). */
	complexity?: number;
}

/** A planned chunk emitted by the planner sub-agent. */
export interface PlannedChunk {
	id: string;
	title: string;
	task: string;
	dependsOn: string[];
	/** Planner-estimated complexity 0-10 for this chunk. */
	complexity?: number;
}

export interface SwarmConfig {
	/** Model for sub-agents when a profile / call does not specify one. Empty = inherit user default. */
	defaultModel: string;
	/**
	 * Per-agent-profile model overrides, e.g. { planner: "provider/id", worker: "provider/id" }.
	 * Takes precedence over the profile's own `model` frontmatter. Managed via /swarm-config.
	 */
	agentModels: Record<string, string>;
	/** Max sub-agent subprocesses running at once (global). */
	maxConcurrency: number;
	/** Max tasks accepted in a single swarm_spawn call. */
	maxSpawnBatch: number;
	/** Default agent directory scope. */
	defaultAgentScope: "user" | "project" | "both";
	/** Byte cap for per-task output surfaced back to the orchestrating LLM. */
	perTaskOutputCap: number;
	/** Show the live status widget above the editor (TUI only). */
	widget: boolean;
	/** Inject a follow-up message to the orchestrator when background work finishes. */
	notifyOnComplete: boolean;
	/** Confirm before running project-local agent profiles. */
	confirmProjectAgents: boolean;
	/** Fold sub-agent spend into pi's session cost counter (money only). */
	countSubagentCost: boolean;
	/** Allow the model (not just the user) to create/manage scheduled tasks. */
	allowModelScheduling: boolean;
	/** What to do when a task overruns its estimate: off | notify | auto (re-chunk). */
	escalation: "off" | "notify" | "auto";
	/** Escalate when elapsed exceeds this multiple of the estimated duration. */
	escalationFactor: number;
	/** Minimum recorded samples at a complexity before its estimate drives escalation. */
	escalationMinSamples: number;
	/** Extra directories to search for agent profiles. */
	agentDirs: string[];
}

/** An action a schedule fires: spawn work, orchestrate, or prompt the main agent. */
export type ScheduleAction =
	| { type: "spawn"; task: string; agent?: string; model?: string; tools?: string[]; cwd?: string; complexity?: number }
	| { type: "orchestrate"; goal: string; criteria?: string; maxChunks?: number; complexity?: number; cwd?: string }
	| { type: "prompt"; text: string; mode?: "wake" | "steer" };

/** A recurring scheduled task (fires while pi is running). */
export interface ScheduleRecord {
	id: string;
	name: string;
	everyMs: number;
	action: ScheduleAction;
	enabled: boolean;
	createdBy: "user" | "model";
	createdAt: number;
	lastRunAt?: number;
	nextRunAt?: number;
	runCount: number;
	/** Run once at the next due time even if pi was off when it was due. */
	catchUp?: boolean;
}

/** Learned duration statistics for one complexity bucket (0-10). */
export interface ComplexityBucket {
	count: number;
	totalMs: number;
	meanMs: number;
	minMs: number;
	maxMs: number;
	lastMs: number;
}

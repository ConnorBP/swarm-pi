# swarm

A sub-agent **orchestration toolkit** for the [pi](https://pi.dev) harness. It lets the agent
delegate work to a swarm of isolated sub-agents, run declarative multi-stage
workflows, and autonomously decompose large goals into validated, parallel,
**asynchronously executed** chunks - then supervise and collect all of it over a
long session.

Each sub-agent runs in a **separate `pi` process** with its own context window, so
delegated work never pollutes the orchestrator's context. Work runs in the
**background** by default: the orchestrating agent spawns tasks, keeps thinking,
and collects results later.

## Install

This is a directory extension. Place it at `~/.pi/agent/extensions/swarm/` (it
is auto-discovered) and run `/reload` or restart pi. No build step is needed -
pi loads TypeScript directly.

## Tools (callable by the model)

| Tool | Purpose |
|------|---------|
| `swarm_spawn` | Launch one or many sub-agents. Async by default (returns task ids); `wait: true` blocks and returns outputs. |
| `swarm_status` | Poll task and job status (optionally filtered by ids or a job id). |
| `swarm_await` | Block until targeted tasks/jobs finish and return their outputs. Esc stops waiting; tasks keep running. |
| `swarm_watch` | **Non-blocking**: be re-activated when watched work finishes (or after a timer) instead of blocking. |
| `swarm_result` | Fetch the full output of one finished task (`t#`) or job (`g#`). |
| `swarm_cancel` | Stop running/queued tasks by ids, job, or `all: true`. |
| `swarm_workflow` | Run a declarative multi-stage workflow (`task` / `map` / `reduce`). |
| `swarm_orchestrate` | Auto-decompose a big goal into chunks, delegate in parallel, validate, and synthesize. |

### Async by design

`swarm_spawn`, `swarm_workflow`, and `swarm_orchestrate` return **immediately** with
ids and run in the background across turns, bounded by a global concurrency
limit. The orchestrator collects results whenever it wants:

```
swarm_spawn { tasks: [
  { agent: "scout",  task: "Map all auth code and return file:line references" },
  { agent: "scout",  task: "Map all billing code and return file:line references" }
]}
# ...keep working...
swarm_await { }          # block for everything still active, get all outputs
```

### Non-blocking orchestration (don't sit on "Working...")

`swarm_await` blocks the session. For long work, spawn async and let completions
re-activate the model instead:

```
swarm_orchestrate { goal: "...", notify: true }   # returns a job id, sets a watch
# the model ends its turn (e.g. "dispatched - I'll report when done")
# ...when the job finishes, the agent is re-activated with a status summary...
```

`swarm_watch` is the general primitive. It registers a wake-up and returns
immediately so the model can end its turn (or keep doing other management); the
extension re-activates it via `pi.sendMessage({ triggerTurn: true })` when the
condition is met:

- `swarm_watch { group: "g1" }` - wake when that job finishes
- `swarm_watch { ids: ["t3","t4"] }` - wake when those tasks finish
- `swarm_watch { all: true }` - wake when all active swarm work finishes
- `swarm_watch { checkInMs: 30000 }` - a timed check-back (poll on a timer)
- `mode: "steer"` interrupts the current turn instead of waiting for it to finish

`swarm_spawn`, `swarm_workflow`, and `swarm_orchestrate` all accept `notify: true`
as a shorthand that sets the matching watch for you. Watching already-finished
work returns "already complete" rather than firing, so there is no busy loop.

### Workflows

A workflow is an ordered list of steps with a barrier between each. Prompt
templates may use `{goal}`, `{previous}`, `{steps.<id>}`, `{inputs}`, and inside a
`map` step `{item}` / `{index}`.

```json
{
  "spec": {
    "name": "review-each-module",
    "steps": [
      { "id": "list",   "kind": "task",   "agent": "scout",
        "prompt": "List each top-level module under src/, one per line." },
      { "id": "review", "kind": "map",    "agent": "reviewer",
        "itemsFromStep": "list",
        "prompt": "Review module {item} for bugs and security issues." },
      { "id": "sum",    "kind": "reduce", "agent": "synthesizer",
        "prompt": "Combine these module reviews into one prioritized report:\n{inputs}" }
    ]
  },
  "goal": "Security-review the codebase module by module"
}
```

### Orchestration (auto-chunking + validation)

`swarm_orchestrate` is the flagship for "do this big thing end to end and check it":

1. a **planner** sub-agent decomposes the `goal` into self-contained chunks (JSON),
2. **worker** sub-agents execute chunks in dependency-ordered parallel waves,
3. a **reviewer** validates each chunk against `criteria` (failed chunks retry once with feedback),
4. a **synthesizer** merges everything into a final deliverable.

```
swarm_orchestrate {
  goal: "Add structured logging across the service and update the docs",
  context: "Node/TypeScript service in src/. Logger lives in src/log.ts.",
  criteria: "Every request handler logs start/end with a request id; docs/logging.md updated",
  maxChunks: 6
}
```

## Commands (for you)

| Command | Purpose |
|---------|---------|
| `/swarm` | Live dashboard of tasks and jobs. |
| `/swarm-config` | Interactive menu to pick which model each agent type uses. |
| `/swarm-cancel <taskId\|jobId\|all>` | Cancel work. |
| `/swarm-agents` | List available agent profiles and their effective models. |
| `/swarm-clear` | Drop finished tasks/jobs from the registry. |

### Choosing models per agent

Run `/swarm-config` to open an interactive settings panel (a `SettingsList`) with
one row per agent type (plus the default for profile-less tasks) and general
settings (max concurrency, agent scope, status widget, notify-on-complete).
Selecting a model row opens a **searchable, paginated** picker over the models you
have credentials for plus your `enabledModels` from `settings.json`; an "inherit"
row clears the override. Changes save to `~/.pi/agent/swarm/config.json`
(`agentModels`) and take effect immediately.

Model precedence for a sub-agent (first that is set wins):

1. explicit `model` passed to the tool call,
2. `/swarm-config` per-agent override (`agentModels[<agent>]`),
3. the profile's own `model` frontmatter,
4. `defaultModel`,
5. otherwise it inherits your active model.

## Agent profiles

Profiles are markdown files with frontmatter (`name`, `description`, optional
`tools`, optional `model`). Bundled defaults live in `swarm/agents/`
(`planner`, `worker`, `reviewer`, `scout`, `synthesizer`) and inherit your active
model unless a profile sets one. Override or add profiles in:

- `~/.pi/agent/agents/*.md` (user)
- `<project>/.pi/agents/*.md` (project - repo-controlled, confirmation-gated)

Set `agentScope` to `user` (default), `project`, or `both` per call.

## Configuration

Defaults in `swarm/config.json`, overridable at `~/.pi/agent/swarm/config.json` and,
for trusted projects, `<project>/.pi/swarm.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `defaultModel` | `""` | Model for sub-agents; empty inherits your default. |
| `agentModels` | `{}` | Per-agent model overrides (managed by `/swarm-config`). |
| `maxConcurrency` | `4` | Max sub-agent processes running at once. |
| `maxSpawnBatch` | `16` | Max tasks per `swarm_spawn` call. |
| `defaultAgentScope` | `"user"` | Agent-profile scope. |
| `perTaskOutputCap` | `16384` | Byte cap on per-task output returned to the model. |
| `widget` | `true` | Show the live status widget (TUI). |
| `notifyOnComplete` | `false` | Inject a follow-up note when all background work finishes. |
| `confirmProjectAgents` | `true` | Confirm before running repo-controlled agents. |
| `countSubagentCost` | `true` | Fold sub-agent spend into pi's session cost counter (money only). |
| `agentDirs` | `[]` | Extra directories to search for profiles. |

## Cost accounting

Each sub-agent runs as its own `pi` process, so its spend is normally invisible to
pi's session cost counter. With `countSubagentCost` on (default), the swarm
accumulates completed sub-agent cost and folds it into the next assistant
message's `usage.cost.total`, so the footer's session `$` total includes swarm
spend. Only the money is adjusted; token and context counters are left untouched
so context/compaction accounting stays accurate. A side effect is that the single
assistant message the cost lands on shows an inflated per-message cost; the
session total is what stays correct. `/swarm` still reports swarm-only spend
separately.

## State & durability

Task/job snapshots are written under `~/.pi/agent/swarm/<session>/`. After a
`/reload`, prior history is recovered so `/swarm` and `swarm_result` keep working;
tasks that were mid-flight in a previous process are marked `detached`.

## Security

Each sub-agent is a real `pi` process with the tools you grant it. Project-local
agent profiles are repo-controlled and gated behind a confirmation. Only enable
`project`/`both` scope for repositories you trust.

# Swarm history retention plan

## Problem

`~/.pi/agent/swarm/` grows without bound. Current state: **159 GB** across 7
session dirs. One session holds 205 tasks = **44 GB**. The largest single file
is `t27.jsonl` at **2.9 GB**.

## Root cause (verified by reading every source file)

Layout: `<sessionKey>/tasks/<taskId>.json` (snapshot) + `<taskId>.jsonl`
(raw child event stream) + `<sessionKey>/groups/<groupId>.json`.

**The `.jsonl` files are 99.97% of the bloat** (44 GB jsonl vs 5.7 MB json in one
session) and they are **write-only with zero in-code consumers**:

- `store.appendTaskEvent()` only does `fs.appendFileSync` — never read back.
- `taskLogPath` is only used to (a) set `record.logPath` and (b) delete in prune.
- `record.logPath` is stored in the `.json` snapshot but **never read** by
  `swarm_result`, `swarm_status`, `render`, or `adopt()`.
- On reload, `runner.adopt(store.loadTasks())` reads only the tiny `.json`
  snapshots — **never the jsonl**. There is no replay/audit feature.
- `README.md` does not mention the jsonl.

Everything the user/model sees (`output`, `toolCalls`, `usage`, `status`) is
derived in-memory in the runner and snapshotted to the small `.json` files. The
jsonl is a verbatim copy of the child `pi --mode json` stdout (full assistant
text + tool calls + tool results) that nothing ever reads back.

Existing cleanup is insufficient:

- `store.prune()` deletes finished tasks' files, but only for the **current**
  session, and only when the user manually runs `/swarm-clear`.
- `session_shutdown` kills live procs but does **not** prune disk.
- **No cross-session cleanup.** Old `<sessionKey>` dirs accumulate forever.
- **No retention config** in `SwarmConfig`.

## Plan (YAGNI: gate the write + sweep old sessions)

Drop capping/condense/rotation — unnecessary when the default is "don't write
it." Two changes:

### 1. Gate the jsonl write behind config (default off)

The jsonl is dead code today. Stop writing it by default; keep the option to
re-enable for out-of-band debugging (a user `tail`-ing a stuck task).

- `types.ts` — add `logEvents: boolean` to `SwarmConfig`.
- `config.ts` — `DEFAULT_CONFIG.logEvents = false`; add a clamp in `loadConfig()`
  (coerce to boolean, default false).
- `runner.ts:339` — wrap the append in a guard:

  ```ts
  if (this.deps.config.logEvents) this.deps.store.appendTaskEvent(id, line);
  ```

- Leave `logPath` on `TaskRecord` as-is. It's a harmless path string; removing it
  would break snapshot compatibility with existing `.json` files. Not worth it.

### 2. Cross-session retention sweep

- `types.ts` — add to `SwarmConfig`:
  - `retentionDays: number` (default `7`)
  - `maxSessions: number` (default `5`)
- `config.ts` — clamp both in `loadConfig()` (`retentionDays` 0–365, `maxSessions`
  0–100; 0 = "keep all").
- `store.ts` — add `purgeOldSessions(opts: { currentKey: string; retentionDays: number; maxSessions: number }): number`:
  - List dirs in `swarmStateRoot()`.
  - Skip `currentKey` (never delete the live session) and non-dir entries.
  - Stat each dir's mtime. Delete dirs older than `retentionDays` (when > 0).
  - If `maxSessions > 0`, sort remaining by mtime desc and delete all beyond the
    newest `maxSessions`.
  - Return count removed. Best-effort, swallow per-dir errors.
- `index.ts` `rebuild()` — after `new SwarmStore(sessionKey)` (~line 247), call
  `store.purgeOldSessions({ currentKey: sessionKey, retentionDays: config.retentionDays, maxSessions: config.maxSessions })`.

~30 lines total. No new deps.

## Immediate cleanup of the existing 159 GB

The July 8–10 session dirs are only 1–3 days old, so `retentionDays: 7` won't
touch them yet. They are **safe to delete** — nothing reads them. Options:

- **Manual (fastest):** `rm -rf` the old `<sessionKey>` dirs under
  `~/.pi/agent/swarm/`, keeping only the current session. Recovers ~159 GB now.
- **Config-driven:** set `maxSessions: 3` so the next `session_start` sweep
  deletes the 4 oldest automatically. Slower (one per start) but hands-off.

Recommended: manual purge now, then `maxSessions: 5` keeps it bounded forever.

All three new settings are also exposed in the `/swarm-config` interactive menu
("Raw event log", "Session retention (days)", "Max sessions kept") and persist to
`~/.pi/agent/swarm/config.json`.

## What was skipped (add only if needed later)

- Per-task jsonl byte cap / ring buffer — pointless when default is off.
- Delete/condense jsonl on task finalize — the `.json` snapshot already holds
  `output`/`toolCalls`/`usage`/`status`; redundant.
- jsonl compaction / rotation — no reader, no need.

**When to add them:** if a real replay/audit consumer is ever built, flip
`logEvents: true` and add a byte cap at that point.

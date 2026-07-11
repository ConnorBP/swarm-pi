# Known Issues — swarm extension

## 1. Orchestrator synthesizer fails to spawn on large jobs (ENAMETOOLONG)

**Observed:** 2026-07-11, job g2 (8-chunk driver-hunt orchestration). The synthesizer sub-agent (task t24) failed with:

```
t24 [failed] synthesizer 3ms - Failed to spawn subagent: ENAMETOOLONG: name too long, uv_spawn
```

**Impact:** The final synthesis/merge step of `swarm_orchestrate` does not run for jobs whose combined chunk outputs are large. The individual chunks still succeed and are validated, so no work is lost — but no synthesized deliverable is produced and the job's "succeeded" status is misleading (synthesis silently dropped).

**Root cause (suspected):** `orchestrate.ts` builds the synthesizer sub-agent by inlining all chunk outputs into the spawn prompt/args. When the concatenated payload is large, the child-process argv exceeds the OS `MAX_ARG` limit and libuv's `uv_spawn` fails with `ENAMETOOLONG` before the process starts.

**Fix direction:** Do not pass chunk outputs on the command line / inline in the spawn args. Write the combined chunk inputs to a temp file under the swarm state dir and have the synthesizer sub-agent read it (pass the file path, not the contents). Same treatment for any other orchestrator step that concatenates a large `{previous}` / `{inputs}` payload into a spawn. Cap or page the inputs if a single file would be enormous.

**Status: FIXED 2026-07-11.** Fixed at the root in `runner.ts` `SwarmRunner.buildArgs()`: when `record.task.length > SwarmRunner.MAX_INLINE_TASK` (20000 chars, well under Windows' 32767-char CreateProcess limit), the task is spilled to a temp file (`<tmpdir>/pi-swarm-XXXX/task.md`) and a short reference is passed inline instead (`Task: <800-char preview> ... (FULL TASK INSTRUCTIONS are in the file at <path> — read it with the read tool, then execute it in full.)`). The sub-agent reads the file with the `read` tool. The temp file is cleaned up in `cleanupTemp()` alongside the profile-prompt file. This fixes the general case (any oversized task, not just the synthesizer) while preserving the inline `Task:` path for normal-sized tasks. `TaskHandle.tmpTaskPath` added for cleanup tracking. TypeScript-clean.

**Severity:** Low for correctness (chunks survive), but the synthesis deliverable — the main point of `synthesize: true` — is silently lost on big jobs. **Fixed 2026-07-11** (see above).

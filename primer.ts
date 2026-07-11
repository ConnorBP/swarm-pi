/**
 * primer.ts - builds the (optional) swarm primer string injected into the
 * system prompt to teach the agent how to use the swarm toolkit effectively.
 *
 * Pure function of config: no side effects, no pi API imports, no file or
 * network I/O. Returns '' when the `swarmPrimer` flag is falsy, so callers can
 * always concatenate the result without a guard.
 *
 * The `swarmPrimer` and `delegationMode` flags are read defensively via a cast,
 * so this module compiles whether or not those fields are declared on
 * `SwarmConfig` yet (a parallel task adds them). They are read at runtime
 * either way.
 */

import type { SwarmConfig } from "./types.ts";

/**
 * Build the swarm primer injected into the system prompt when `swarmPrimer` is
 * enabled. The primer is a tight (~300-word) overview of the swarm tools plus a
 * short "how to use it well" section. When `delegationMode` is also enabled, a
 * short DELEGATOR MODE paragraph is appended telling the main agent to keep
 * design decisions in-thread and push concrete implementation to cheaper
 * sub-agents.
 *
 * Returns an empty string when `swarmPrimer` is falsy. Access to `swarmPrimer`
 * and `delegationMode` is defensive (cast, not destructured) so this file does
 * not depend on `SwarmConfig` declaring those fields.
 */
export function buildSwarmPrimer(config: SwarmConfig): string {
	const primerOn = (config as { swarmPrimer?: boolean }).swarmPrimer === true;
	const delegator = (config as { delegationMode?: boolean }).delegationMode === true;
	const tdd = (config as { tddMode?: boolean }).tddMode === true;

	if (!primerOn) return "";

	const primer = `Swarm delegation toolkit — you can parallelize work across isolated sub-agents.

You spawn sub-agents that run as separate isolated pi subprocesses, each with its own context window. They do work in parallel and report results back to you. Use these tools:

- swarm_spawn: delegate one or more sub-tasks to isolated sub-agents. The core primitive — fan out independent work.
- swarm_orchestrate: auto-decompose a big goal into validated parallel chunks, run by a planner / workers / reviewer / synthesizer. Good when you want the swarm to plan itself.
- swarm_workflow: declarative multi-stage map / reduce / chain with barriers between stages. Good for fixed pipelines.
- swarm_status / swarm_await / swarm_result: check what is running / block-wait for tasks to finish / collect finished work into your context.
- swarm_cancel: stop one or more running tasks.
- swarm_watch: register a non-blocking wake-up so you can END YOUR TURN and be reactivated when the work finishes or on a timer. This is how you avoid blocking.
- swarm_rechunk: stop a task that is overrunning its estimate and split its remaining work across a fresh parallel swarm.
- swarm_schedule: recurring cron-like tasks, scoped to this session.

How to use it well:
- Break big tasks into manageable chunks before spawning. One focused sub-task per spawn beats one giant prompt.
- Parallelize INDEPENDENT pieces with swarm_spawn, but order DEPENDENT steps carefully — use swarm_workflow stages or orchestrate dependsOn so later work sees earlier output.
- Track multi-step work with the todo tool so you and the user can see progress.
- For long-running work, PREFER async swarm_spawn plus swarm_watch, then end your turn. Do NOT block on swarm_await for long jobs — it ties up your turn.
- When you are re-activated after a watch, run swarm_status and actually review and VALIDATE outputs before declaring the work done.
- If a task has grown more complex than expected or gone off-rails, use swarm_rechunk to stop it and split the remaining work.
- Sub-agents cost money and context. Spawn only what you need, and pick the cheapest model that can do the job.

HARD SAFETY RULE — analyzing binaries/drivers/installers: extract and statically analyze ONLY (7z / innoextract unzip, capstone / PE disassembly, Authenticode/signature checks, string/import scans). NEVER execute an installer, NEVER load or install a kernel driver, NEVER run a harvested .exe / .msi / .cab / setup, and NEVER call sc create / pnputil / Start-Process on an installer / NtLoadDriver / ZwLoadDriver / CreateService. Headless-browser scraping (Playwright etc.) to fetch pages/downloads is fine; running the downloaded installer is not.`;

	let out = primer;

	if (delegator) {
		out += `

DELEGATOR MODE: You (the main agent) make the larger-scale architecture and decision calls and keep them in-thread. Push concrete implementation chunks to swarm_spawn using a cheaper \`model\` override so the sub-agents act as cheaper implementers. Review and integrate their output yourself. Do not let sub-agents make design decisions — they implement against your spec.`;
	}

	if (tdd) {
		out += `

TDD MODE — verify, don't assume. This mode opts you INTO running tests as you go, which overrides the default no-test-unless-asked posture for this session.

Maintain a test harness: a command that exits non-zero on failure. If none exists, create a minimal one (a script that exercises the cases and exits non-zero on the first failure) — don't assume a framework is present. Track four buckets of cases: standard / should-succeed, should-fail (assert the code rejects or errors as expected), edge, and regression (a case for each behavior you've already fixed, so it stays fixed). Run the harness after each meaningful change and read the ACTUAL exit code and output — no "this should work." If it's red, fix before moving on; keep it green as you go. For a new feature, write the failing test first (red), then implement until green. You may swarm_spawn a separate agent to write the failing test in parallel with planning the implementation.

Audit agents (occasional, not every change): once a feature lands and the harness is green, you MAY spawn a one-off audit sub-agent with a SINGLE focused mandate — security (use agent: "redteam"), OR deduplication, OR performance, OR clarity/quality — never a vague "review everything." The auditor reports findings only; YOU decide and implement the fixes (keep decisions in-thread). Don't audit on every change — it's wasteful.`;
	}

	return out;
}

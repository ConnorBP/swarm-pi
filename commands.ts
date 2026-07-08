/**
 * Human-facing slash commands.
 *
 *   /swarm            - show the live dashboard of tasks and jobs
 *   /swarm-cancel     - cancel a task/job/all
 *   /swarm-agents     - list available agent profiles
 *   /swarm-clear      - drop finished tasks/jobs from the registry
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { renderDashboard, type ThemeLike } from "./render.ts";
import type { SwarmRuntime } from "./runtime.ts";

export function registerCommands(pi: ExtensionAPI, rt: SwarmRuntime): void {
	// Renderer for the live dashboard (reads current registry state at render time).
	pi.registerMessageRenderer("swarm-report", (_message, options, theme) => {
		return renderDashboard(rt.runner.list(), rt.groups.list(), theme as unknown as ThemeLike, Boolean(options.expanded));
	});

	// Renderer for plain markdown notes.
	pi.registerMessageRenderer("swarm-note", (message, _options, _theme) => {
		return new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("swarm", {
		description: "Show the swarm dashboard (tasks and jobs)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				pi.sendMessage({ customType: "swarm-report", content: "swarm dashboard", display: true });
			} else {
				const tasks = rt.runner.list();
				ctx.ui.notify(`swarm: ${tasks.length} tasks, ${rt.groups.list().length} jobs`, "info");
			}
		},
	});

	pi.registerCommand("swarm-cancel", {
		description: "Cancel swarm tasks: /swarm-cancel <taskId|jobId|all>",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "all", label: "all" },
				...rt.runner.list().filter((t) => t.status === "running" || t.status === "queued").map((t) => ({ value: t.id, label: `${t.id} (${t.label})` })),
				...rt.groups.list().filter((g) => g.status === "running").map((g) => ({ value: g.id, label: `${g.id} (${g.kind})` })),
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const target = args.trim();
			let n = 0;
			if (!target || target === "all") {
				n = rt.runner.cancelAll();
			} else if (target.startsWith("g")) {
				const g = rt.groups.get(target);
				for (const id of g?.taskIds ?? []) if (rt.runner.cancel(id)) n++;
			} else {
				if (rt.runner.cancel(target)) n++;
			}
			ctx.ui.notify(`Cancelled ${n} task(s).`, n > 0 ? "info" : "warning");
		},
	});

	pi.registerCommand("swarm-agents", {
		description: "List available agent profiles",
		handler: async (_args, ctx) => {
			const discovery = rt.getDiscovery(rt.config.defaultAgentScope);
			if (discovery.profiles.length === 0) {
				ctx.ui.notify("No agent profiles found.", "warning");
				return;
			}
			const lines = ["# Swarm agent profiles", ""];
			for (const p of discovery.profiles) {
				const bits = [p.model ? `model: ${p.model}` : "model: (inherit)"];
				if (p.tools) bits.push(`tools: ${p.tools.join(", ")}`);
				lines.push(`- **${p.name}** _(${p.source})_ - ${p.description}`);
				lines.push(`  - ${bits.join(" · ")}`);
			}
			if (discovery.projectAgentsDir) lines.push("", `Project agents dir: \`${discovery.projectAgentsDir}\``);
			pi.sendMessage({ customType: "swarm-note", content: lines.join("\n"), display: true });
		},
	});

	pi.registerCommand("swarm-clear", {
		description: "Remove finished tasks and jobs from the swarm registry",
		handler: async (_args, ctx) => {
			const active = rt.runner.activeCount() + rt.groups.activeCount();
			const tasks = rt.runner.clearFinished();
			const groups = rt.groups.clearFinished();
			rt.store.prune(
				(r) => r.status === "running" || r.status === "queued",
				(g) => g.status === "running",
			);
			rt.refreshUI();
			ctx.ui.notify(`Cleared ${tasks} task(s) and ${groups} job(s). ${active} still active.`, "info");
		},
	});
}

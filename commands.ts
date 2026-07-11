/**
 * Human-facing slash commands.
 *
 *   /swarm            - show the live dashboard of tasks and jobs
 *   /swarm-config     - interactive menu to pick a model per agent type
 *   /swarm-cancel     - cancel a task/job/all
 *   /swarm-agents     - list available agent profiles and their models
 *   /swarm-clear      - drop finished tasks/jobs from the registry
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DynamicBorder, getAgentDir, getMarkdownTheme, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { saveUserConfig } from "./config.ts";
import { renderDashboard, type ThemeLike } from "./render.ts";
import type { SwarmRuntime } from "./runtime.ts";
import { ModelSelectSubmenu } from "./settings_ui.ts";
import type { ScheduleAction } from "./types.ts";
import { formatDuration, formatInterval, parseDuration } from "./util.ts";

export function registerCommands(pi: ExtensionAPI, rt: SwarmRuntime): void {
	// Renderer for the live dashboard (reads current registry state at render time).
	pi.registerMessageRenderer("swarm-report", (_message, options, theme) => {
		return renderDashboard(rt.runner.list(), rt.groups.list(), theme as unknown as ThemeLike, Boolean(options.expanded));
	});

	// Renderer for plain markdown notes.
	pi.registerMessageRenderer("swarm-note", (message, _options, _theme) => {
		return new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme());
	});

	// Renderer for wake-up / re-activation messages injected when watched work finishes.
	pi.registerMessageRenderer("swarm-wake", (message, _options, _theme) => {
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
			const lines = ["# Swarm agent profiles", "", "_Set models per agent with `/swarm-config`._", ""];
			for (const p of discovery.profiles) {
				const override = rt.config.agentModels[p.name];
				const effective = override || p.model || rt.config.defaultModel || "(inherit active model)";
				const src = override ? "config" : p.model ? "profile" : rt.config.defaultModel ? "default" : "inherit";
				const bits = [`model: ${effective} (${src})`];
				if (p.tools) bits.push(`tools: ${p.tools.join(", ")}`);
				lines.push(`- **${p.name}** _(${p.source})_ - ${p.description}`);
				lines.push(`  - ${bits.join(" · ")}`);
			}
			if (discovery.projectAgentsDir) lines.push("", `Project agents dir: \`${discovery.projectAgentsDir}\``);
			pi.sendMessage({ customType: "swarm-note", content: lines.join("\n"), display: true });
		},
	});

	pi.registerCommand("swarm-config", {
		description: "Configure swarm models per agent and general settings (interactive)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/swarm-config requires interactive mode.", "warning");
				return;
			}

			const registryModels = await getRegistryModels(ctx);
			const extraModelIds = getEnabledModelIds();

			const persist = () => {
				saveUserConfig({
					defaultModel: rt.config.defaultModel,
					agentModels: rt.config.agentModels,
					maxConcurrency: rt.config.maxConcurrency,
					defaultAgentScope: rt.config.defaultAgentScope,
					widget: rt.config.widget,
					notifyOnComplete: rt.config.notifyOnComplete,
					countSubagentCost: rt.config.countSubagentCost,
					escalation: rt.config.escalation,
					escalationFactor: rt.config.escalationFactor,
					allowModelScheduling: rt.config.allowModelScheduling,
					logEvents: rt.config.logEvents,
					retentionDays: rt.config.retentionDays,
					maxSessions: rt.config.maxSessions,
				});
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const cfg = rt.config;
				const discovery = rt.getDiscovery(cfg.defaultAgentScope);

				const modelItem = (id: string, label: string, current: string): SettingItem => ({
					id,
					label,
					currentValue: current || "(inherit)",
					submenu: (currentVal, itemDone) =>
						new ModelSelectSubmenu({
							title: label,
							currentValue: currentVal === "(inherit)" ? "" : currentVal,
							theme,
							registryModels,
							extraModelIds,
							onSelect: (value) => itemDone(value || "(inherit)"),
							onCancel: () => itemDone(),
						}),
				});

				const items: SettingItem[] = [
					modelItem("model:__default__", "Default model (no-profile tasks)", cfg.defaultModel),
					...discovery.profiles.map((p) => modelItem(`model:${p.name}`, `Agent: ${p.name}`, cfg.agentModels[p.name] ?? "")),
					{
						id: "maxConcurrency",
						label: "Max concurrency",
						currentValue: String(cfg.maxConcurrency),
						values: ["1", "2", "3", "4", "6", "8", "12", "16"],
					},
					{
						id: "defaultAgentScope",
						label: "Agent scope",
						currentValue: cfg.defaultAgentScope,
						values: ["user", "project", "both"],
					},
					{ id: "widget", label: "Status widget", currentValue: cfg.widget ? "true" : "false", values: ["true", "false"] },
					{
						id: "notifyOnComplete",
						label: "Notify on completion",
						currentValue: cfg.notifyOnComplete ? "true" : "false",
						values: ["true", "false"],
					},
					{
						id: "countSubagentCost",
						label: "Count sub-agent cost in session $",
						currentValue: cfg.countSubagentCost ? "true" : "false",
						values: ["true", "false"],
					},
					{ id: "escalation", label: "Overrun escalation", currentValue: cfg.escalation, values: ["off", "notify", "auto"] },
					{
						id: "escalationFactor",
						label: "Escalate at (x estimate)",
						currentValue: String(cfg.escalationFactor),
						values: ["1.5", "2", "3", "4"],
					},
					{
						id: "allowModelScheduling",
						label: "Let model manage schedules",
						currentValue: cfg.allowModelScheduling ? "true" : "false",
						values: ["true", "false"],
					},
					{
						id: "logEvents",
						label: "Raw event log (debug, multi-GB)",
						currentValue: cfg.logEvents ? "true" : "false",
						values: ["true", "false"],
					},
					{
						id: "retentionDays",
						label: "Session retention (days, 0=all)",
						currentValue: String(cfg.retentionDays),
						values: ["0", "1", "3", "7", "14", "30"],
					},
					{
						id: "maxSessions",
						label: "Max sessions kept (0=all)",
						currentValue: String(cfg.maxSessions),
						values: ["0", "3", "5", "10", "20"],
					},
				];

				const onChange = (id: string, value: string) => {
					if (id === "model:__default__") {
						rt.config.defaultModel = value === "(inherit)" ? "" : value;
					} else if (id.startsWith("model:")) {
						const agent = id.slice("model:".length);
						if (!value || value === "(inherit)") delete rt.config.agentModels[agent];
						else rt.config.agentModels[agent] = value;
					} else if (id === "maxConcurrency") {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) rt.config.maxConcurrency = Math.max(1, Math.min(32, n));
					} else if (id === "defaultAgentScope") {
						if (value === "user" || value === "project" || value === "both") rt.config.defaultAgentScope = value;
					} else if (id === "widget") {
						rt.config.widget = value === "true";
					} else if (id === "notifyOnComplete") {
						rt.config.notifyOnComplete = value === "true";
					} else if (id === "countSubagentCost") {
						rt.config.countSubagentCost = value === "true";
					} else if (id === "escalation") {
						if (value === "off" || value === "notify" || value === "auto") rt.config.escalation = value;
					} else if (id === "escalationFactor") {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 1.1) rt.config.escalationFactor = n;
					} else if (id === "allowModelScheduling") {
						rt.config.allowModelScheduling = value === "true";
					} else if (id === "logEvents") {
						rt.config.logEvents = value === "true";
					} else if (id === "retentionDays") {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) rt.config.retentionDays = Math.max(0, Math.min(365, n));
					} else if (id === "maxSessions") {
						const n = Number.parseInt(value, 10);
						if (Number.isFinite(n)) rt.config.maxSessions = Math.max(0, Math.min(100, n));
					} else {
						return;
					}
					persist();
					rt.refreshUI();
				};

				const baseTheme = getSettingsListTheme();
				const settingsTheme = {
					...baseTheme,
					hint: (text: string) => baseTheme.hint(text.replace(/Esc to cancel/g, "Esc to close")),
				};

				const container = new Container();
				container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
				const settingsList = new SettingsList(items, Math.min(items.length + 2, 14), settingsTheme, onChange, () => done(undefined));
				container.addChild(settingsList);
				container.addChild(new DynamicBorder((s) => theme.fg("border", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.registerCommand("swarm-cron", {
		description: "Manage recurring scheduled swarm tasks: /swarm-cron [list|add|remove|enable|disable|run] ...",
		getArgumentCompletions: (prefix: string) => {
			const first = prefix.split(/\s+/)[0] ?? "";
			if (!prefix.includes(" ")) {
				const verbs = ["list", "add", "remove", "enable", "disable", "run"].map((v) => ({ value: v, label: v }));
				const filtered = verbs.filter((v) => v.value.startsWith(first));
				return filtered.length > 0 ? filtered : null;
			}
			const verb = first.toLowerCase();
			if (["remove", "enable", "disable", "run"].includes(verb)) {
				const ids = rt.scheduler.list().map((s) => ({ value: `${verb} ${s.id}`, label: `${s.id} (${s.name})` }));
				return ids.length > 0 ? ids : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] || "list").toLowerCase();

			if (verb === "list" || verb === "") {
				pi.sendMessage({ customType: "swarm-note", content: cronMarkdown(rt), display: true });
				return;
			}
			if (verb === "add") {
				const interval = parts[1];
				const type = (parts[2] || "").toLowerCase();
				const rest = parts.slice(3).join(" ").trim();
				const everyMs = interval ? parseDuration(interval) : undefined;
				if (!everyMs) {
					ctx.ui.notify('Usage: /swarm-cron add <interval e.g. 30m|2h|1d> <spawn|orchestrate|prompt> <text...>', "warning");
					return;
				}
				if (!["spawn", "orchestrate", "prompt"].includes(type) || !rest) {
					ctx.ui.notify("Usage: /swarm-cron add <interval> <spawn|orchestrate|prompt> <text...>", "warning");
					return;
				}
				let action: ScheduleAction;
				if (type === "spawn") action = { type: "spawn", task: rest, agent: "worker" };
				else if (type === "orchestrate") action = { type: "orchestrate", goal: rest };
				else action = { type: "prompt", text: rest };
				const name = rest.length > 40 ? `${rest.slice(0, 40)}...` : rest;
				const rec = rt.scheduler.add({ name, everyMs, action, createdBy: "user" });
				ctx.ui.notify(`Created ${rec.id} "${name}" every ${formatInterval(everyMs)} (${type}).`, "info");
				return;
			}

			const id = parts[1];
			if (!id) {
				ctx.ui.notify(`/swarm-cron ${verb} needs a schedule id.`, "warning");
				return;
			}
			if (verb === "remove") ctx.ui.notify(rt.scheduler.remove(id) ? `Removed ${id}.` : `Unknown ${id}.`, "info");
			else if (verb === "enable") ctx.ui.notify(rt.scheduler.setEnabled(id, true) ? `Enabled ${id}.` : `Unknown ${id}.`, "info");
			else if (verb === "disable") ctx.ui.notify(rt.scheduler.setEnabled(id, false) ? `Disabled ${id}.` : `Unknown ${id}.`, "info");
			else if (verb === "run") ctx.ui.notify(rt.scheduler.runNow(id) ? `Ran ${id} now.` : `Unknown ${id}.`, "info");
			else ctx.ui.notify(`Unknown /swarm-cron verb "${verb}".`, "warning");
		},
	});

	pi.registerCommand("swarm-stats", {
		description: "Show the learned complexity -> duration model and schedules",
		handler: async (_args, _ctx) => {
			pi.sendMessage({ customType: "swarm-note", content: statsMarkdown(rt), display: true });
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

/** Model objects with valid credentials (best effort; registry may be sync or async). */
async function getRegistryModels(
	ctx: ExtensionCommandContext,
): Promise<Array<{ provider?: string; id?: string; name?: string }>> {
	try {
		const registry = ctx.modelRegistry as { getAvailable?: () => unknown } | undefined;
		if (registry?.getAvailable) {
			const raw = registry.getAvailable();
			const arr = (Array.isArray(raw) ? raw : ((await raw) as unknown[] | undefined)) ?? [];
			return (arr as Array<Record<string, unknown>>).map((m) => ({
				provider: typeof m.provider === "string" ? m.provider : undefined,
				id: typeof m.id === "string" ? m.id : undefined,
				name: typeof m.name === "string" ? m.name : undefined,
			}));
		}
	} catch {
		// ignore
	}
	return [];
}

/** Curated "provider/id" model ids from settings.json enabledModels. */
function getEnabledModelIds(): string[] {
	try {
		const raw = fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8");
		const settings = JSON.parse(raw) as { enabledModels?: unknown };
		if (Array.isArray(settings.enabledModels)) {
			return settings.enabledModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
		}
	} catch {
		// ignore
	}
	return [];
}

function cronMarkdown(rt: SwarmRuntime): string {
	const schedules = rt.scheduler.list();
	const lines = ["# Swarm schedules", "", "_Manage with `/swarm-cron [add|remove|enable|disable|run]`._", ""];
	if (schedules.length === 0) {
		lines.push("No schedules yet. Example: `/swarm-cron add 2h orchestrate Review recent git changes and summarize risks`.");
	} else {
		for (const s of schedules) {
			const state = s.enabled ? "on" : "off";
			const detail = s.action.type === "prompt" ? s.action.text : s.action.type === "orchestrate" ? s.action.goal : s.action.task;
			lines.push(`- **${s.id}** [${state}] every ${formatInterval(s.everyMs)} - ${s.action.type} _(${s.createdBy})_`);
			lines.push(`  - ${String(detail).slice(0, 100)}`);
			if (s.lastRunAt) lines.push(`  - ${s.runCount} run(s) so far`);
		}
	}
	lines.push("", "_Schedules fire only while pi is running (no background daemon)._");
	return lines.join("\n");
}

function statsMarkdown(rt: SwarmRuntime): string {
	const rows = rt.complexity.table();
	const lines = [
		"# Swarm complexity model",
		"",
		"How long tasks of each estimated complexity actually take (used to size callbacks and overrun escalation):",
		"",
	];
	if (rows.length === 0) {
		lines.push("No data yet. Pass a `complexity` (0-10) when spawning/orchestrating and durations get learned here.");
	} else {
		lines.push("| complexity | samples | mean | min | max | last |");
		lines.push("|---:|---:|---:|---:|---:|---:|");
		for (const r of rows) {
			lines.push(
				`| ${r.complexity} | ${r.count} | ${formatDuration(Math.round(r.meanMs))} | ${formatDuration(Math.round(r.minMs))} | ${formatDuration(Math.round(r.maxMs))} | ${formatDuration(Math.round(r.lastMs))} |`,
			);
		}
	}
	const schedules = rt.scheduler.list();
	lines.push("", `**Schedules:** ${schedules.length} (${schedules.filter((s) => s.enabled).length} enabled). See \`/swarm-cron\`.`);
	return lines.join("\n");
}

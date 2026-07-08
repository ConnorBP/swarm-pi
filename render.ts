/**
 * Rendering helpers: task rows, dashboard, live widget, tool-result views.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { GroupRecord, TaskRecord } from "./types.ts";
import { formatDuration, formatTokens, formatUsage, statusIcon } from "./util.ts";

export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

function shorten(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function statusColor(status: string): string {
	switch (status) {
		case "succeeded":
			return "success";
		case "failed":
			return "error";
		case "running":
			return "warning";
		case "cancelled":
		case "detached":
			return "muted";
		default:
			return "dim";
	}
}

/** One compact line summarizing a task. */
export function taskLine(record: TaskRecord, theme: ThemeLike): string {
	const color = statusColor(record.status);
	const icon = theme.fg(color, statusIcon(record.status));
	const id = theme.fg("muted", record.id.padEnd(4));
	const label = theme.fg("accent", (record.label || record.agent || "task").padEnd(14).slice(0, 14));
	let line = `${id}${icon} ${label}`;

	if (record.status === "running" && record.startedAt) {
		line += theme.fg("dim", ` ${formatDuration(Date.now() - record.startedAt)}`);
	} else if (record.endedAt && record.startedAt) {
		line += theme.fg("dim", ` ${formatDuration(record.endedAt - record.startedAt)}`);
	}
	if (record.usage.cost) line += theme.fg("dim", ` $${record.usage.cost.toFixed(4)}`);
	if (record.usage.output) line += theme.fg("dim", ` ↓${formatTokens(record.usage.output)}`);

	if (record.status === "failed" && record.errorMessage) {
		line += theme.fg("error", ` ${shorten(record.errorMessage, 50)}`);
	} else {
		const preview = record.output || record.task;
		line += theme.fg("dim", `  ${shorten(preview, 46)}`);
	}
	return line;
}

export function groupLine(record: GroupRecord, theme: ThemeLike): string {
	const color = record.status === "running" ? "warning" : record.status === "succeeded" ? "success" : "error";
	const icon = theme.fg(color, statusIcon(record.status === "running" ? "running" : record.status === "succeeded" ? "succeeded" : "failed"));
	const id = theme.fg("muted", record.id.padEnd(4));
	const kind = theme.fg("toolTitle", theme.bold(record.kind.padEnd(11)));
	let line = `${id}${icon} ${kind} ${theme.fg("dim", shorten(record.goal, 40))}`;
	if (record.note) line += theme.fg("muted", `  [${record.note}]`);
	return line;
}

/** Build the dashboard as a Component (used by the /swarm message renderer). */
export function renderDashboard(tasks: TaskRecord[], groups: GroupRecord[], theme: ThemeLike, expanded: boolean): Container {
	const container = new Container();
	const running = tasks.filter((t) => t.status === "running").length;
	const queued = tasks.filter((t) => t.status === "queued").length;
	const ok = tasks.filter((t) => t.status === "succeeded").length;
	const failed = tasks.filter((t) => t.status === "failed").length;
	const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

	let header = theme.fg("toolTitle", theme.bold("swarm dashboard "));
	header += theme.fg("dim", `${tasks.length} tasks  `);
	if (running) header += theme.fg("warning", `${running}▶ `);
	if (queued) header += theme.fg("dim", `${queued}◔ `);
	if (ok) header += theme.fg("success", `${ok}✓ `);
	if (failed) header += theme.fg("error", `${failed}✗ `);
	if (cost) header += theme.fg("dim", `$${cost.toFixed(4)}`);
	container.addChild(new Text(header, 0, 0));

	if (groups.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Jobs:"), 0, 0));
		for (const g of groups.slice(-12)) container.addChild(new Text(groupLine(g, theme), 0, 0));
	}

	if (tasks.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Tasks:"), 0, 0));
		const shown = expanded ? tasks : tasks.slice(-20);
		if (!expanded && tasks.length > 20) {
			container.addChild(new Text(theme.fg("muted", `... ${tasks.length - 20} earlier`), 0, 0));
		}
		for (const t of shown) container.addChild(new Text(taskLine(t, theme), 0, 0));
	}

	if (tasks.length === 0 && groups.length === 0) {
		container.addChild(new Text(theme.fg("dim", "No swarm activity yet. Use swarm_spawn or swarm_orchestrate."), 0, 0));
	}
	return container;
}

/** Live widget lines (above editor). Empty array clears the widget. */
export function widgetLines(tasks: TaskRecord[], groups: GroupRecord[], theme: ThemeLike): string[] {
	const running = tasks.filter((t) => t.status === "running").length;
	const queued = tasks.filter((t) => t.status === "queued").length;
	const activeGroups = groups.filter((g) => g.status === "running");
	if (running === 0 && queued === 0 && activeGroups.length === 0) return [];

	const ok = tasks.filter((t) => t.status === "succeeded").length;
	const failed = tasks.filter((t) => t.status === "failed").length;
	const cost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

	let line = theme.fg("accent", "swarm ");
	if (running) line += theme.fg("warning", `${running}▶ `);
	if (queued) line += theme.fg("dim", `${queued}◔ `);
	if (ok) line += theme.fg("success", `${ok}✓ `);
	if (failed) line += theme.fg("error", `${failed}✗ `);
	if (cost) line += theme.fg("dim", `$${cost.toFixed(4)}`);

	const lines = [line];
	for (const g of activeGroups.slice(0, 3)) {
		lines.push(theme.fg("dim", `  ${g.kind} ${g.id}: ${g.note ?? "running"}`));
	}
	return lines;
}

/** Render a single task result for a tool renderResult slot. */
export function renderTaskResult(record: TaskRecord, theme: ThemeLike, expanded: boolean): Container {
	const container = new Container();
	const color = statusColor(record.status);
	let header = `${theme.fg(color, statusIcon(record.status))} `;
	header += theme.fg("toolTitle", theme.bold(record.label || record.agent || record.id));
	if (record.agent) header += theme.fg("muted", ` (${record.agent})`);
	header += theme.fg("muted", `  ${record.id}`);
	container.addChild(new Text(header, 0, 0));

	if (record.status === "failed" && record.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${shorten(record.errorMessage, expanded ? 400 : 100)}`), 0, 0));
	}

	if (expanded && record.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(record.output.trim(), 0, 0, getMarkdownTheme()));
	} else if (record.output) {
		container.addChild(new Text(theme.fg("toolOutput", shorten(record.output, 200)), 0, 0));
	}

	const usage = formatUsage(record.usage, record.model);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
	return container;
}

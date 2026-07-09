/**
 * Small pure helpers shared across the swarm extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { DisplayToolCall, UsageStats } from "./types.ts";

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(a: UsageStats, b: UsageStats): UsageStats {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		contextTokens: Math.max(a.contextTokens, b.contextTokens),
		turns: a.turns + b.turns,
	};
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m${rem ? ` ${rem}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/** Extract the final assistant text from a list of captured messages. */
export function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const texts: string[] = [];
			for (const part of msg.content) {
				if (part.type === "text") texts.push(part.text);
			}
			if (texts.length > 0) return texts.join("\n").trim();
		}
	}
	return "";
}

export function collectToolCalls(messages: Message[]): DisplayToolCall[] {
	const calls: DisplayToolCall[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") {
				calls.push({ name: part.name, args: (part.arguments ?? {}) as Record<string, unknown> });
			}
		}
	}
	return calls;
}

/** Cap a string to `maxBytes` UTF-8 bytes, appending a truncation notice. */
export function capBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Use swarm_result with full=true for the complete output.]`;
}

/**
 * Substitute {key} placeholders in a template. Unknown placeholders are left intact.
 * `vars` values are coerced to strings.
 */
export function fillTemplate(template: string, vars: Record<string, string | number | undefined>): string {
	return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key: string) => {
		const value = vars[key];
		if (value === undefined) return match;
		return String(value);
	});
}

/**
 * Best-effort extraction of a JSON value (array or object) from free-form model text.
 * Handles ```json fenced blocks and bare JSON. Returns undefined if nothing parses.
 */
export function extractJson<T = unknown>(text: string): T | undefined {
	const trimmed = text.trim();

	// 1. Fenced code block ```json ... ``` or ``` ... ```
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates: string[] = [];
	if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
	candidates.push(trimmed);

	for (const candidate of candidates) {
		const direct = tryParse<T>(candidate);
		if (direct !== undefined) return direct;

		// 2. Slice from the first bracket to the last matching bracket.
		for (const [open, close] of [
			["[", "]"],
			["{", "}"],
		] as const) {
			const start = candidate.indexOf(open);
			const end = candidate.lastIndexOf(close);
			if (start >= 0 && end > start) {
				const sliced = candidate.slice(start, end + 1);
				const parsed = tryParse<T>(sliced);
				if (parsed !== undefined) return parsed;
			}
		}
	}
	return undefined;
}

function tryParse<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** Run async work over items with a bounded number of concurrent workers. */
export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = next++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Parse a human duration like "45s", "30m", "2h", "1d", "90" (bare = minutes),
 * or "1500ms" into milliseconds. Returns undefined if it cannot be parsed.
 */
export function parseDuration(text: string): number | undefined {
	const trimmed = text.trim().toLowerCase();
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	switch (match[2]) {
		case "ms":
			return value;
		case "s":
			return value * 1000;
		case "h":
			return value * 60 * 60 * 1000;
		case "d":
			return value * 24 * 60 * 60 * 1000;
		default:
			// bare number or "m" -> minutes
			return value * 60 * 1000;
	}
}

/** Format a millisecond interval as a compact human string ("2h", "30m"). */
export function formatInterval(ms: number): string {
	if (ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)}d`;
	if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
	if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

export function statusIcon(status: string): string {
	switch (status) {
		case "queued":
			return "◔";
		case "running":
			return "▶";
		case "succeeded":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
		case "detached":
			return "⚑";
		default:
			return "•";
	}
}

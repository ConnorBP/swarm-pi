/**
 * Swarm configuration loading.
 *
 * Precedence (later overrides earlier):
 *   1. built-in defaults
 *   2. <extension>/config.json
 *   3. ~/.pi/agent/swarm/config.json
 *   4. <cwd>/.pi/swarm.json  (only when the project is trusted)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SwarmConfig } from "./types.ts";

export const DEFAULT_CONFIG: SwarmConfig = {
	defaultModel: "",
	agentModels: {},
	maxConcurrency: 4,
	maxSpawnBatch: 16,
	defaultAgentScope: "user",
	perTaskOutputCap: 16 * 1024,
	widget: true,
	notifyOnComplete: false,
	confirmProjectAgents: true,
	agentDirs: [],
};

/** Root directory for swarm state under the agent config dir. */
export function swarmStateRoot(): string {
	return path.join(getAgentDir(), "swarm");
}

function readJsonIfExists(file: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(file)) return undefined;
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		// Ignore malformed config; fall through to defaults.
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base: SwarmConfig, override: Record<string, unknown> | undefined): SwarmConfig {
	if (!override) return base;
	const next: SwarmConfig = { ...base };
	for (const key of Object.keys(base) as Array<keyof SwarmConfig>) {
		if (override[key] === undefined) continue;
		const value = override[key];
		if (Array.isArray(base[key])) {
			if (Array.isArray(value)) (next[key] as unknown) = value;
		} else if (isPlainObject(base[key])) {
			// Nested maps (e.g. agentModels) merge key-by-key, coercing string values.
			if (isPlainObject(value)) {
				const merged: Record<string, string> = { ...(base[key] as Record<string, string>) };
				for (const [k, v] of Object.entries(value)) {
					if (typeof v === "string") merged[k] = v;
				}
				(next[key] as unknown) = merged;
			}
		} else if (typeof base[key] === typeof value) {
			(next[key] as unknown) = value;
		}
	}
	return next;
}

export interface LoadConfigOptions {
	extensionDir: string;
	cwd: string;
	projectTrusted: boolean;
}

export function loadConfig(options: LoadConfigOptions): SwarmConfig {
	let config = { ...DEFAULT_CONFIG };
	config = mergeConfig(config, readJsonIfExists(path.join(options.extensionDir, "config.json")));
	config = mergeConfig(config, readJsonIfExists(path.join(swarmStateRoot(), "config.json")));
	if (options.projectTrusted) {
		config = mergeConfig(config, readJsonIfExists(path.join(options.cwd, CONFIG_DIR_NAME, "swarm.json")));
	}

	// Sanity clamps.
	config.maxConcurrency = clampInt(config.maxConcurrency, 1, 32, DEFAULT_CONFIG.maxConcurrency);
	config.maxSpawnBatch = clampInt(config.maxSpawnBatch, 1, 64, DEFAULT_CONFIG.maxSpawnBatch);
	config.perTaskOutputCap = clampInt(config.perTaskOutputCap, 1024, 512 * 1024, DEFAULT_CONFIG.perTaskOutputCap);
	if (!["user", "project", "both"].includes(config.defaultAgentScope)) {
		config.defaultAgentScope = DEFAULT_CONFIG.defaultAgentScope;
	}
	// Ensure agentModels is an owned object (not shared with DEFAULT_CONFIG) so
	// in-memory edits from /swarm-config never mutate the module default.
	config.agentModels = isPlainObject(config.agentModels) ? { ...config.agentModels } : {};
	return config;
}

/**
 * Persist a partial config to the user-level file (~/.pi/agent/swarm/config.json),
 * merging with whatever is already there. Used by the /swarm-config settings menu.
 */
export function saveUserConfig(patch: Record<string, unknown>): void {
	const dir = swarmStateRoot();
	const file = path.join(dir, "config.json");
	try {
		fs.mkdirSync(dir, { recursive: true });
		const existing = readJsonIfExists(file) ?? {};
		const merged = { ...existing, ...patch };
		fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	} catch {
		// best effort; surfaced to the user by the caller if needed
	}
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(min, Math.min(max, n));
}

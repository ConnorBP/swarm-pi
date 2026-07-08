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

function mergeConfig(base: SwarmConfig, override: Record<string, unknown> | undefined): SwarmConfig {
	if (!override) return base;
	const next: SwarmConfig = { ...base };
	for (const key of Object.keys(base) as Array<keyof SwarmConfig>) {
		if (override[key] === undefined) continue;
		const value = override[key];
		// Only accept a value with the same primitive/array kind as the default.
		if (Array.isArray(base[key])) {
			if (Array.isArray(value)) (next[key] as unknown) = value;
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
	return config;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.max(min, Math.min(max, n));
}

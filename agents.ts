/**
 * Agent-profile discovery.
 *
 * Profiles are markdown files with frontmatter:
 *   ---
 *   name: worker
 *   description: General-purpose subagent
 *   tools: read, bash, edit, write   # optional, comma-separated
 *   model: provider/id               # optional; empty = inherit user default
 *   ---
 *   <system prompt body>
 *
 * Search order (later wins on name collision):
 *   1. profiles bundled with this extension (<extension>/agents)
 *   2. user profiles (~/.pi/agent/agents)
 *   3. project profiles (<cwd>/.pi/agents)   [only for scope project/both]
 *   4. extra dirs from config
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentProfile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

export interface AgentDiscovery {
	profiles: AgentProfile[];
	projectAgentsDir: string | null;
}

function loadFromDir(dir: string, source: AgentProfile["source"]): AgentProfile[] {
	const profiles: AgentProfile[] = [];
	if (!fs.existsSync(dir)) return profiles;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return profiles;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		profiles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return profiles;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface DiscoverOptions {
	extensionDir: string;
	cwd: string;
	scope: AgentScope;
	extraDirs?: string[];
}

export function discoverAgents(options: DiscoverOptions): AgentDiscovery {
	const { extensionDir, cwd, scope } = options;
	const builtinDir = path.join(extensionDir, "agents");
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const map = new Map<string, AgentProfile>();

	// Builtins are always available as a fallback layer.
	for (const p of loadFromDir(builtinDir, "builtin")) map.set(p.name, p);

	if (scope !== "project") {
		for (const p of loadFromDir(userDir, "user")) map.set(p.name, p);
	}
	if ((scope === "project" || scope === "both") && projectAgentsDir) {
		for (const p of loadFromDir(projectAgentsDir, "project")) map.set(p.name, p);
	}
	for (const dir of options.extraDirs ?? []) {
		for (const p of loadFromDir(dir, "user")) map.set(p.name, p);
	}

	return { profiles: Array.from(map.values()), projectAgentsDir };
}

export function findProfile(discovery: AgentDiscovery, name: string): AgentProfile | undefined {
	return discovery.profiles.find((p) => p.name === name);
}

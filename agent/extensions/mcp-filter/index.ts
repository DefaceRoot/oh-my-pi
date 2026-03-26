import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RolesConfigFile, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ─── Agent detection ────────────────────────────────────────────────────────

type KnownAgentPrompt = {
	name: string;
	body: string;
};

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".omp", "agent");
const SUBAGENT_ROLE_MARKER = "You are operating on a delegated sub-task.";
const SUBAGENT_DEFAULT_NAME = "_default";

let knownAgentPromptsPromise: Promise<KnownAgentPrompt[]> | undefined;

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized.trim();
	const endIndex = normalized.indexOf("\n---", 3);
	return endIndex === -1 ? normalized.trim() : normalized.slice(endIndex + 4).trim();
}

/** Collapse runs of blank lines to a single newline so prompt-rendering whitespace normalization doesn't break substring matching. */
function normalizeForMatching(text: string): string {
	return text.replace(/\n[ \t]*\n/g, "\n");
}

function detectAgentNameFromPrompt(systemPrompt: string, knownAgentPrompts: KnownAgentPrompt[]): string {
	const match = systemPrompt.match(/^name:\s*(\S+)/m);
	if (match) return match[1];
	if (!systemPrompt.includes(SUBAGENT_ROLE_MARKER)) return "default";
	const normalizedPrompt = normalizeForMatching(systemPrompt);
	const matchedAgent = knownAgentPrompts.find(
		({ body }) => body.length > 0 && normalizedPrompt.includes(normalizeForMatching(body)),
	);
	return matchedAgent?.name ?? SUBAGENT_DEFAULT_NAME;
}

async function loadKnownAgentPrompts(): Promise<KnownAgentPrompt[]> {
	if (!knownAgentPromptsPromise) {
		knownAgentPromptsPromise = (async () => {
			const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || DEFAULT_AGENT_DIR;
			const agentsDir = path.join(agentDir, "agents");
			try {
				const entries = await fs.readdir(agentsDir, { withFileTypes: true });
				const prompts = await Promise.all(
					entries
						.filter(entry => entry.isFile() && entry.name.endsWith(".md"))
						.map(async entry => {
							const fullPath = path.join(agentsDir, entry.name);
							const content = await fs.readFile(fullPath, "utf8");
							const metadataMatch = content.match(/^---\n([\s\S]*?)\n---/);
							const name = metadataMatch?.[1].match(/^name:\s*(\S+)/m)?.[1];
							if (!name) return undefined;
							const body = stripFrontmatter(content);
							return body.length > 0 ? { name, body } : undefined;
						}),
				);
				return prompts
					.filter((prompt): prompt is KnownAgentPrompt => prompt !== undefined)
					.sort((left, right) => right.body.length - left.body.length);
			} catch {
				return [];
			}
		})();
	}

	return knownAgentPromptsPromise;
}

/**
 * Detect orchestrator mode by checking session history for model_change entries.
 * When the parent session has an active worktree, the model role is "orchestrator".
 */
function isOrchestratorMode(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; role?: string };
		if (entry.type === "model_change") {
			return entry.role === "orchestrator";
		}
	}
	return false;
}

/**
 * Resolve the effective agent name. For parent sessions, distinguishes between
 * default mode and orchestrator mode.
 */
async function resolveAgent(systemPrompt: string, ctx: ExtensionContext): Promise<string> {
	const knownAgentPrompts = await loadKnownAgentPrompts();
	const name = detectAgentNameFromPrompt(systemPrompt, knownAgentPrompts);
	if (name === "default" && isOrchestratorMode(ctx)) {
		return "orchestrator";
	}
	return name;
}

// ─── MCP tool filtering ────────────────────────────────────────────────────

/**
 * Legacy MCP server allocation per agent.
 * Used only as a fallback when roles.yml cannot be loaded.
 */
const FALLBACK_AGENT_MCP_ALLOW: Record<string, string[] | null> = {
	default: ["mcp_augment_", "mcp_better_context_", "mcp_ref_"],
	orchestrator: ["mcp_augment_", "mcp_ref_"],
	implement: ["mcp_augment_", "mcp_ref_"],
	debug: ["mcp_augment_", "mcp_ref_", "mcp_chrome_devtools_"],
	"code-reviewer": ["mcp_augment_", "mcp_ref_"],
	designer: ["mcp_augment_", "mcp_chrome_devtools_", "mcp_ref_"],
	grafana: ["mcp_augment_", "mcp_chrome_devtools_", "mcp_grafana_", "mcp_ref_"],
	explore: ["mcp_augment_", "mcp_better_context_", "mcp_ref_"],
	research: ["mcp_augment_", "mcp_better_context_", "mcp_ref_"],
	"ask-explore": [],
	"ask-research": ["mcp_augment_", "mcp_ref_"],
	plan: ["mcp_augment_", "mcp_ref_"],
	lint: [],
	verifier: ["mcp_augment_", "mcp_ref_"],
	"plan-verifier": ["mcp_augment_", "mcp_chrome_devtools_", "mcp_ref_"],
	merge: [],
	curator: [],
	commit: ["mcp_augment_"],
	"worktree-setup": [],
};

const MAIN_ROLE_NAMES = new Set(["default", "orchestrator", "plan", "ask"]);

type RolesConfigEntry = {
	mcp?: unknown;
	skills?: unknown;
};

type RolesConfigShape = {
	roles?: Record<string, RolesConfigEntry>;
	subagents?: Record<string, RolesConfigEntry>;
};

function readMcpServers(entry: RolesConfigEntry | undefined): string[] | undefined {
	if (!entry) return undefined;
	if (!Array.isArray(entry.mcp)) return undefined;
	if (!entry.mcp.every(server => typeof server === "string")) return undefined;
	return [...entry.mcp];
}

function toMcpToolPrefix(server: string): string | undefined {
	const normalized = server
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (normalized.length === 0) return undefined;
	return `mcp_${normalized}_`;
}

function toMcpToolPrefixes(servers: readonly string[]): string[] {
	return servers.map(toMcpToolPrefix).filter((prefix): prefix is string => prefix !== undefined);
}

function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || DEFAULT_AGENT_DIR;
}

function resolveConfiguredMcpServers(agent: string): string[] | undefined {
	const rolesPath = path.join(resolveAgentDir(), "roles.yml");
	const loaded = RolesConfigFile.relocate(rolesPath).load();
	if (!loaded || typeof loaded !== "object") return undefined;
	const config = loaded as RolesConfigShape;

	if (MAIN_ROLE_NAMES.has(agent)) {
		return readMcpServers(config.roles?.[agent] ?? config.roles?.default);
	}

	const subagentServers = readMcpServers(config.subagents?.[agent]);
	if (subagentServers !== undefined) return subagentServers;

	const roleServers = readMcpServers(config.roles?.[agent]);
	if (roleServers !== undefined) return roleServers;

	if (agent in FALLBACK_AGENT_MCP_ALLOW) {
		return undefined;
	}

	const defaultSubagentServers = readMcpServers(config.subagents?._default);
	if (defaultSubagentServers !== undefined) return defaultSubagentServers;

	return readMcpServers(config.roles?.default);
}

const ALWAYS_ON_SERVER = "augment";

function normalizeConfiguredMcpServers(servers: readonly string[]): string[] {
	const unique = Array.from(new Set(servers.map(server => server.trim()).filter(server => server.length > 0)));
	if (unique.length === 0) return [];
	if (unique.includes(ALWAYS_ON_SERVER)) return unique;
	return [ALWAYS_ON_SERVER, ...unique];
}

function resolveMcpAllowlist(agent: string): string[] | null {
	const configuredServers = resolveConfiguredMcpServers(agent);
	if (configuredServers !== undefined) {
		return toMcpToolPrefixes(normalizeConfiguredMcpServers(configuredServers));
	}
	return FALLBACK_AGENT_MCP_ALLOW[agent] ?? FALLBACK_AGENT_MCP_ALLOW.default;
}

/**
 * Remove `<function>` blocks from the system prompt for MCP tools that
 * the current agent is not allowed to use.
 *
 * Each MCP tool is wrapped in:
 *   <function>{"description": "...", "name": "mcp_...", "parameters": {...}}</function>
 *
 * We match each block, extract the tool name, and keep only those whose
 * prefix appears in the agent's allowlist.
 */
function stripMcpTools(systemPrompt: string, allowed: string[] | null): string {
	// null = keep everything
	if (allowed === null) return systemPrompt;

	// Match each <function>...</function> block and check if it's an MCP tool
	return systemPrompt.replace(
		/<function>[\s\S]*?<\/function>\n?/g,
		match => {
			const nameMatch = match.match(/"name"\s*:\s*"([^"]+)"/);
			if (!nameMatch) return match; // keep non-parseable blocks
			const toolName = nameMatch[1];

			// Only filter MCP tools (name starts with mcp_)
			if (!toolName.startsWith("mcp_")) return match;

			// Empty allowlist = remove all MCP tools
			if (allowed.length === 0) return "";

			// Keep tool if its name starts with any allowed prefix
			const keep = allowed.some(prefix => toolName.startsWith(prefix));
			return keep ? match : "";
		},
	);
}

// ─── Skill filtering ───────────────────────────────────────────────────────

/**
 * Legacy skill allocation per agent.
 * `null`  = all skills (no filtering).
 * `[]`    = no skills (remove entire section).
 * string[] = keep only these skill names.
 *
 * Used as fallback when no V2 skill config is found in roles.yml.
 */
const LEGACY_SKILL_ALLOW: Record<string, string[] | null> = {
	default:        null,
	orchestrator:   ["brainstorming", "writing-plans", "commit-hygiene", "verification-before-completion"],
	implement:      null,
	designer:       [
		"frontend-design",
		"ui-ux-pro-max",
		"framer-motion-best-practices",
		"web-design-guidelines",
		"vercel-react-best-practices",
		// pbakaus/impeccable skills
		"adapt",
		"animate",
		"arrange",
		"audit",
		"bolder",
		"clarify",
		"colorize",
		"critique",
		"delight",
		"distill",
		"extract",
		"harden",
		"normalize",
		"onboard",
		"optimize",
		"overdrive",
		"polish",
		"quieter",
		"teach-impeccable",
		"typeset",
	],
	grafana:        ["grafana-dashboards"],
	explore:        [],
	research:       [],
	"ask-explore":  [],
	"ask-research": [],
	plan:           ["brainstorming", "writing-plans"],
	lint:           [],
	verifier:       ["qa-test-planner", "verification-before-completion"],
	merge:          [],
	curator:        [],
	"worktree-setup": [],
};

type SkillConfig = { auto: string[]; frontmatter: string[] };

function isV2Skills(skills: unknown): skills is SkillConfig {
	return (
		skills !== null &&
		typeof skills === "object" &&
		"auto" in (skills as Record<string, unknown>) &&
		Array.isArray((skills as Record<string, unknown>).auto)
	);
}

function resolveSkillConfig(agent: string): SkillConfig | null {
	const rolesPath = path.join(resolveAgentDir(), "roles.yml");
	const loaded = RolesConfigFile.relocate(rolesPath).load();
	if (!loaded || typeof loaded !== "object") return null;
	const config = loaded as RolesConfigShape;

	// Check subagents section first (canonical for subagents)
	const subagent = config.subagents?.[agent];
	if (subagent && isV2Skills(subagent.skills)) {
		return subagent.skills;
	}

	// Then roles section
	const role = config.roles?.[agent];
	if (role && isV2Skills(role.skills)) {
		return role.skills;
	}

	return null;
}

const skillsSectionRe = /^# Skills\n[\s\S]*?(?=^# [A-Z]|$(?!\n))/m;
const availableSkillsSectionRe = /^# Available Skills\n[\s\S]*?(?=^# [A-Z]|$(?!\n))/m;

/**
 * Core skill-section filter: applies an allowlist to one `#`-headed section.
 * `null` = keep everything; `[]` = remove entire section; string[] = filter by name.
 */
function filterSkillSection(
	systemPrompt: string,
	sectionRe: RegExp,
	allowed: string[] | null,
): string {
	if (allowed === null) return systemPrompt;

	const sectionMatch = systemPrompt.match(sectionRe);
	if (!sectionMatch) return systemPrompt;

	if (allowed.length === 0) {
		return systemPrompt.replace(sectionRe, "");
	}

	const sectionText = sectionMatch[0];
	const firstSkillIdx = sectionText.indexOf("\n## ");
	if (firstSkillIdx === -1) {
		// No individual skill blocks found — return as-is
		return systemPrompt;
	}

	const intro = sectionText.substring(0, firstSkillIdx + 1); // includes trailing \n
	const skillsBody = sectionText.substring(firstSkillIdx + 1);

	// Split skill blocks: each starts with `## skill-name\n`
	const skillBlocks: string[] = [];
	const blockRe = /^## \S+.*(?:\n(?!## |# ).*)*\n?/gm;
	let blockMatch: RegExpExecArray | null;
	while ((blockMatch = blockRe.exec(skillsBody)) !== null) {
		skillBlocks.push(blockMatch[0]);
	}

	// Keep only blocks whose skill name is in the allowlist
	const filteredBlocks = skillBlocks.filter((block) => {
		const nameMatch = block.match(/^## (\S+)/);
		return nameMatch ? allowed.includes(nameMatch[1]) : false;
	});

	const filteredSection = intro + filteredBlocks.join("");
	return systemPrompt.replace(sectionRe, filteredSection);
}

/** V1 fallback: filter `# Skills` section using LEGACY_SKILL_ALLOW map. */
function stripSkillsV1(systemPrompt: string, agent: string): string {
	const allowed = LEGACY_SKILL_ALLOW[agent] ?? LEGACY_SKILL_ALLOW.default;
	return filterSkillSection(systemPrompt, skillsSectionRe, allowed);
}

/**
 * V2 skill filtering: filter both `# Skills` (auto) and `# Available Skills`
 * (frontmatter) sections using the SkillConfig read from roles.yml.
 */
function stripSkillsV2(systemPrompt: string, config: SkillConfig): string {
	let result = systemPrompt;
	result = filterSkillSection(result, skillsSectionRe, config.auto);
	result = filterSkillSection(result, availableSkillsSectionRe, config.frontmatter);
	return result;
}

/**
 * Filter skill sections from the system prompt based on agent role.
 *
 * V2 (roles.yml has `skills: { auto, frontmatter }` for this agent): filter
 * both `# Skills` and `# Available Skills` sections independently.
 *
 * V1 fallback: filter only `# Skills` using the LEGACY_SKILL_ALLOW map.
 */
function stripSkills(systemPrompt: string, agent: string): string {
	const skillConfig = resolveSkillConfig(agent);
	if (skillConfig) {
		return stripSkillsV2(systemPrompt, skillConfig);
	}
	return stripSkillsV1(systemPrompt, agent);
}

// ─── Extension entry point ─────────────────────────────────────────────────

export default function mcpFilterExtension(pi: ExtensionAPI) {
	pi.logger.debug("mcp-filter: extension loaded");
	const DEFAULT_SESSION_KEY = "__default__";
	const sessionMcpAllowByKey = new Map<string, string[] | null>([[DEFAULT_SESSION_KEY, resolveMcpAllowlist("default")]]);
	const getSessionKey = (ctx: ExtensionContext | undefined): string => {
		const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager;
		if (!sessionManager || typeof sessionManager.getSessionId !== "function") return DEFAULT_SESSION_KEY;
		const sessionId = sessionManager.getSessionId();
		return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : DEFAULT_SESSION_KEY;
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const agent = await resolveAgent(event.systemPrompt, ctx);
		const mcpAllow = resolveMcpAllowlist(agent);
		sessionMcpAllowByKey.set(getSessionKey(ctx), mcpAllow);

		// Skip filtering for agents with full access (no changes needed)
		const skillConfig = resolveSkillConfig(agent);
		const hasV2Skills = skillConfig !== null;
		const v1SkillAllow = LEGACY_SKILL_ALLOW[agent] ?? LEGACY_SKILL_ALLOW.default;
		if (mcpAllow === null && !hasV2Skills && v1SkillAllow === null) {
			pi.logger.debug(`mcp-filter: agent=${agent} — full access, skipping`);
			return;
		}

		pi.logger.debug(`mcp-filter: agent=${agent} — applying filters`);

		let prompt = event.systemPrompt;
		prompt = stripMcpTools(prompt, mcpAllow);
		prompt = stripSkills(prompt, agent);

		return { systemPrompt: prompt };
	});

	// Safety net: block execution of any MCP tool that was filtered out
	pi.on("tool_call", async (event, ctx) => {
		if (!event.toolName.startsWith("mcp_")) return;
		const mcpAllow = sessionMcpAllowByKey.get(getSessionKey(ctx)) ?? resolveMcpAllowlist("default");

		if (mcpAllow === null) return; // full access

		// No MCP tools allowed
		if (mcpAllow.length === 0) {
			return { block: true, reason: "MCP tools are not available for this agent role." };
		}

		// Check if tool prefix is in the allowlist
		const keep = mcpAllow.some(prefix => event.toolName.startsWith(prefix));
		if (!keep) {
			return { block: true, reason: "This MCP tool is not available for this agent role." };
		}
	});
}
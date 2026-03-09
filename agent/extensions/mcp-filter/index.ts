import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ─── Agent detection ────────────────────────────────────────────────────────

type KnownAgentPrompt = {
	name: string;
	body: string;
};

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".omp", "agent");
const SUBAGENT_ROLE_MARKER = "You are operating on a delegated sub-task.";

let knownAgentPromptsPromise: Promise<KnownAgentPrompt[]> | undefined;

function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized.trim();
	const endIndex = normalized.indexOf("\n---", 3);
	return endIndex === -1 ? normalized.trim() : normalized.slice(endIndex + 4).trim();
}

function detectAgentNameFromPrompt(systemPrompt: string, knownAgentPrompts: KnownAgentPrompt[]): string {
	const match = systemPrompt.match(/^name:\s*(\S+)/m);
	if (match) return match[1];
	if (!systemPrompt.includes(SUBAGENT_ROLE_MARKER)) return "default";
	const matchedAgent = knownAgentPrompts.find(({ body }) => body.length > 0 && systemPrompt.includes(body));
	return matchedAgent?.name ?? "default";
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
 * MCP server allocation per agent.
 * Each key maps to an array of allowed MCP prefixes.
 * `null` = all MCP tools allowed (no filtering).
 * `[]`   = no MCP tools allowed (remove all).
 */
const AGENT_MCP_ALLOW: Record<string, string[] | null> = {
	default:        ["mcp_augment_", "mcp_better_context_"],  // exclude chrome-devtools and grafana
	orchestrator:   [],
	implement:      ["mcp_augment_", "mcp_better_context_"],  // chrome-devtools and grafana are specialized
	designer:       ["mcp_augment_", "mcp_better_context_", "mcp_chrome_devtools_"],
	grafana:        ["mcp_grafana_"],
	explore:        ["mcp_augment_"],
	research:       ["mcp_augment_", "mcp_better_context_"],
	"ask-explore":  [],
	"ask-research": ["mcp_augment_"],
	plan:           [],
	lint:           [],
	verifier:       [],
	merge:          [],
	curator:        [],
	"worktree-setup": [],
};

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
function stripMcpTools(systemPrompt: string, agent: string): string {
	const allowed = AGENT_MCP_ALLOW[agent] ?? AGENT_MCP_ALLOW.default;

	// null = keep everything
	if (allowed === null) return systemPrompt;

	// Match each <function>...</function> block and check if it's an MCP tool
	return systemPrompt.replace(
		/<function>[\s\S]*?<\/function>\n?/g,
		(match) => {
			const nameMatch = match.match(/"name"\s*:\s*"([^"]+)"/);
			if (!nameMatch) return match; // keep non-parseable blocks
			const toolName = nameMatch[1];

			// Only filter MCP tools (name starts with mcp_)
			if (!toolName.startsWith("mcp_")) return match;

			// Empty allowlist = remove all MCP tools
			if (allowed.length === 0) return "";

			// Keep tool if its name starts with any allowed prefix
			const keep = allowed.some((prefix) => toolName.startsWith(prefix));
			return keep ? match : "";
		},
	);
}

// ─── Skill filtering ───────────────────────────────────────────────────────

/**
 * Skill allocation per agent.
 * `null`  = all skills (no filtering).
 * `[]`    = no skills (remove entire section).
 * string[] = keep only these skill names.
 */
const AGENT_SKILL_ALLOW: Record<string, string[] | null> = {
	default:        null,
	orchestrator:   ["brainstorming", "writing-plans", "commit-hygiene", "verification-before-completion"],
	implement:      null,
	designer:       [
		"frontend-design",
		"ui-ux-pro-max",
		"framer-motion-best-practices",
		"web-design-guidelines",
		"vercel-react-best-practices",
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

/**
 * Filter the `# Skills` section from the system prompt based on agent role.
 *
 * The section has this structure:
 *   # Skills
 *   <intro text>
 *   ## skill-name-1
 *   Description...
 *   ## skill-name-2
 *   Description...
 *   # Next Heading
 *
 * For agents with no skills: remove the entire section (from `# Skills\n`
 * up to but not including the next `# ` top-level heading).
 *
 * For agents with specific skills: keep the section header and intro,
 * but retain only `## skill-name` blocks whose name is in the allowlist.
 */
function stripSkills(systemPrompt: string, agent: string): string {
	const allowed = AGENT_SKILL_ALLOW[agent] ?? AGENT_SKILL_ALLOW.default;

	// null = keep everything
	if (allowed === null) return systemPrompt;

	// Match the entire Skills section (from `# Skills\n` to next top-level heading)
	const skillsSectionRe = /^# Skills\n[\s\S]*?(?=^# [A-Z]|$(?!\n))/m;
	const sectionMatch = systemPrompt.match(skillsSectionRe);

	// No Skills section found — nothing to do
	if (!sectionMatch) return systemPrompt;

	// Empty allowlist = remove entire Skills section
	if (allowed.length === 0) {
		return systemPrompt.replace(skillsSectionRe, "");
	}

	// Specific skills: keep section header/intro, filter individual skill blocks
	const sectionText = sectionMatch[0];

	// Split section into: intro (before first ##) + individual skill blocks
	const firstSkillIdx = sectionText.indexOf("\n## ");
	if (firstSkillIdx === -1) {
		// No individual skill blocks found — return as-is
		return systemPrompt;
	}

	const intro = sectionText.substring(0, firstSkillIdx + 1); // includes trailing \n
	const skillsBody = sectionText.substring(firstSkillIdx + 1);

	// Split skill blocks: each starts with `## skill-name\n`
	// We split on `## ` at line start, keeping the delimiter
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
	return systemPrompt.replace(skillsSectionRe, filteredSection);
}

// ─── Extension entry point ─────────────────────────────────────────────────

export default function mcpFilterExtension(pi: ExtensionAPI) {
	pi.logger.debug("mcp-filter: extension loaded");
	let currentAgent = "default";

	pi.on("before_agent_start", async (event, ctx) => {
		const agent = await resolveAgent(event.systemPrompt, ctx);
		currentAgent = agent;

		// Skip filtering for agents with full access (no changes needed)
		const mcpAllow = AGENT_MCP_ALLOW[agent] ?? AGENT_MCP_ALLOW.default;
		const skillAllow = AGENT_SKILL_ALLOW[agent] ?? AGENT_SKILL_ALLOW.default;
		if (mcpAllow === null && skillAllow === null) {
			pi.logger.debug(`mcp-filter: agent=${agent} — full access, skipping`);
			return;
		}

		pi.logger.debug(`mcp-filter: agent=${agent} — applying filters`);

		let prompt = event.systemPrompt;
		prompt = stripMcpTools(prompt, agent);
		prompt = stripSkills(prompt, agent);

		return { systemPrompt: prompt };
	});

	// Safety net: block execution of any MCP tool that was filtered out

	pi.on("tool_call", async (event) => {
		if (!event.toolName.startsWith("mcp_")) return;

		const allowed = AGENT_MCP_ALLOW[currentAgent] ?? AGENT_MCP_ALLOW.default;
		if (allowed === null) return; // full access

		// No MCP tools allowed
		if (allowed.length === 0) {
			return { block: true, reason: "MCP tools are not available for this agent role." };
		}

		// Check if tool prefix is in the allowlist
		const keep = allowed.some((prefix) => event.toolName.startsWith(prefix));
		if (!keep) {
			return { block: true, reason: "This MCP tool is not available for this agent role." };
		}
	});
}
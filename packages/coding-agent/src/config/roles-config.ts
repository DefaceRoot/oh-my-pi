import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { YAML } from "bun";
import { ConfigFile } from "../config";

const RoleSkillsSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("none"),
	Type.Object({
		categories: Type.Array(Type.String({ minLength: 1 })),
	}),
]);

const RoleConfigSchema = Type.Object({
	tools: Type.Array(Type.String({ minLength: 1 })),
	mcp: Type.Array(Type.String({ minLength: 1 })),
	skills: RoleSkillsSchema,
});

const SubagentConfigSchema = Type.Object({
	mcp: Type.Array(Type.String({ minLength: 1 })),
});

const RolesConfigSchema = Type.Object({
	roles: Type.Record(Type.String({ minLength: 1 }), RoleConfigSchema),
	subagents: Type.Record(Type.String({ minLength: 1 }), SubagentConfigSchema),
});

type RoleSkillsConfig = Static<typeof RoleSkillsSchema>;
type RoleConfig = Static<typeof RoleConfigSchema>;
type SubagentConfig = Static<typeof SubagentConfigSchema>;
export type RolesConfigData = Static<typeof RolesConfigSchema>;

export const SKILL_CATEGORY_TO_SKILLS: Record<string, string[]> = {
	workflow: [
		"code-review-foundations",
		"commit-hygiene",
		"dispatching-parallel-agents",
		"systematic-debugging",
		"verification-before-completion",
		"using-git-worktrees",
		"using-tmux-for-interactive-commands",
	],
	planning: [
		"brainstorming",
		"generate-creative-ideas",
		"writing-plans",
		"validate-implementation-plan",
	],
	implementation: [
		"test-driven-development",
		"error-handling-patterns",
		"e2e-testing-patterns",
		"auth-implementation-patterns",
		"fastapi-templates",
		"monorepo-management",
		"security-review",
		"simplify",
	],
	frontend: [
		"frontend-design",
		"framer-motion-best-practices",
		"vercel-react-best-practices",
		"ui-ux-pro-max",
		"web-design-guidelines",
		"svg-art",
	],
	meta: ["skill-creator", "oh-my-pi-customization", "find-skills", "system-prompts", "semantic-compression"],
	infra: ["grafana-dashboards", "qa-test-planner", "agent-browser", "dragonglass-phased-cleanup"],
};

export const SKILL_CATEGORIES = Object.keys(SKILL_CATEGORY_TO_SKILLS);

const ALWAYS_ON_MCP_SERVER = "augment";

function normalizeMcpServers(servers: readonly string[]): string[] {
	const unique = Array.from(new Set(servers.map(server => server.trim()).filter(server => server.length > 0)));
	const withoutAugment = unique.filter(server => server !== ALWAYS_ON_MCP_SERVER);
	return [ALWAYS_ON_MCP_SERVER, ...withoutAugment];
}

export const DEFAULT_ROLES_CONFIG: RolesConfigData = {
	roles: {
		default: {
			tools: [
				"read",
				"write",
				"edit",
				"find",
				"grep",
				"bash",
				"python",
				"ssh",
				"web_search",
				"fetch",
				"lsp",
				"ast_grep",
				"ast_edit",
				"task",
				"cancel_job",
				"await",
				"todo_write",
				"ask",
				"checkpoint",
				"rewind",
				"browser",
				"resolve",
			],
			mcp: ["augment"],
			skills: "all",
		},
		orchestrator: {
			tools: ["read", "bash", "task", "await", "todo_write", "ask"],
			mcp: ["augment"],
			skills: {
				categories: ["workflow", "infra"],
			},
		},
		plan: {
			tools: [
				"read",
				"write",
				"edit",
				"find",
				"grep",
				"bash",
				"web_search",
				"fetch",
				"ast_grep",
				"ast_edit",
				"task",
				"cancel_job",
				"await",
				"todo_write",
				"ask",
				"checkpoint",
				"rewind",
				"render_mermaid",
				"resolve",
				"exit_plan_mode",
			],
			mcp: ["augment"],
			skills: {
				categories: ["planning", "workflow"],
			},
		},
		ask: {
			tools: ["read", "find", "grep", "fetch", "web_search", "lsp", "submit_result"],
			mcp: ["augment"],
			skills: "none",
		},
		implement: {
			tools: [
				"read",
				"write",
				"edit",
				"find",
				"grep",
				"bash",
				"python",
				"ssh",
				"web_search",
				"fetch",
				"lsp",
				"ast_grep",
				"ast_edit",
				"task",
				"cancel_job",
				"await",
				"todo_write",
				"ask",
				"checkpoint",
				"rewind",
				"browser",
				"resolve",
			],
			mcp: ["augment", "better-context"],
			skills: "all",
		},
	},
	subagents: {
		designer: {
			mcp: ["augment", "chrome-devtools"],
		},
		grafana: {
			mcp: ["augment", "grafana"],
		},
		research: {
			mcp: ["augment", "better-context"],
		},
		explore: {
			mcp: ["augment", "better-context"],
		},
		"ask-explore": {
			mcp: [],
		},
		"ask-research": {
			mcp: ["augment"],
		},
		_default: {
			mcp: ["augment"],
		},
	},
};

export const RolesConfigFile = new ConfigFile<RolesConfigData>("roles", RolesConfigSchema);

function cloneRoleConfig(config: RoleConfig): RoleConfig {
	return {
		tools: [...config.tools],
		mcp: [...config.mcp],
		skills:
			typeof config.skills === "string"
				? config.skills
				: {
						categories: [...config.skills.categories],
					},
	};
}

function cloneSubagentConfig(config: SubagentConfig): SubagentConfig {
	return {
		mcp: [...config.mcp],
	};
}

function cloneRolesConfig(config: RolesConfigData): RolesConfigData {
	const roles = Object.fromEntries(
		Object.entries(config.roles).map(([name, roleConfig]) => [name, cloneRoleConfig(roleConfig)]),
	);
	const subagents = Object.fromEntries(
		Object.entries(config.subagents).map(([name, subagentConfig]) => [name, cloneSubagentConfig(subagentConfig)]),
	);
	return {
		roles,
		subagents,
	};
}

export class RolesConfig {
	#configFile: ConfigFile<RolesConfigData>;
	#resolved?: RolesConfigData;

	constructor(configPath?: string) {
		this.#configFile = RolesConfigFile.relocate(configPath);
	}

	#getConfig(): RolesConfigData {
		if (this.#resolved) {
			return this.#resolved;
		}
		const loaded = this.#configFile.load();
		this.#resolved = cloneRolesConfig(loaded ?? DEFAULT_ROLES_CONFIG);
		return this.#resolved;
	}

	#getRole(role: string): RoleConfig {
		const config = this.#getConfig();
		return config.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
	}

	#getSkillCategories(skills: RoleSkillsConfig): string[] {
		if (skills === "none") {
			return [];
		}
		if (skills === "all") {
			return [...SKILL_CATEGORIES];
		}
		return [...skills.categories];
	}

	#persistConfig(config: RolesConfigData): void {
		const configPath = this.#configFile.path();
		const serialized =
			configPath.endsWith(".json") || configPath.endsWith(".jsonc")
				? JSON.stringify(config, null, 2)
				: YAML.stringify(config, null, 2);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, serialized, "utf-8");
		this.#configFile.invalidate?.();
		this.#resolved = cloneRolesConfig(config);
	}

	getKnownMcpServers(): string[] {
		const config = this.#getConfig();
		const servers = [
			...Object.values(config.roles).flatMap(roleConfig => roleConfig.mcp),
			...Object.values(config.subagents).flatMap(subagentConfig => subagentConfig.mcp),
		];
		return normalizeMcpServers(servers);
	}

	getToolsForRole(role: string): string[] {
		return [...this.#getRole(role).tools];
	}

	getMcpForRole(role: string): string[] {
		return normalizeMcpServers(this.#getRole(role).mcp);
	}

	setMcpForRole(role: string, servers: string[]): void {
		const config = this.#getConfig();
		const roleConfig = config.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		config.roles[role] = {
			...cloneRoleConfig(roleConfig),
			mcp: normalizeMcpServers(servers),
		};
		this.#persistConfig(config);
	}

	getSkillCategoriesForRole(role: string): string[] {
		return this.#getSkillCategories(this.#getRole(role).skills);
	}

	getMcpForSubagent(agentName: string): string[] {
		const config = this.#getConfig();
		const namedSubagent = config.subagents[agentName];
		if (namedSubagent) {
			return namedSubagent.mcp.length === 0 ? [] : normalizeMcpServers(namedSubagent.mcp);
		}
		const fallbackSubagent = config.subagents._default ?? DEFAULT_ROLES_CONFIG.subagents._default;
		return normalizeMcpServers(fallbackSubagent.mcp);
	}
}

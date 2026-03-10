import { type Static, Type } from "@sinclair/typebox";
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
	planning: ["brainstorming", "writing-plans", "validate-implementation-plan"],
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
			tools: [
				"read",
				"find",
				"grep",
				"bash",
				"python",
				"ssh",
				"ast_grep",
				"task",
				"cancel_job",
				"await",
				"todo_write",
				"ask",
				"checkpoint",
				"rewind",
				"notebook",
				"resolve",
			],
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
			tools: ["read", "find", "grep", "bash", "ssh", "web_search", "fetch", "ask", "notebook", "render_mermaid", "resolve"],
			mcp: ["augment"],
			skills: "none",
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
	const roles = Object.fromEntries(Object.entries(config.roles).map(([name, roleConfig]) => [name, cloneRoleConfig(roleConfig)]));
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

	getToolsForRole(role: string): string[] {
		return [...this.#getRole(role).tools];
	}

	getMcpForRole(role: string): string[] {
		return [...this.#getRole(role).mcp];
	}

	getSkillCategoriesForRole(role: string): string[] {
		return this.#getSkillCategories(this.#getRole(role).skills);
	}

	getMcpForSubagent(agentName: string): string[] {
		const config = this.#getConfig();
		const subagent =
			config.subagents[agentName] ?? config.subagents._default ?? DEFAULT_ROLES_CONFIG.subagents._default;
		return [...subagent.mcp];
	}
}

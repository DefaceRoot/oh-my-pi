import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { YAML } from "bun";
import { ConfigFile } from "../config";

// V2 Skill config: per-skill mode control
const SkillConfigSchema = Type.Object({
	auto: Type.Array(Type.String({ minLength: 1 })),
	frontmatter: Type.Array(Type.String({ minLength: 1 })),
});

export type SkillConfig = Static<typeof SkillConfigSchema>;

// V2 Tools inherit pattern for subagents
const ToolsInheritSchema = Type.Object({
	inherit: Type.Optional(Type.String({ minLength: 1 })),
	add: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	remove: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export type ToolsInheritConfig = Static<typeof ToolsInheritSchema>;

// V2 Fallback model (placeholder for increment 2)
const FallbackSchema = Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()]));

// V2 Advanced config (placeholder for increment 2)
const AdvancedConfigSchema = Type.Optional(
	Type.Object({
		thinkingLevel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		maxRecursionDepth: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		compactionStrategy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		temperature: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	}),
);

export type AdvancedConfig = {
	thinkingLevel?: string | null;
	maxRecursionDepth?: number | null;
	compactionStrategy?: string | null;
	temperature?: number | null;
};

// Accepts V1 format ("all", "none", { categories }) AND V2 format ({ auto, frontmatter })
const RoleSkillsSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("none"),
	Type.Object({
		categories: Type.Array(Type.String({ minLength: 1 })),
	}),
	SkillConfigSchema,
]);

export const RoleConfigSchemaV2 = Type.Object({
	tools: Type.Array(Type.String({ minLength: 1 })),
	mcp: Type.Array(Type.String({ minLength: 1 })),
	skills: RoleSkillsSchema,
	fallback: FallbackSchema,
	advanced: AdvancedConfigSchema,
});

export const SubagentConfigSchemaV2 = Type.Object({
	mcp: Type.Array(Type.String({ minLength: 1 })),
	skills: Type.Optional(SkillConfigSchema),
	tools: Type.Optional(Type.Union([ToolsInheritSchema, Type.Array(Type.String({ minLength: 1 }))])),
	fallback: FallbackSchema,
	advanced: AdvancedConfigSchema,
});

const RolesConfigSchema = Type.Object({
	roles: Type.Record(Type.String({ minLength: 1 }), RoleConfigSchemaV2),
	subagents: Type.Record(Type.String({ minLength: 1 }), SubagentConfigSchemaV2),
});

export type RoleConfigV2 = Static<typeof RoleConfigSchemaV2>;
export type SubagentConfigV2 = Static<typeof SubagentConfigSchemaV2>;
export type RolesConfigData = Static<typeof RolesConfigSchema>;

// Internal aliases keep the implementation readable while exporting the V2 contract directly.
type RoleConfig = RoleConfigV2;
type SubagentConfig = SubagentConfigV2;

const ALWAYS_ON_MCP_SERVER = "augment";

function normalizeMcpServers(servers: readonly string[]): string[] {
	const unique = Array.from(new Set(servers.map(server => server.trim()).filter(server => server.length > 0)));
	const withoutAugment = unique.filter(server => server !== ALWAYS_ON_MCP_SERVER);
	return [ALWAYS_ON_MCP_SERVER, ...withoutAugment];
}

function mcpServerListsMatch(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((server, index) => server === right[index]);
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
			tools: ["read", "bash", "task", "cancel_job", "await", "todo_write", "ask"],
			mcp: ["augment"],
			skills: {
				auto: [
					"commit-hygiene",
					"verification-before-completion",
					"dispatching-parallel-agents",
					"grafana-dashboards",
					"qa-test-planner",
					"agent-browser",
					"dragonglass-phased-cleanup",
				],
				frontmatter: [],
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
				auto: [
					"brainstorming",
					"generate-creative-ideas",
					"writing-plans",
					"validate-implementation-plan",
					"code-review-foundations",
					"commit-hygiene",
					"dispatching-parallel-agents",
					"systematic-debugging",
					"verification-before-completion",
					"using-git-worktrees",
					"using-tmux-for-interactive-commands",
				],
				frontmatter: [],
			},
		},
		ask: {
			tools: ["read", "find", "grep", "fetch", "web_search", "lsp", "submit_result"],
			mcp: ["augment"],
			skills: { auto: [], frontmatter: [] },
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
		debug: {
			mcp: ["augment", "ref"],
		},
		designer: {
			mcp: ["augment", "chrome-devtools"],
		},
		explore: {
			mcp: ["augment", "better-context"],
		},
		grafana: {
			mcp: ["augment", "chrome-devtools", "grafana"],
		},
		implement: {
			mcp: ["augment", "ref"],
		},
		research: {
			mcp: ["augment", "better-context", "ref"],
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

// Returns true when the skills value is V2 format ({ auto, frontmatter })
function isV2SkillConfig(skills: unknown): skills is SkillConfig {
	return (
		skills !== null &&
		typeof skills === "object" &&
		"auto" in skills &&
		Array.isArray((skills as Record<string, unknown>).auto)
	);
}

function cloneSkillConfig(config: SkillConfig): SkillConfig {
	return {
		auto: [...config.auto],
		frontmatter: [...config.frontmatter],
	};
}

function cloneToolsInheritConfig(config: ToolsInheritConfig): ToolsInheritConfig {
	return {
		inherit: config.inherit,
		add: config.add !== undefined ? [...config.add] : undefined,
		remove: config.remove !== undefined ? [...config.remove] : undefined,
	};
}

function cloneAdvancedConfig(config: AdvancedConfig): AdvancedConfig {
	return { ...config };
}

function cloneRoleConfig(config: RoleConfig): RoleConfig {
	const base: RoleConfig = {
		tools: [...config.tools],
		mcp: [...config.mcp],
		skills:
			typeof config.skills === "string"
				? config.skills
				: isV2SkillConfig(config.skills)
					? cloneSkillConfig(config.skills)
					: {
							categories: [...(config.skills as { categories: string[] }).categories],
						},
	};
	if (config.fallback !== undefined) {
		base.fallback = config.fallback;
	}
	if (config.advanced !== undefined) {
		base.advanced = cloneAdvancedConfig(config.advanced);
	}
	return base;
}

function cloneSubagentConfig(config: SubagentConfig): SubagentConfig {
	const base: SubagentConfig = {
		mcp: [...config.mcp],
	};
	if (config.skills !== undefined) {
		base.skills = cloneSkillConfig(config.skills);
	}
	if (config.tools !== undefined) {
		base.tools = Array.isArray(config.tools)
			? [...config.tools]
			: cloneToolsInheritConfig(config.tools as ToolsInheritConfig);
	}
	if (config.fallback !== undefined) {
		base.fallback = config.fallback;
	}
	if (config.advanced !== undefined) {
		base.advanced = cloneAdvancedConfig(config.advanced);
	}
	return base;
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

	setToolsForRole(role: string, tools: string[]): void {
		const config = this.#getConfig();
		const roleConfig = config.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		config.roles[role] = {
			...cloneRoleConfig(roleConfig),
			tools: [...tools],
		};
		this.#persistConfig(config);
	}

	getMcpForRole(role: string): string[] {
		const config = this.#getConfig();
		const namedRole = config.roles[role];
		if (namedRole) {
			return normalizeMcpServers(namedRole.mcp);
		}
		const namedSubagent = config.subagents[role];
		if (namedSubagent) {
			return namedSubagent.mcp.length === 0 ? [] : normalizeMcpServers(namedSubagent.mcp);
		}
		const defaultRole = config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		return normalizeMcpServers(defaultRole.mcp);
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

	getMcpForSubagent(agentName: string): string[] {
		const config = this.#getConfig();
		const namedSubagent = config.subagents[agentName];
		if (namedSubagent) {
			return namedSubagent.mcp.length === 0 ? [] : normalizeMcpServers(namedSubagent.mcp);
		}
		const fallbackSubagent = config.subagents._default ?? DEFAULT_ROLES_CONFIG.subagents._default;
		return normalizeMcpServers(fallbackSubagent.mcp);
	}

	// --- V2 accessors ---

	/**
	 * Returns the V2 SkillConfig for a role if the role uses V2 skills format.
	 * V1 "none" is migrated to an empty V2 config (no skills).
	 * V1 "all" or V1 { categories } returns undefined (caller passes all skills through).
	 */
	getSkillConfigForRole(role: string): SkillConfig | undefined {
		const roleConfig = this.#getRole(role);
		if (isV2SkillConfig(roleConfig.skills)) {
			return cloneSkillConfig(roleConfig.skills);
		}
		// Migrate V1 "none" → V2 empty config to preserve the restriction
		if (roleConfig.skills === "none") {
			return { auto: [], frontmatter: [] };
		}
		// V1 "all" or V1 { categories } → return undefined (pass all skills through)
		return undefined;
	}

	/**
	 * Returns the V2 SkillConfig stored in a subagent's config.
	 * Returns undefined if no skills config is set or it is not V2 format.
	 */
	getSkillConfigForSubagent(agent: string): SkillConfig | undefined {
		const config = this.#getConfig();
		const subagentConfig = config.subagents[agent];
		if (!subagentConfig?.skills) {
			return undefined;
		}
		if (isV2SkillConfig(subagentConfig.skills)) {
			return cloneSkillConfig(subagentConfig.skills);
		}
		return undefined;
	}

	/** Sets V2 SkillConfig for a role and persists. */
	setSkillConfigForRole(role: string, skillConfig: SkillConfig): void {
		const config = this.#getConfig();
		const roleConfig = config.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		config.roles[role] = {
			...cloneRoleConfig(roleConfig),
			skills: cloneSkillConfig(skillConfig),
		};
		this.#persistConfig(config);
	}

	/** Sets V2 SkillConfig for a subagent and persists. */
	setSkillConfigForSubagent(agent: string, skillConfig: SkillConfig): void {
		const config = this.#getConfig();
		const subagentConfig = config.subagents[agent] ?? { mcp: [] };
		config.subagents[agent] = {
			...cloneSubagentConfig(subagentConfig),
			skills: cloneSkillConfig(skillConfig),
		};
		this.#persistConfig(config);
	}

	/**
	 * Resolves the effective tool list for a subagent.
	 *
	 * - If the subagent has no tools config: returns null (caller uses agent defaults).
	 * - If tools is a direct array: returns a copy.
	 * - If tools is a ToolsInheritConfig: resolves by inheriting from the named role
	 *   (defaulting to "default"), then applying `add` and `remove` patches.
	 */
	getToolsForSubagent(agent: string, _visited?: Set<string>): string[] | null {
		const visited = _visited ?? new Set<string>();
		if (visited.has(agent)) {
			// Cycle detected — break by returning a copy of the default role tools
			return [...this.getToolsForRole("default")];
		}
		visited.add(agent);

		const config = this.#getConfig();
		const subagentConfig = config.subagents[agent];
		if (!subagentConfig || subagentConfig.tools === undefined) {
			return null;
		}

		const tools = subagentConfig.tools;

		if (Array.isArray(tools)) {
			return [...tools];
		}

		// ToolsInheritConfig — resolve inheritance
		// Role takes priority over subagent for the same name (backward compat).
		// If inherit references neither a role nor a subagent, falls back to "default".
		const toolsInherit = tools as ToolsInheritConfig;
		const inheritFrom = toolsInherit.inherit ?? "default";

		let result: string[];
		if (config.roles[inheritFrom] !== undefined) {
			result = [...this.getToolsForRole(inheritFrom)];
		} else if (config.subagents[inheritFrom] !== undefined) {
			// Recurse into subagent with cycle detection
			const inherited = this.getToolsForSubagent(inheritFrom, visited);
			// If the referenced subagent has no tools config, fall back to default role
			result = inherited ?? [...this.getToolsForRole("default")];
		} else {
			// Unknown name — fall back to default role
			result = [...this.getToolsForRole("default")];
		}

		if (toolsInherit.add) {
			result = [...result, ...toolsInherit.add];
		}
		if (toolsInherit.remove) {
			const toRemove = new Set(toolsInherit.remove);
			result = result.filter(t => !toRemove.has(t));
		}

		return result;
	}

	/** Writes a ToolsInheritConfig to a subagent and persists. */
	setToolsForSubagent(agent: string, toolsConfig: ToolsInheritConfig): void {
		const config = this.#getConfig();
		const subagentConfig = config.subagents[agent] ?? { mcp: [] };
		config.subagents[agent] = {
			...cloneSubagentConfig(subagentConfig),
			tools: cloneToolsInheritConfig(toolsConfig),
		};
		this.#persistConfig(config);
	}

	/** Writes MCP server list to a subagent entry and persists. */
	setMcpForSubagent(agent: string, servers: string[]): void {
		const config = this.#getConfig();
		const subagentConfig = config.subagents[agent] ?? { mcp: [] };
		config.subagents[agent] = {
			...cloneSubagentConfig(subagentConfig),
			mcp: normalizeMcpServers(servers),
		};
		this.#persistConfig(config);
	}

	/** Returns the stored fallback model key for a role, or null if not configured. */
	getFallbackForRole(role: string): string | null {
		// Read directly from the role entry — do not inherit from default.
		// Callers (e.g. resolveFallbackModel) handle the global-default fallthrough.
		const fallback = this.#getConfig().roles[role]?.fallback;
		return typeof fallback === "string" ? fallback : null;
	}

	/** Sets the fallback model key for a role and persists. Pass null to clear. */
	setFallbackForRole(role: string, fallback: string | null): void {
		const config = this.#getConfig();
		const roleConfig = config.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		config.roles[role] = {
			...cloneRoleConfig(roleConfig),
			fallback: fallback ?? undefined,
		};
		this.#persistConfig(config);
	}

	/** Returns the stored fallback model key for a subagent, or null if not configured. */
	getFallbackForSubagent(agent: string): string | null {
		const fallback = this.#getConfig().subagents[agent]?.fallback;
		return typeof fallback === "string" ? fallback : null;
	}

	/** Sets the fallback model key for a subagent and persists. Pass null to clear. */
	setFallbackForSubagent(agent: string, fallback: string | null): void {
		const config = this.#getConfig();
		const inheritedMcp = normalizeMcpServers(
			(config.subagents._default ?? DEFAULT_ROLES_CONFIG.subagents._default).mcp,
		);
		const subagentConfig = config.subagents[agent] ?? { mcp: inheritedMcp };
		const nextConfig = {
			...cloneSubagentConfig(subagentConfig),
			fallback: fallback ?? undefined,
		};
		const hasOtherOverrides =
			nextConfig.skills !== undefined || nextConfig.tools !== undefined || nextConfig.advanced !== undefined;
		if (fallback === null && !hasOtherOverrides && mcpServerListsMatch(nextConfig.mcp, inheritedMcp)) {
			delete config.subagents[agent];
		} else {
			config.subagents[agent] = nextConfig;
		}
		this.#persistConfig(config);
	}

	/** Returns the stored advanced config for a role, or null if not configured. */
	getAdvancedForRole(role: string): AdvancedConfig | null {
		const advanced = this.#getConfig().roles[role]?.advanced;
		return advanced !== undefined ? cloneAdvancedConfig(advanced) : null;
	}

	/** Sets the advanced config for a role and persists. Pass null to clear. */
	setAdvancedForRole(role: string, advanced: AdvancedConfig | null): void {
		const config = this.#getConfig();
		const existingRoleConfig = config.roles[role];
		if (advanced === null && existingRoleConfig?.advanced === undefined) return;

		const roleConfig = existingRoleConfig ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default;
		const nextConfig = {
			...cloneRoleConfig(roleConfig),
			advanced: advanced !== null ? cloneAdvancedConfig(advanced) : undefined,
		};

		if (advanced === null) {
			delete nextConfig.advanced;
			if (role !== "default") {
				const baseRoleConfig = cloneRoleConfig(
					DEFAULT_ROLES_CONFIG.roles[role] ?? config.roles.default ?? DEFAULT_ROLES_CONFIG.roles.default,
				);
				if (JSON.stringify(cloneRoleConfig(nextConfig)) === JSON.stringify(baseRoleConfig)) {
					delete config.roles[role];
					this.#persistConfig(config);
					return;
				}
			}
		}

		config.roles[role] = nextConfig;
		this.#persistConfig(config);
	}

	/** Returns the stored advanced config for a subagent, or null if not configured. */
	getAdvancedForSubagent(agent: string): AdvancedConfig | null {
		const advanced = this.#getConfig().subagents[agent]?.advanced;
		return advanced !== undefined ? cloneAdvancedConfig(advanced) : null;
	}

	/** Sets the advanced config for a subagent and persists. Pass null to clear. */
	setAdvancedForSubagent(agent: string, advanced: AdvancedConfig | null): void {
		const config = this.#getConfig();
		const existingSubagentConfig = config.subagents[agent];
		if (advanced === null && existingSubagentConfig?.advanced === undefined) return;

		const inheritedMcp = normalizeMcpServers(
			(config.subagents._default ?? DEFAULT_ROLES_CONFIG.subagents._default).mcp,
		);
		const subagentConfig = existingSubagentConfig ?? { mcp: inheritedMcp };
		const nextConfig = {
			...cloneSubagentConfig(subagentConfig),
			advanced: advanced !== null ? cloneAdvancedConfig(advanced) : undefined,
		};

		if (advanced === null) {
			delete nextConfig.advanced;
			const hasOtherOverrides =
				nextConfig.skills !== undefined || nextConfig.tools !== undefined || nextConfig.fallback !== undefined;
			if (!hasOtherOverrides && mcpServerListsMatch(nextConfig.mcp, inheritedMcp)) {
				delete config.subagents[agent];
			} else {
				config.subagents[agent] = nextConfig;
			}
			this.#persistConfig(config);
			return;
		}

		config.subagents[agent] = nextConfig;
		this.#persistConfig(config);
	}

	getFullConfig(): RolesConfigData {
		return cloneRolesConfig(this.#getConfig());
	}

	replaceConfig(config: RolesConfigData): void {
		this.#persistConfig(cloneRolesConfig(config));
	}

	mergeConfig(configPatch: Partial<Pick<RolesConfigData, "roles" | "subagents">>): void {
		if (configPatch.roles !== undefined && configPatch.subagents !== undefined) {
			this.#persistConfig({
				roles: Object.fromEntries(
					Object.entries(configPatch.roles).map(([roleName, roleConfig]) => [
						roleName,
						cloneRoleConfig(roleConfig),
					]),
				),
				subagents: Object.fromEntries(
					Object.entries(configPatch.subagents).map(([agentName, subagentConfig]) => [
						agentName,
						cloneSubagentConfig(subagentConfig),
					]),
				),
			});
			return;
		}

		const config = cloneRolesConfig(this.#getConfig());

		for (const [roleName, roleConfig] of Object.entries(configPatch.roles ?? {})) {
			if (config.roles[roleName] === undefined && DEFAULT_ROLES_CONFIG.roles[roleName] === undefined) {
				continue;
			}
			config.roles[roleName] = cloneRoleConfig(roleConfig);
		}

		for (const [agentName, subagentConfig] of Object.entries(configPatch.subagents ?? {})) {
			if (config.subagents[agentName] === undefined && DEFAULT_ROLES_CONFIG.subagents[agentName] === undefined) {
				continue;
			}
			config.subagents[agentName] = cloneSubagentConfig(subagentConfig);
		}

		this.#persistConfig(config);
	}

	/**
	 * Routes a partial config write to the correct section.
	 *
	 * Resolution order: roles first, then subagents. New agent names default to subagents.
	 *
	 * **Limitation**: when a name appears in both `roles` and `subagents` (e.g., `implement`
	 * in the default V1 config), this method always writes to `roles`. Use the dedicated
	 * `setSkillConfigForSubagent` / `setMcpForSubagent` / `setToolsForSubagent` /
	 * `setAdvancedForSubagent` methods to update the subagent entry for such names explicitly.
	 */
	setConfigForAgent(agentName: string, agentConfig: Partial<RoleConfigV2> | Partial<SubagentConfigV2>): void {
		const config = this.#getConfig();

		if (agentName in config.roles) {
			const roleConfig = config.roles[agentName] ?? DEFAULT_ROLES_CONFIG.roles.default;
			config.roles[agentName] = {
				...cloneRoleConfig(roleConfig),
				...agentConfig,
			} as RoleConfigV2;
		} else {
			const subagentConfig = config.subagents[agentName] ?? { mcp: [] };
			config.subagents[agentName] = {
				...cloneSubagentConfig(subagentConfig),
				...agentConfig,
			} as SubagentConfigV2;
		}

		this.#persistConfig(config);
	}
}

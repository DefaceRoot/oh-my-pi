import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { PresetsConfig } from "../src/config/presets-config";
import { RolesConfig } from "../src/config/roles-config";
import { Settings } from "../src/config/settings";
import type { Skill } from "../src/extensibility/skills";
import { AgentConfigModal } from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";
import { AuthStorage } from "../src/session/auth-storage";

beforeAll(() => {
	initTheme();
});

const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-haiku",
		name: "Claude Haiku",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.High },
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.High },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

function renderText(modal: AgentConfigModal, width = 140): string {
	return Bun.stripANSI(modal.render(width).join("\n"));
}

function createStubPresetsConfig(): PresetsConfig {
	return {
		getActivePreset: () => null,
		isModified: () => false,
		on: () => () => {},
		captureCurrentConfig: () => ({ modelRoles: {} as never, roles: {} as never, subagents: {} as never }),
		getPreset: () => undefined,
		savePreset: () => {},
		listPresets: () => [],
		applyPreset: async () => {},
		deletePreset: () => {},
		renamePreset: () => {},
	} as never;
}

function createModal(
	rolesConfig: RolesConfig,
	options: {
		subagentDefaultTools?: Partial<Record<string, string[]>>;
		modelRoles?: Partial<Record<string, string>>;
		values?: Record<string, unknown>;
		presetsConfig?: PresetsConfig;
		discoveredSkills?: Skill[];
		onDismiss?: () => void;
	} = {},
): AgentConfigModal {
	const subagentDefaultTools = options.subagentDefaultTools ?? {};
	const knownTools = [...new Set(["ast_grep", "read", "write", ...Object.values(subagentDefaultTools).flat()])].filter(
		(tool): tool is string => tool !== undefined,
	);
	return new AgentConfigModal({
		settings: {
			getModelRole: (role: string) => options.modelRoles?.[role],
			get: (key: string) => options.values?.[key],
		} as never,
		rolesConfig,
		modelRegistry: {
			getAll: () => mockModels,
			getAvailable: () => mockModels,
		} as never,
		presetsConfig: options.presetsConfig ?? createStubPresetsConfig(),
		knownTools,
		subagentDefaultTools,
		knownMcpServers: [],
		discoveredSkills: options.discoveredSkills ?? [],
		onDismiss: options.onDismiss ?? (() => {}),
		onRequestRender: () => {},
	} as never);
}

function createDiscoveredSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
		mode: "auto",
		content: `${name} content`,
	};
}

function focusModelTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
}

function openSkillsTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 5; i++) {
		if (renderText(modal).includes("[A]=auto")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Skills tab not found in modal:\n${renderText(modal)}`);
}

function openToolsTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 5; i++) {
		if (renderText(modal).includes("Tools:")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Tools tab not found in modal:\n${renderText(modal)}`);
}

function openAdvancedTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 7; i++) {
		if (renderText(modal).includes("Max Task Recursion")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Advanced tab not found in modal:\n${renderText(modal)}`);
}

describe("AgentConfigModal search integration", () => {
	test("keeps model search shortcuts inside the search field", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-model-search-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		const onDismiss = vi.fn();
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { onDismiss });

			focusModelTab(modal);
			modal.handleInput("/");
			modal.handleInput("t");

			const editing = renderText(modal);
			expect(editing).toContain("Search (editing)");
			expect(editing).toContain("▶ Fallback (editing)");
			expect(editing).not.toContain("▶ Primary (editing)");
			expect(editing).toContain("> t");

			modal.handleInput("\x1b");

			const cleared = renderText(modal);
			expect(onDismiss).not.toHaveBeenCalled();
			expect(cleared).toContain("Search (/ to edit)");
			expect(cleared).toContain("anthropic/claude-haiku");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("keeps skill search shortcuts inside the search field", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-skill-search-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		const onDismiss = vi.fn();
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: none
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				onDismiss,
				discoveredSkills: [
					createDiscoveredSkill("Alpha", "First skill"),
					createDiscoveredSkill("Beta", "Second skill"),
				],
			});

			openSkillsTab(modal);
			modal.handleInput("/");
			modal.handleInput("j");
			modal.handleInput(" ");

			const editing = renderText(modal);
			expect(editing).toContain("Search (editing)");
			expect(editing).toContain("No matching skills.");

			modal.handleInput("\x1b");

			const cleared = renderText(modal);
			expect(onDismiss).not.toHaveBeenCalled();
			expect(cleared).toContain("Search (/ to edit)");
			expect(cleared).toContain("Alpha");
			expect(cleared).toContain("Beta");
			expect(rolesConfig.getSkillConfigForRole("default")).toEqual({ auto: [], frontmatter: [] });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AgentConfigModal tools integration", () => {
	test("persists role tool toggles through the tools tab", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-role-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig);

			openToolsTab(modal);
			expect(renderText(modal)).toContain("Tools: 1 effective");

			modal.handleInput(" ");

			expect(rolesConfig.getToolsForRole("default")).toEqual([]);
			expect(renderText(modal)).toContain("Tools: 0 effective");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("clears subagent tool overrides back to no config", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  implement:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  implement:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { subagentDefaultTools: { implement: ["ast_grep"] } });

			for (let i = 0; i < 4; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("Tools: 1 effective");
			expect(renderText(modal)).not.toContain("inherit:");

			modal.handleInput(" ");
			expect(rolesConfig.getToolsForSubagent("implement")).toEqual([]);
			expect(renderText(modal)).toContain("Tools: 0 effective");

			modal.handleInput(" ");
			expect(rolesConfig.getToolsForSubagent("implement")).toEqual(["ast_grep"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("preserves direct subagent tool arrays when edited", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-direct-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  implement:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  implement:
    mcp:
      - augment
    tools:
      - read
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { subagentDefaultTools: { implement: ["read"] } });

			for (let i = 0; i < 4; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("space:toggle");
			expect(renderText(modal)).not.toContain("inherit:");

			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual([]);
			expect(rolesConfig.getToolsForRole("implement")).toEqual(["ast_grep"]);

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual(["read"]);
			expect(rolesConfig.getToolsForRole("implement")).toEqual(["ast_grep"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses runtime subagent defaults when no tools config exists", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-runtime-defaults-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
      - write
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  explore:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, { subagentDefaultTools: { explore: ["read", "grep"] } });

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}
			openToolsTab(modal);
			expect(renderText(modal)).toContain("space:toggle");
			expect(renderText(modal)).not.toContain("inherit:");
			expect(renderText(modal)).toContain("Tools: 2 effective");

			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.explore?.tools).toEqual(["grep"]);

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.explore?.tools).toEqual(["grep", "read"]);
			expect(rolesConfig.getToolsForSubagent("explore")).toEqual(["grep", "read"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AgentConfigModal fallback model integration", () => {
	test("shows global fallback state and persists role override changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-role-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				values: { "model.defaultFallback": "openai/gpt-4o" },
			});

			expect(renderText(modal)).toContain("anthropic/claude-sonnet-4-5");
			expect(renderText(modal)).toContain("Override: using global default");
			expect(renderText(modal)).toContain("Global default: openai/gpt-4o");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("default")).toBe("anthropic/claude-haiku");
			expect(renderText(modal)).toContain("Override: anthropic/claude-haiku");

			modal.handleInput("k");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("default")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("selecting the current primary model clears the fallback override", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-primary-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - ast_grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				values: { "model.defaultFallback": "openai/gpt-4o" },
			});

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("default")).toBeNull();
			expect(renderText(modal)).toContain("Override: using global default");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("crew subagents show implement model inheritance and normalize same-primary selection", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-inherit-implement-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: {
					default: "openai/gpt-4o",
					implement: "anthropic/claude-sonnet-4-5",
				},
				values: { "model.defaultFallback": "openai/gpt-4o" },
			});

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}

			expect(renderText(modal)).toContain("anthropic/claude-sonnet-4-5");
			expect(renderText(modal)).toContain("inherited from implement");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForSubagent("explore")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("ask role inherits the default model and normalizes same-primary fallback selection", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-ask-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "openai/gpt-4o" },
				values: { "model.defaultFallback": "anthropic/claude-haiku" },
			});

			modal.handleInput("j");

			expect(renderText(modal)).toContain("openai/gpt-4o");
			expect(renderText(modal)).toContain("inherited from default");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("ask")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("orchestrator model display does not inherit the default role", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-orchestrator-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "openai/gpt-4o" },
			});

			modal.handleInput("j");
			modal.handleInput("j");

			expect(renderText(modal)).toContain("(not configured)");
			expect(renderText(modal)).not.toContain("inherited from default");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("shows when no fallback is configured and persists subagent overrides", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  implement:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			for (let i = 0; i < 4; i++) {
				modal.handleInput("j");
			}

			expect(renderText(modal)).toContain("anthropic/claude-sonnet-4-5");
			expect(renderText(modal)).toContain("Override: no override");
			expect(renderText(modal)).toContain("Global default: none");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForSubagent("implement")).toBe("anthropic/claude-haiku");
			expect(rolesConfig.getFallbackForRole("implement")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("clearing a persisted subagent fallback restores inherited defaults", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-clear-persisted-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getFallbackForSubagent("explore")).toBe("anthropic/claude-haiku");
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);

			modal.handleInput("k");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForSubagent("explore")).toBeNull();
			expect(rolesConfig.getFullConfig().subagents.explore).toBeUndefined();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("clearing an inherited fallback leaves subagent defaults untouched", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-fallback-clear-noop-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}

			expect(rolesConfig.getFullConfig().subagents.explore).toBeUndefined();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);

			focusModelTab(modal);
			modal.handleInput(" ");

			expect(rolesConfig.getFullConfig().subagents.explore).toBeUndefined();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AgentConfigModal advanced integration", () => {
	test("shows global defaults and persists role advanced overrides", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-advanced-role-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
				  default:
				    tools:
				      - ast_grep
				    mcp:
				      - augment
				    skills: all
				subagents:
				  _default:
				    mcp:
				      - augment
				`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				values: {
					defaultThinkingLevel: "high",
					"task.maxRecursionDepth": 2,
					"compaction.strategy": "context-full",
					temperature: -1,
				},
			});

			openAdvancedTab(modal);
			const rendered = renderText(modal);
			expect(rendered).toContain("Thinking Level");
			expect(rendered).toContain("global");
			expect(rendered).toContain("high");
			expect(rendered).toContain("context-full");
			expect(rendered).toContain("provider default (-1)");

			modal.handleInput(" ");
			expect(rolesConfig.getAdvancedForRole("default")).toEqual({ thinkingLevel: "off" });

			modal.handleInput("j");
			modal.handleInput("\n");
			modal.handleInput("5");
			modal.handleInput("\n");

			expect(rolesConfig.getAdvancedForRole("default")).toEqual({
				thinkingLevel: "off",
				maxRecursionDepth: 5,
			});
			expect(renderText(modal)).toContain("5");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("persists subagent advanced changes through subagent accessors", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-advanced-subagent-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				[
					"roles:",
					"  default:",
					"    tools:",
					"      - read",
					"    mcp:",
					"      - augment",
					"    skills: all",
					"subagents:",
					"  _default:",
					"    mcp:",
					"      - augment",
					"  explore:",
					"    mcp:",
					"      - augment",
					"    advanced:",
					"      thinkingLevel: low",
					"      temperature: 0.7",
				].join("\n"),
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const modal = createModal(rolesConfig, {
				values: {
					defaultThinkingLevel: "high",
					"task.maxRecursionDepth": 2,
					"compaction.strategy": "context-full",
					temperature: -1,
				},
			});

			for (let i = 0; i < 8; i++) {
				modal.handleInput("j");
			}

			openAdvancedTab(modal);
			expect(renderText(modal)).toContain("0.7");
			expect(renderText(modal)).toContain("low");

			modal.handleInput(" ");
			expect(rolesConfig.getAdvancedForSubagent("explore")).toEqual({
				thinkingLevel: "medium",
				temperature: 0.7,
			});
			expect(rolesConfig.getFullConfig().subagents.explore?.mcp).toEqual(["augment"]);
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
			expect(rolesConfig.getAdvancedForRole("explore")).toBeNull();

			modal.handleInput("r");
			expect(rolesConfig.getAdvancedForSubagent("explore")).toEqual({ temperature: 0.7 });
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
			expect(renderText(modal)).toContain("global");

			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput("r");

			expect(rolesConfig.getAdvancedForSubagent("explore")).toBeNull();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
			expect(rolesConfig.getAdvancedForRole("explore")).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("resetting inherited advanced state is a no-op for unconfigured roles and subagents", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-advanced-reset-noop-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				[
					"roles:",
					"  default:",
					"    tools:",
					"      - read",
					"    mcp:",
					"      - augment",
					"    skills: all",
					"subagents:",
					"  _default:",
					"    mcp:",
					"      - augment",
				].join("\n"),
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const values = {
				defaultThinkingLevel: "high",
				"task.maxRecursionDepth": 2,
				"compaction.strategy": "context-full",
				temperature: -1,
			};

			const askModal = createModal(rolesConfig, { values });
			askModal.handleInput("j");
			openAdvancedTab(askModal);
			expect(rolesConfig.getFullConfig().roles.ask).toBeUndefined();
			askModal.handleInput("r");
			expect(rolesConfig.getFullConfig().roles.ask).toBeUndefined();

			const exploreModal = createModal(rolesConfig, { values });
			for (let i = 0; i < 8; i++) {
				exploreModal.handleInput("j");
			}
			openAdvancedTab(exploreModal);
			expect(rolesConfig.getFullConfig().subagents.explore).toBeUndefined();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
			exploreModal.handleInput("r");
			expect(rolesConfig.getFullConfig().subagents.explore).toBeUndefined();
			expect(rolesConfig.getMcpForSubagent("explore")).toEqual(["augment"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AgentConfigModal presets integration", () => {
	type PresetModalHarness = {
		tempDir: string;
		authStorage: AuthStorage;
		rolesConfig: RolesConfig;
		settings: Settings;
		modelRegistry: ModelRegistry;
		presetsConfig: PresetsConfig;
		modal: AgentConfigModal;
	};

	type PresetModalHarnessOptions = {
		activePreset?: string | null;
		onShowStatus?: (message: string) => void;
		onShowError?: (message: string) => void;
	};

	async function createPresetModalHarness(options: PresetModalHarnessOptions = {}): Promise<PresetModalHarness> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-modal-presets-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		const presetsPath = path.join(tempDir, "presets.yml");
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		await fs.writeFile(
			rolesPath,
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		const rolesConfig = new RolesConfig(rolesPath);
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});
		const presetsConfig = new PresetsConfig(presetsPath, settings, rolesConfig, modelRegistry);
		presetsConfig.savePreset("Baseline", {
			...presetsConfig.captureCurrentConfig(),
			description: "Original settings",
			createdAt: "2026-03-27T00:00:00.000Z",
			updatedAt: "2026-03-27T00:00:00.000Z",
		});
		if (options.activePreset !== null) {
			await presetsConfig.applyPreset(options.activePreset ?? "Baseline");
		}
		const modal = new AgentConfigModal({
			settings,
			rolesConfig,
			modelRegistry,
			knownTools: ["read", "write"],
			subagentDefaultTools: {},
			knownMcpServers: [],
			discoveredSkills: [],
			presetsConfig,
			onDismiss: () => {},
			onRequestRender: () => {},
			onShowStatus: options.onShowStatus,
			onShowError: options.onShowError,
		} as never);
		return { tempDir, authStorage, rolesConfig, settings, modelRegistry, presetsConfig, modal };
	}

	test("renders the preset bar and marks the modal modified after config edits", async () => {
		const harness = await createPresetModalHarness();
		try {
			const { modal } = harness;
			expect(renderText(modal)).toContain("Preset: Baseline");
			expect(renderText(modal)).not.toContain("Preset: Baseline *");

			openToolsTab(modal);
			modal.handleInput(" ");

			expect(renderText(modal)).toContain("Preset: Baseline *");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("opens a save-as prompt for custom configurations and can switch presets from the modal", async () => {
		const harness = await createPresetModalHarness({ activePreset: null });
		try {
			const { modal } = harness;
			modal.handleInput("\t");
			modal.handleInput("s");
			expect(renderText(modal)).toContain("Save current settings as");

			modal.handleInput("\x1b");
			modal.handleInput("p");
			expect(renderText(modal)).toContain("Select Preset");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("refreshes an open modal when the active preset is applied externally", async () => {
		const harness = await createPresetModalHarness();
		try {
			const { modal, rolesConfig, modelRegistry, presetsConfig, tempDir } = harness;
			const externalSettings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});
			const externalRolesConfig = new RolesConfig(path.join(tempDir, "roles.yml"));
			const externalPresetsConfig = new PresetsConfig(
				path.join(tempDir, "presets.yml"),
				externalSettings,
				externalRolesConfig,
				modelRegistry,
			);
			const baseline = presetsConfig.getPreset("Baseline");
			if (!baseline) {
				throw new Error("Baseline preset missing");
			}
			externalPresetsConfig.savePreset("External", {
				...baseline,
				roles: {
					...baseline.roles,
					default: {
						...baseline.roles.default,
						tools: ["grep"],
					},
				},
				updatedAt: "2026-03-27T01:00:00.000Z",
			});
			openToolsTab(modal);
			modal.handleInput(" ");
			expect(renderText(modal)).toContain("Preset: Baseline *");
			expect(renderText(modal)).toContain("Tools: 0 effective");

			await externalPresetsConfig.applyPreset("External");
			expect(renderText(modal)).toContain("Preset: External");
			expect(renderText(modal)).not.toContain("Preset: External *");
			expect(renderText(modal)).toContain("Tools: 1 effective");
			expect(renderText(modal)).toContain("grep");

			modal.handleInput(" ");
			expect(renderText(modal)).toContain("Preset: External *");
			modal.handleInput("r");
			await Bun.sleep(0);
			expect(rolesConfig.getToolsForRole("default")).toEqual(["grep"]);
			expect(renderText(modal)).toContain("Preset: External");
			expect(renderText(modal)).not.toContain("Preset: External *");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("reverts the active preset without replaying local apply side effects", async () => {
		const errors: string[] = [];
		const harness = await createPresetModalHarness({
			onShowError: message => {
				errors.push(message);
			},
		});
		try {
			const { modal, rolesConfig, settings } = harness;
			const persistSpy = vi.spyOn(settings, "persistModelRolesAtomically");
			const mergeSpy = vi.spyOn(rolesConfig, "mergeConfig");
			openToolsTab(modal);
			modal.handleInput(" ");
			expect(renderText(modal)).toContain("Preset: Baseline *");

			modal.handleInput("r");
			await Bun.sleep(0);

			expect(persistSpy).toHaveBeenCalledTimes(1);
			expect(mergeSpy).toHaveBeenCalledTimes(1);
			expect(errors).toEqual([]);
			expect(rolesConfig.getToolsForRole("default")).toEqual(["read"]);
			expect(renderText(modal)).toContain("Preset: Baseline");
			expect(renderText(modal)).not.toContain("Preset: Baseline *");
		} finally {
			vi.restoreAllMocks();
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("saves the active preset and reverts later changes from the modal", async () => {
		const harness = await createPresetModalHarness();
		try {
			const { modal, presetsConfig, rolesConfig } = harness;
			openToolsTab(modal);
			modal.handleInput(" ");
			expect(renderText(modal)).toContain("Preset: Baseline *");

			modal.handleInput("s");
			expect(renderText(modal)).not.toContain("Preset: Baseline *");
			expect(presetsConfig.getPreset("Baseline")?.roles.default?.tools).toEqual([]);

			modal.handleInput(" ");
			expect(renderText(modal)).toContain("Preset: Baseline *");
			expect(rolesConfig.getToolsForRole("default")).toEqual(["read"]);

			modal.handleInput("r");
			await Bun.sleep(0);
			expect(rolesConfig.getToolsForRole("default")).toEqual([]);
			expect(renderText(modal)).not.toContain("Preset: Baseline *");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("keeps advanced-tab reset bound to the active field while a preset is modified", async () => {
		const harness = await createPresetModalHarness();
		try {
			const { modal, rolesConfig } = harness;
			openToolsTab(modal);
			modal.handleInput(" ");
			expect(rolesConfig.getToolsForRole("default")).toEqual([]);

			modal.handleInput("\x1b[C");
			modal.handleInput(" ");
			expect(rolesConfig.getAdvancedForRole("default")).toEqual({ thinkingLevel: "off" });

			modal.handleInput("r");
			expect(rolesConfig.getAdvancedForRole("default")).toBeNull();
			expect(rolesConfig.getToolsForRole("default")).toEqual([]);
			expect(renderText(modal)).toContain("Preset: Baseline *");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});

	test("shows tools introduced by an externally applied preset", async () => {
		const harness = await createPresetModalHarness();
		try {
			const { modal, presetsConfig } = harness;
			const baseline = presetsConfig.getPreset("Baseline");
			if (!baseline) {
				throw new Error("Baseline preset missing");
			}
			presetsConfig.savePreset("External", {
				...baseline,
				roles: {
					...baseline.roles,
					default: {
						...baseline.roles.default,
						tools: ["grep"],
					},
				},
				updatedAt: "2026-03-27T01:00:00.000Z",
			});

			await presetsConfig.applyPreset("External");
			openToolsTab(modal);
			expect(renderText(modal)).toContain("Tools: 1 effective");
			expect(renderText(modal)).toContain("grep");
		} finally {
			harness.authStorage.close();
			await fs.rm(harness.tempDir, { recursive: true, force: true });
		}
	});
});

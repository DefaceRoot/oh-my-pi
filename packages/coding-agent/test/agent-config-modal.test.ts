import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { RolesConfig } from "../src/config/roles-config";
import { AgentConfigModal } from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";

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

function createModal(
	rolesConfig: RolesConfig,
	options: {
		subagentDefaultTools?: Partial<Record<string, string[]>>;
		modelRoles?: Partial<Record<string, string>>;
		values?: Record<string, string | undefined>;
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
		knownTools,
		subagentDefaultTools,
		knownMcpServers: [],
		discoveredSkills: [],
		modelRegistry: {
			getAll: () => mockModels,
			getAvailable: () => mockModels,
		} as never,
		onDismiss: () => {},
		onRequestRender: () => {},
	} as never);
}

function focusModelTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
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
			expect(renderText(modal)).toContain("inherit: implement");

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toEqual({
				inherit: "implement",
				remove: ["ast_grep"],
			});
			expect(renderText(modal)).toContain("Tools: 0 effective");

			modal.handleInput(" ");
			expect(rolesConfig.getFullConfig().subagents.implement?.tools).toBeUndefined();
			expect(rolesConfig.getToolsForSubagent("implement")).toBeNull();
			expect(renderText(modal)).toContain("Tools: 1 effective (inherit: implement)");
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
			expect(rolesConfig.getFullConfig().subagents.explore?.tools).toBeUndefined();
			expect(rolesConfig.getToolsForSubagent("explore")).toBeNull();
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
			expect(renderText(modal)).toContain("Current: openai/gpt-4o (global default)");
			expect(renderText(modal)).toContain("Override: using global default");
			expect(renderText(modal)).toContain("Global default: openai/gpt-4o");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("default")).toBe("anthropic/claude-haiku");
			expect(renderText(modal)).toContain("Current: anthropic/claude-haiku (agent override)");
			expect(renderText(modal)).toContain("Override: anthropic/claude-haiku");

			modal.handleInput("k");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForRole("default")).toBeNull();
			expect(renderText(modal)).toContain("Current: openai/gpt-4o (global default)");
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
			expect(renderText(modal)).toContain("Current: openai/gpt-4o (global default)");
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
			expect(renderText(modal)).toContain("Current: openai/gpt-4o (global default)");
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
			expect(renderText(modal)).toContain("Current: anthropic/claude-haiku (global default)");
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
			expect(renderText(modal)).toContain("Current: none");
			expect(renderText(modal)).toContain("Override: no override");
			expect(renderText(modal)).toContain("Global default: none");

			focusModelTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");

			expect(rolesConfig.getFallbackForSubagent("implement")).toBe("anthropic/claude-haiku");
			expect(rolesConfig.getFallbackForRole("implement")).toBeNull();
			expect(renderText(modal)).toContain("Current: anthropic/claude-haiku (agent override)");
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

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import type { PresetsConfig } from "../src/config/presets-config";
import { RolesConfig } from "../src/config/roles-config";
import { AgentConfigModal } from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

const mockModels: Model<"anthropic-messages">[] = [
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

function createModal(rolesConfig: RolesConfig): AgentConfigModal {
	return new AgentConfigModal({
		settings: {
			getModelRole: () => undefined,
			get: (key: string) =>
				(
					({
						defaultThinkingLevel: "high",
						"task.maxRecursionDepth": 2,
						"compaction.strategy": "context-full",
						temperature: 0.7,
						"memories.enabled": false,
						"grep.contextBefore": 0,
						"grep.contextAfter": 0,
					}) as Record<string, unknown>
				)[key],
		} as never,
		rolesConfig,
		modelRegistry: {
			getAll: () => mockModels,
			getAvailable: () => mockModels,
		} as never,
		presetsConfig: createStubPresetsConfig(),
		knownTools: ["read", "ask", "mcp_grafana_list_datasources"],
		subagentDefaultTools: {},
		knownMcpServers: ["augment", "grafana"],
		mcpToolServerNames: { mcp_grafana_list_datasources: "grafana" },
		discoveredSkills: [],
		onDismiss: () => {},
		onRequestRender: () => {},
	} as never);
}

function openToolsTab(modal: AgentConfigModal): void {
	const start = renderText(modal);
	if (start.includes("Changes take effect on next session restart")) {
		modal.handleInput("\x1b[C");
		modal.handleInput("\x1b[C");
	} else if (!start.includes("Tools:")) {
		modal.handleInput("\t");
	}
	for (let i = 0; i < 5; i++) {
		if (renderText(modal).includes("Tools:")) return;
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Tools tab not found in modal:\n${renderText(modal)}`);
}

function openMcpTab(modal: AgentConfigModal): void {
	const start = renderText(modal);
	if (start.includes("Tools:")) {
		modal.handleInput("\x1b[D");
		modal.handleInput("\x1b[D");
	} else if (!start.includes("Changes take effect on next session restart")) {
		modal.handleInput("\t");
		modal.handleInput("\x1b[C");
	}
	if (renderText(modal).includes("Changes take effect on next session restart")) return;
	throw new Error(`MCP tab not found in modal:\n${renderText(modal)}`);
}

function openAdvancedTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 7; i++) {
		if (renderText(modal).includes("Max Task Recursion")) return;
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Advanced tab not found in modal:\n${renderText(modal)}`);
}

describe("AgentConfigModal MCP and tool-behavior integration", () => {
	test("shows MCP-derived tools as enabled and persists per-tool disables", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-mcp-tools-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
      - ask
    mcp:
      - augment
      - grafana
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
			expect(renderText(modal)).toContain("Tools: 3 effective");
			expect(renderText(modal)).toContain("mcp_grafana_list_datasources");

			modal.handleInput("j");
			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getDisabledToolsForRole("default")).toEqual(["mcp_grafana_list_datasources"]);
			expect(rolesConfig.getMcpForRole("default")).toEqual(["augment", "grafana"]);
			expect(renderText(modal)).toContain("Tools: 2 effective");

			modal.handleInput(" ");
			expect(rolesConfig.getDisabledToolsForRole("default")).toEqual([]);
			expect(renderText(modal)).toContain("Tools: 3 effective");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("recomputes the Tools view immediately after MCP server changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-mcp-refresh-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
      - ask
    mcp:
      - augment
      - grafana
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
			expect(renderText(modal)).toContain("Tools: 3 effective");

			openMcpTab(modal);
			modal.handleInput("j");
			modal.handleInput(" ");
			expect(rolesConfig.getMcpForRole("default")).toEqual(["augment"]);

			openToolsTab(modal);
			expect(renderText(modal)).toContain("Tools: 2 effective");
			expect(renderText(modal)).toContain("[ ] mcp_grafana_list_datasources");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("persists memory and grep behavior controls through the adjacent settings panel", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-tool-behavior-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:
  default:
    tools:
      - read
      - grep
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

			openAdvancedTab(modal);
			for (let i = 0; i < 4; i++) modal.handleInput("j");
			modal.handleInput(" ");
			modal.handleInput("j");
			modal.handleInput("\n");
			modal.handleInput("2");
			modal.handleInput("\n");
			modal.handleInput("j");
			modal.handleInput("\n");
			modal.handleInput("3");
			modal.handleInput("\n");

			expect(rolesConfig.getAdvancedForRole("default")).toEqual({
				memoriesEnabled: true,
				grepContextBefore: 2,
				grepContextAfter: 3,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

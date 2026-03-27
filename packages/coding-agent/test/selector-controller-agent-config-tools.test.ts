import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "../src/modes/types";

const agentConfigModalOptions: Array<Record<string, unknown>> = [];
const discoverAgentsMock = vi.fn(async () => ({ agents: [] }));
const discoverMcpServerNamesMock = vi.fn(async () => []);
const getManagedToolNamesMock = vi.fn(() => ["read", "ask"]);
let tempAgentDir = "";

mock.module("../src/mcp/config", () => ({
	discoverMCPServerNames: discoverMcpServerNamesMock,
}));

mock.module("../src/task/discovery", () => ({
	discoverAgents: discoverAgentsMock,
}));

mock.module("../src/modes/theme/theme", () => ({
	getAvailableThemes: () => [],
	getSymbolTheme: () => ({ success: "✓", error: "✗", warning: "!", info: "i" }),
	previewTheme: vi.fn(),
	setColorBlindMode: vi.fn(),
	setSymbolPreset: vi.fn(),
	setTheme: vi.fn(),
	theme: {
		bold: (value: string) => value,
		fg: (_token: string, value: string) => value,
		info: (value: string) => value,
		status: { success: "✓", error: "✗", warning: "!" },
	},
}));

mock.module("../src/config/model-registry", () => ({
	MODEL_ROLE_IDS_BY_CATEGORY: { core: ["default"], captain: [], crew: [] },
	MODEL_ROLES: {},
}));

mock.module("../src/config/presets-config", () => ({
	PresetsConfig: class {
		invalidateCache(): void {}
		on(): () => void {
			return () => {};
		}
		applyPreset(): Promise<void> {
			return Promise.resolve();
		}
		getActivePreset(): null {
			return null;
		}
		isModified(): boolean {
			return false;
		}
		getPreset(): undefined {
			return undefined;
		}
		listPresets(): [] {
			return [];
		}
		renamePreset(): void {}
		deletePreset(): void {}
		savePreset(): void {}
		captureCurrentConfig() {
			return { modelRoles: {}, roles: {}, subagents: {} };
		}
	},
}));

mock.module("../src/config/settings", () => ({ settings: {} }));
mock.module("../src/discovery", () => ({ disableProvider: vi.fn(), enableProvider: vi.fn() }));
mock.module("../src/debug", () => ({ DebugSelectorComponent: class {} }));
mock.module("../src/tools", () => ({
	getManagedToolNames: getManagedToolNamesMock,
	inferMcpServerNameFromToolName: (toolName: string, knownServers: string[]) =>
		knownServers.find(serverName =>
			toolName.startsWith(`mcp_${serverName.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_`),
		),
	isCodeSearchProviderId: () => false,
	isHiddenToolName: () => false,
	isSearchProviderPreference: () => false,
	setPreferredCodeSearchProvider: vi.fn(),
	setPreferredImageProvider: vi.fn(),
	setPreferredSearchProvider: vi.fn(),
}));
mock.module("../src/modes/components/agent-config", () => ({
	AgentConfigModal: class {
		constructor(options: Record<string, unknown>) {
			agentConfigModalOptions.push(options);
		}
	},
}));
mock.module("../src/modes/components/agent-config/preset-selector", () => ({ PresetSelector: class {} }));
mock.module("../src/modes/components/agent-dashboard", () => ({ AgentDashboard: class {} }));
mock.module("../src/modes/components/assistant-message", () => ({ AssistantMessageComponent: class {} }));
mock.module("../src/modes/components/extensions", () => ({ ExtensionDashboard: class {} }));
mock.module("../src/modes/components/history-search", () => ({ HistorySearchComponent: class {} }));
mock.module("../src/modes/components/model-selector", () => ({ ModelSelectorComponent: class {} }));
mock.module("../src/modes/components/oauth-selector", () => ({ OAuthSelectorComponent: class {} }));
mock.module("../src/modes/components/session-selector", () => ({ SessionSelectorComponent: class {} }));
mock.module("../src/modes/components/settings-selector", () => ({ SettingsSelectorComponent: class {} }));
mock.module("../src/modes/components/tool-execution", () => ({ ToolExecutionComponent: class {} }));
mock.module("../src/modes/components/tree-selector", () => ({ TreeSelectorComponent: class {} }));
mock.module("../src/modes/components/user-message-selector", () => ({ UserMessageSelectorComponent: class {} }));

import { SelectorController } from "../src/modes/controllers/selector-controller";

function createSelectorContext() {
	const applyRoleToolAllowlist = vi.fn(async () => {});
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const setThinkingLevel = vi.fn();
	const sessionSettings = {
		override: vi.fn(),
		clearOverride: vi.fn(),
		get: vi.fn((key: string) => (key === "temperature" ? -1 : undefined)),
	} as unknown as InteractiveModeContext["session"] extends { settings: infer T } ? T : never;
	const ctx = {
		editorContainer: { addChild: vi.fn(), clear: vi.fn() },
		editor: { setText: vi.fn() },
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		sessionManager: { getLastModelChangeRole: () => "default" },
		settings: {
			getAgentDir: () => tempAgentDir,
			getCwd: () => "/tmp/project",
			get: vi.fn((key: string) => (key === "defaultThinkingLevel" ? "high" : true)),
		} as unknown as InteractiveModeContext["settings"],
		session: {
			modelRegistry: {},
			skills: [],
			settings: sessionSettings,
			applyRoleToolAllowlist,
			refreshBaseSystemPrompt,
			setThinkingLevel,
			agent: {},
		} as unknown as InteractiveModeContext["session"],
		mcpManager: {
			getAllServerNames: () => ["augment", "grafana"],
			getTools: () => [{ name: "mcp_grafana_list_datasources", mcpServerName: "grafana" }],
		} as unknown as InteractiveModeContext["mcpManager"],
	} as unknown as InteractiveModeContext;
	return {
		controller: new SelectorController(ctx),
		applyRoleToolAllowlist,
		refreshBaseSystemPrompt,
		setThinkingLevel,
		sessionSettings,
	};
}

describe("SelectorController agent config tool inventory", () => {
	beforeEach(async () => {
		agentConfigModalOptions.length = 0;
		discoverAgentsMock.mockClear();
		discoverMcpServerNamesMock.mockClear();
		getManagedToolNamesMock.mockClear();
		getManagedToolNamesMock.mockReturnValue(["read", "ask"]);
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "selector-agent-config-"));
		await fs.writeFile(
			path.join(tempAgentDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
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
	});

	afterEach(async () => {
		if (tempAgentDir) {
			await fs.rm(tempAgentDir, { recursive: true, force: true });
			tempAgentDir = "";
		}
	});

	test("includes ask and connected MCP tools in known tool inventory", async () => {
		const { controller } = createSelectorContext();

		await controller.showAgentConfig();
		const modalOptions = agentConfigModalOptions.at(-1);
		expect(modalOptions).toBeDefined();
		expect(modalOptions?.knownTools).toEqual(["read", "ask", "mcp_grafana_list_datasources"]);
	});

	test("wires live session reapply callbacks for current main-role changes", async () => {
		const { controller, applyRoleToolAllowlist, refreshBaseSystemPrompt, setThinkingLevel, sessionSettings } =
			createSelectorContext();

		await controller.showAgentConfig();
		const modalOptions = agentConfigModalOptions.at(-1) as {
			onRoleConfigChanged?: (role: string, section: "tools" | "advanced") => void;
		};
		expect(modalOptions?.onRoleConfigChanged).toBeDefined();

		modalOptions.onRoleConfigChanged?.("default", "tools");
		expect(applyRoleToolAllowlist).toHaveBeenCalledWith("default");

		modalOptions.onRoleConfigChanged?.("default", "advanced");
		expect(setThinkingLevel).toHaveBeenCalled();
		expect(refreshBaseSystemPrompt).toHaveBeenCalled();
		expect(sessionSettings.clearOverride).toHaveBeenCalled();
	});
});

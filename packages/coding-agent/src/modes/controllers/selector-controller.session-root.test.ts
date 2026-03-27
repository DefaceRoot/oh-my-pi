import { beforeEach, describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";

const agentConfigModalOptions: Array<Record<string, unknown>> = [];
interface PresetSelectorOptions {
	onApply?: (preset: string) => void | Promise<void>;
	onClose?: () => void;
	presetsConfig?: unknown;
}
const presetSelectorOptions: PresetSelectorOptions[] = [];
const presetsConfigInstances: unknown[] = [];
const rolesConfigPaths: string[] = [];
const rolesConfigInvalidations: unknown[] = [];
const presetsConfigInvalidations: unknown[] = [];
const discoverAgentsMock = vi.fn(async () => ({ agents: [] }));
const discoverMcpServerNamesMock = vi.fn(async () => []);

mock.module("../../mcp/config", () => ({
	discoverMCPServerNames: discoverMcpServerNamesMock,
}));

mock.module("../../task/discovery", () => ({
	discoverAgents: discoverAgentsMock,
}));

mock.module("../../modes/theme/theme", () => ({
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

mock.module("../../config/model-registry", () => ({
	MODEL_ROLE_IDS_BY_CATEGORY: { core: ["default"], captain: [], crew: [] },
	MODEL_ROLES: {},
}));

mock.module("../../config/roles-config", () => ({
	RolesConfig: class {
		constructor(configPath: string) {
			rolesConfigPaths.push(configPath);
		}

		invalidateCache(): void {
			rolesConfigInvalidations.push(this);
		}

		getMcpForRole(): string[] {
			return [];
		}

		getMcpForSubagent(): string[] {
			return [];
		}

		getFullConfig() {
			return {
				roles: { default: { tools: [], mcp: ["augment"], skills: "all" } },
				subagents: {},
			};
		}

		mergeConfig(): void {}
	},
}));

mock.module("../../config/presets-config", () => ({
	PresetsConfig: class {
		activePreset: string | null = null;

		constructor() {
			presetsConfigInstances.push(this);
		}

		defaultPreset: string | null = null;

		getDefaultPreset(): string | null {
			return this.defaultPreset;
		}

		setDefaultPreset(name: string | null): void {
			this.defaultPreset = name;
		}

		invalidateCache(): void {
			presetsConfigInvalidations.push(this);
		}

		on(): () => void {
			return () => {};
		}

		async applyPreset(name: string): Promise<void> {
			this.activePreset = name;
		}

		getActivePreset(): string | null {
			return this.activePreset;
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

mock.module("../../config/settings", () => ({
	settings: {},
}));

mock.module("../../discovery", () => ({
	disableProvider: vi.fn(),
	enableProvider: vi.fn(),
}));

mock.module("../../debug", () => ({
	DebugSelectorComponent: class {},
}));

mock.module("../../tools", () => ({
	getManagedToolNames: () => [],
	isCodeSearchProviderId: () => false,
	isHiddenToolName: () => false,
	isSearchProviderPreference: () => false,
	setPreferredCodeSearchProvider: vi.fn(),
	setPreferredImageProvider: vi.fn(),
	setPreferredSearchProvider: vi.fn(),
}));

mock.module("../components/agent-config", () => ({
	AgentConfigModal: class {
		constructor(options: Record<string, unknown>) {
			agentConfigModalOptions.push(options);
		}
	},
}));

mock.module("../components/agent-config/preset-selector", () => ({
	PresetSelector: class {
		handleInput = vi.fn();

		constructor(options: Record<string, unknown>) {
			presetSelectorOptions.push(options);
		}
	},
}));

mock.module("../components/agent-dashboard", () => ({
	AgentDashboard: class {},
}));

mock.module("../components/assistant-message", () => ({
	AssistantMessageComponent: class {},
}));

mock.module("../components/extensions", () => ({
	ExtensionDashboard: class {},
}));

mock.module("../components/history-search", () => ({
	HistorySearchComponent: class {},
}));

mock.module("../components/model-selector", () => ({
	ModelSelectorComponent: class {},
}));

mock.module("../components/oauth-selector", () => ({
	OAuthSelectorComponent: class {},
}));

mock.module("../components/session-selector", () => ({
	SessionSelectorComponent: class {},
}));

mock.module("../components/settings-selector", () => ({
	SettingsSelectorComponent: class {},
}));

mock.module("../components/tool-execution", () => ({
	ToolExecutionComponent: class {},
}));

mock.module("../components/tree-selector", () => ({
	TreeSelectorComponent: class {},
}));

mock.module("../components/user-message-selector", () => ({
	UserMessageSelectorComponent: class {},
}));

import { SelectorController } from "./selector-controller";

type MockModel = {
	provider: string;
	id: string;
	name: string;
};

function createModel(provider: string, id: string, name = id): MockModel {
	return { provider, id, name };
}


type CreateSelectorContextOptions = {
	activeRole?: "default" | "ask" | "orchestrator" | "plan";
	configuredRoleModels?: Record<string, string | undefined>;
	resolvedRoleModels?: Record<string, MockModel | undefined>;
	currentModel?: MockModel | undefined;
};


function createSelectorContext(options: CreateSelectorContextOptions = {}) {
	const editorContainer = {
		addChild: vi.fn(),
		clear: vi.fn(),
	} as unknown as InteractiveModeContext["editorContainer"];
	const editor = { setText: vi.fn() } as unknown as InteractiveModeContext["editor"];
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
	} as unknown as InteractiveModeContext["ui"];
	const showStatus = vi.fn();
	const showError = vi.fn();
	const activeRole = options.activeRole ?? "default";
	const configuredRoleModels: Record<string, string | undefined> = {
		default: "anthropic/claude-sonnet-4-5",
		...(options.configuredRoleModels ?? {}),
	};
	const resolvedRoleModels: Record<string, MockModel | undefined> = {
		default: createModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
		...(options.resolvedRoleModels ?? {}),
	};
	let currentModel = options.currentModel ?? resolvedRoleModels[activeRole] ?? resolvedRoleModels.default;
	const setModelTemporary = vi.fn(async (model: MockModel) => {
		currentModel = model;
	});
	const statusLineInvalidate = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const sessionManager = {
		getLastModelChangeRole: () => activeRole,
	} as unknown as InteractiveModeContext["sessionManager"];
	const ctx = {
		editorContainer,
		editor,
		ui,
		statusLine: { invalidate: statusLineInvalidate, setPresetsConfig: vi.fn() },
		updateEditorBorderColor,
		showStatus,
		showError,
		sessionManager,
		settings: {
			getAgentDir: () => "/tmp/agent",
			getCwd: () => "/tmp/project",
			getModelRole: (role: string) => configuredRoleModels[role],
			get: vi.fn(() => true),
		} as unknown as InteractiveModeContext["settings"],
		session: {
			modelRegistry: {},
			skills: [],
			get model() {
				return currentModel;
			},
			resolveRoleModel: (role: string) => resolvedRoleModels[role],
			setModelTemporary,
		} as unknown as InteractiveModeContext["session"],
		mcpManager: { getAllServerNames: () => [] } as unknown as InteractiveModeContext["mcpManager"],
	} as unknown as InteractiveModeContext;

	return {
		controller: new SelectorController(ctx),
		configuredRoleModels,
		editor,
		editorContainer,
		resolvedRoleModels,
		setModelTemporary,
		showError,
		showStatus,
		statusLineInvalidate,
		ui,
		updateEditorBorderColor,
	};
}

function createResumeContext() {
	const handleSessionRootChange = vi.fn();
	const switchSession = vi.fn(async () => true);

	const ctx = {
		session: {
			isStreaming: false,
			switchSession,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: { getCwd: () => "/tmp/project" } as unknown as InteractiveModeContext["sessionManager"],
		chatContainer: {
			addChild: vi.fn(),
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["chatContainer"],
		pendingMessagesContainer: {
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["pendingMessagesContainer"],
		statusContainer: {
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["statusContainer"],
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		ui: {
			requestRender: vi.fn(),
			showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
			setFocus: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		renderInitialMessages: vi.fn(),
		handleSessionRootChange,
	} as unknown as InteractiveModeContext;

	return { controller: new SelectorController(ctx), handleSessionRootChange, switchSession };
}

beforeEach(() => {
	agentConfigModalOptions.length = 0;
	presetSelectorOptions.length = 0;
	presetsConfigInstances.length = 0;
	rolesConfigPaths.length = 0;
	rolesConfigInvalidations.length = 0;
	presetsConfigInvalidations.length = 0;
	discoverAgentsMock.mockClear();
	discoverMcpServerNamesMock.mockClear();
});

describe("SelectorController preset selector", () => {
	it("reuses the same presets config for standalone and modal flows", async () => {
		const { controller } = createSelectorContext();

		controller.showPresetSelector();
		const standaloneOptions = presetSelectorOptions.at(-1);
		expect(standaloneOptions).toBeDefined();

		await controller.showAgentConfig();
		const modalOptions = agentConfigModalOptions.at(-1);
		expect(modalOptions).toBeDefined();
		expect(modalOptions?.presetsConfig).toBe(standaloneOptions?.presetsConfig);
		expect(presetsConfigInstances).toHaveLength(1);
		expect(rolesConfigPaths).toEqual(["/tmp/agent/roles.yml"]);
		expect(rolesConfigInvalidations).toHaveLength(2);
		expect(presetsConfigInvalidations).toHaveLength(2);
	});

	it("refreshes cached config before reopening the standalone selector", () => {
		const { controller } = createSelectorContext();

		controller.showPresetSelector();
		controller.showPresetSelector();

		expect(presetsConfigInstances).toHaveLength(1);
		expect(rolesConfigInvalidations).toHaveLength(2);
		expect(presetsConfigInvalidations).toHaveLength(2);
	});

	it("shows status and restores the editor after applying a preset", async () => {
		const { controller, editor, editorContainer, showStatus, ui } = createSelectorContext();

		controller.showPresetSelector();
		const standaloneOptions = presetSelectorOptions.at(-1);
		expect(standaloneOptions).toBeDefined();

		await standaloneOptions?.onApply?.("Focus");

		expect(showStatus).toHaveBeenCalledWith("Applied Focus.");
		expect(editorContainer.addChild).toHaveBeenLastCalledWith(editor);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("restores the editor without applying when the selector closes", () => {
		const { controller, editor, editorContainer, showStatus, ui } = createSelectorContext();

		controller.showPresetSelector();
		const standaloneOptions = presetSelectorOptions.at(-1);
		expect(standaloneOptions).toBeDefined();

		standaloneOptions?.onClose?.();

		expect(showStatus).not.toHaveBeenCalled();
		expect(editorContainer.addChild).toHaveBeenLastCalledWith(editor);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("refreshes the live session model after config closes with a new model", async () => {
		const {
			controller,
			configuredRoleModels,
			resolvedRoleModels,
			setModelTemporary,
			statusLineInvalidate,
			updateEditorBorderColor,
		} = createSelectorContext();

		await controller.showAgentConfig();
		const modalOptions = agentConfigModalOptions.at(-1) as {
			onDismiss?: () => Promise<void> | void;
		};
		expect(modalOptions?.onDismiss).toBeDefined();

		const refreshedModel = createModel("openai", "gpt-5", "GPT-5");
		configuredRoleModels.default = "openai/gpt-5";
		resolvedRoleModels.default = refreshedModel;

		await modalOptions.onDismiss?.();

		expect(setModelTemporary).toHaveBeenCalledWith(refreshedModel, "default");
		expect(statusLineInvalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("refreshes ask mode when it inherits the default model", async () => {
		const {
			controller,
			configuredRoleModels,
			resolvedRoleModels,
			setModelTemporary,
			statusLineInvalidate,
			updateEditorBorderColor,
		} = createSelectorContext({ activeRole: "ask" });

		await controller.showAgentConfig();
		const modalOptions = agentConfigModalOptions.at(-1) as {
			onDismiss?: () => Promise<void> | void;
		};
		expect(modalOptions?.onDismiss).toBeDefined();

		const refreshedDefaultModel = createModel("openai", "gpt-5", "GPT-5");
		configuredRoleModels.default = "openai/gpt-5";
		resolvedRoleModels.default = refreshedDefaultModel;

		await modalOptions.onDismiss?.();

		expect(setModelTemporary).toHaveBeenCalledWith(refreshedDefaultModel, "ask");
		expect(statusLineInvalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});
});

describe("SelectorController session-root-change reset", () => {
	it("calls handleSessionRootChange after successful switchSession in handleResumeSession", async () => {
		const { controller, handleSessionRootChange, switchSession } = createResumeContext();

		await controller.handleResumeSession("/tmp/project/.omp/other-session.jsonl");

		expect(switchSession).toHaveBeenCalledWith("/tmp/project/.omp/other-session.jsonl");
		expect(handleSessionRootChange).toHaveBeenCalledTimes(1);
	});
});

describe("SelectorController applyDefaultPresetIfConfigured", () => {
	function createDefaultPresetContext(initialActive: string | null = null, defaultPresetName: string | null = "Work") {
		const { controller } = createSelectorContext();
		// Trigger lazy PresetsConfig construction (it's created on first store access).
		controller.initPresetsForStatusLine();
		const presetsConfig = presetsConfigInstances.at(-1) as {
			activePreset: string | null;
			defaultPreset: string | null;
		};
		presetsConfig.activePreset = initialActive;
		presetsConfig.defaultPreset = defaultPresetName;
		return { controller, presetsConfig };
	}

	it("applies default preset when no preset is currently active", async () => {
		const { controller, presetsConfig } = createDefaultPresetContext(null, "Work");

		await controller.applyDefaultPresetIfConfigured();

		expect(presetsConfig.activePreset).toBe("Work");
	});

	it("does not apply default when a preset is already active", async () => {
		const { controller, presetsConfig } = createDefaultPresetContext("Personal", "Work");

		await controller.applyDefaultPresetIfConfigured();

		expect(presetsConfig.activePreset).toBe("Personal");
	});

	it("applies default even when a different preset is active when forceApply is set", async () => {
		const { controller, presetsConfig } = createDefaultPresetContext("Personal", "Work");

		await controller.applyDefaultPresetIfConfigured({ forceApply: true });

		expect(presetsConfig.activePreset).toBe("Work");
	});

	it("is a no-op when no default preset is configured", async () => {
		const { controller, presetsConfig } = createDefaultPresetContext(null, null);

		await controller.applyDefaultPresetIfConfigured({ forceApply: true });

		expect(presetsConfig.activePreset).toBeNull();
	});
});

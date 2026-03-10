import { describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";

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
	MODEL_ROLES: {},
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
	setPreferredImageProvider: vi.fn(),
	setPreferredSearchProvider: vi.fn(),
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

function createResumeContext() {
	const handleSessionRootChange = vi.fn();
	const switchSession = vi.fn(async () => true);

	const ctx = {
		session: {
			isStreaming: false,
			switchSession,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {} as unknown as InteractiveModeContext["sessionManager"],
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

describe("SelectorController session-root-change reset", () => {
	it("calls handleSessionRootChange after successful switchSession in handleResumeSession", async () => {
		const { controller, handleSessionRootChange, switchSession } = createResumeContext();

		await controller.handleResumeSession("/tmp/project/.omp/other-session.jsonl");

		expect(switchSession).toHaveBeenCalledWith("/tmp/project/.omp/other-session.jsonl");
		expect(handleSessionRootChange).toHaveBeenCalledTimes(1);
	});
});

import { describe, expect, test, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";

function createContext(options?: { runningJobs?: number; loadingAnimation?: unknown; editorText?: string }) {
	const runningJobs = options?.runningJobs ?? 0;
	const defaultModel = { provider: "anthropic", id: "default-model", name: "Default Model" };
	const session = {
		isBashRunning: false,
		abortBash: vi.fn(),
		isPythonRunning: false,
		abortPython: vi.fn(),
		model: defaultModel,
		resolveRoleModel: vi.fn((role: string) => {
			if (role === "ask") return { provider: "anthropic", id: "ask-model", name: "Ask Model" };
			if (role === "orchestrator") return { provider: "anthropic", id: "orchestrator-model", name: "Orchestrator Model" };
			if (role === "plan") return { provider: "anthropic", id: "plan-model", name: "Plan Model" };
			return defaultModel;
		}),
		cancelRunningAsyncJobs: vi.fn(() => runningJobs),
		getAsyncJobSnapshot: vi.fn(() => ({
			running: Array.from({ length: runningJobs }, (_, index) => ({
				id: `job-${index + 1}` ,
				type: "task",
				status: "running",
				label: `job-${index + 1}`,
				startTime: 1_000 + index,
			})),
			recent: [],
		})),
	};
	const editor = {
		onEscape: undefined as (() => void) | undefined,
		onCtrlC: undefined as (() => void) | undefined,
		onCtrlD: undefined as (() => void) | undefined,
		onCtrlZ: undefined as (() => void) | undefined,
		onShiftTab: undefined as (() => void) | undefined,
		onCtrlP: undefined as (() => void) | undefined,
		onShiftCtrlP: undefined as (() => void) | undefined,
		onAltP: undefined as (() => void) | undefined,
		onCtrlL: undefined as (() => void) | undefined,
		onCtrlR: undefined as (() => void) | undefined,
		onCtrlT: undefined as (() => void) | undefined,
		onQuestionMark: undefined as (() => void) | undefined,
		onCtrlV: undefined as (() => void) | undefined,
		onAltUp: undefined as (() => void) | undefined,
		setCustomKeyHandler: vi.fn(),
		getText: vi.fn(() => options?.editorText ?? ""),
		setText: vi.fn(),
	};
	const ctx = {
		editor,
		statusLine: {
			getActiveMenu: vi.fn(() => undefined),
			closeMenu: vi.fn(),
		},
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(() => vi.fn()),
			onDebug: undefined as (() => void) | undefined,
		},
		session,
		sessionManager: {
			getLastModelChangeRole: vi.fn(() => "default"),
		},
		keybindings: {
			getKeys: vi.fn(() => []),
		},
		agent: {
			abort: vi.fn(),
		},
		isSubagentViewActive: vi.fn(() => false),
		exitSubagentView: vi.fn(),
		loadingAnimation: options?.loadingAnimation,
		isBashMode: false,
		isPythonMode: false,
		updateEditorBorderColor: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showStatus: vi.fn(),
		lastEscapeTime: 0,
		toggleTodoExpansion: vi.fn(),
		showModelSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		handleHotkeysCommand: vi.fn(),
	} as any;
	return { ctx, session, editor };
}

function setupController(options?: { runningJobs?: number; loadingAnimation?: unknown; editorText?: string }) {
	const { ctx, session, editor } = createContext(options);
	const controller = new InputController(ctx);
	(controller as any).registerExtensionShortcuts = vi.fn();
	controller.setupKeyHandlers();
	return { controller, ctx, session, editor };
}

describe("InputController escape handling", () => {
	test("escape cancels running background jobs before double-escape navigation", () => {
		const { ctx, session, editor } = setupController({ runningJobs: 2, editorText: "keep draft" });

		editor.onEscape?.();

		expect(session.cancelRunningAsyncJobs).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(ctx.lastEscapeTime).toBe(0);
	});

	test("escape cancels running background jobs while aborting the current stream", () => {
		const { controller, session, editor } = setupController({ runningJobs: 1, loadingAnimation: { active: true } });
		const restoreSpy = vi.spyOn(controller, "restoreQueuedMessagesToEditor").mockImplementation(() => 0);

		editor.onEscape?.();

		expect(restoreSpy).toHaveBeenCalledWith({ abort: true });
		expect(session.cancelRunningAsyncJobs).toHaveBeenCalledTimes(1);
	});
});

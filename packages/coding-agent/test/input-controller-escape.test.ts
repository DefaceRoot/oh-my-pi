import { describe, expect, it, test, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";

function createSimpleContext(options?: { runningJobs?: number; loadingAnimation?: unknown; editorText?: string }) {
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
			if (role === "orchestrator")
				return { provider: "anthropic", id: "orchestrator-model", name: "Orchestrator Model" };
			if (role === "plan") return { provider: "anthropic", id: "plan-model", name: "Plan Model" };
			return defaultModel;
		}),
		cancelRunningAsyncJobs: vi.fn(() => runningJobs),
		getAsyncJobSnapshot: vi.fn(() => ({
			running: Array.from({ length: runningJobs }, (_, index) => ({
				id: `job-${index + 1}`,
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
	const { ctx, session, editor } = createSimpleContext(options);
	const controller = new InputController(ctx);
	(controller as any).registerExtensionShortcuts = vi.fn();
	controller.setupKeyHandlers();
	return { controller, ctx, session, editor };
}

type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	shouldBypassAutocompleteOnEscape?: () => boolean;
	onClear?: () => void;
	onExit?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onQuickSelectModel?: () => void;
	onSelectModel?: () => void;
	onHistorySearch?: () => void;
	onShowHotkeys?: () => void;
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createSubmission(input: {
	text: string;
	images?: InteractiveModeContext["pendingImages"];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: ReturnType<typeof vi.fn>;
		abortBash: ReturnType<typeof vi.fn>;
		abortPython: ReturnType<typeof vi.fn>;
		addMessageToChat: ReturnType<typeof vi.fn>;
		cancelPendingSubmission: ReturnType<typeof vi.fn>;
		clearQueue: ReturnType<typeof vi.fn>;
		ensureLoadingAnimation: ReturnType<typeof vi.fn>;
		handleBtwCommand: ReturnType<typeof vi.fn>;
		handleBtwEscape: ReturnType<typeof vi.fn>;
		hasActiveBtw: ReturnType<typeof vi.fn>;
		onInputCallback: ReturnType<typeof vi.fn>;
		prompt: ReturnType<typeof vi.fn>;
		requestRender: ReturnType<typeof vi.fn>;
		startPendingSubmission: ReturnType<typeof vi.fn>;
	};
} {
	let editorText = "";
	const abort = vi.fn();
	const abortBash = vi.fn();
	const abortPython = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const prompt = vi.fn();
	const requestRender = vi.fn();
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const startPendingSubmission = vi.fn((input: { text: string; images?: InteractiveModeContext["pendingImages"] }) => {
		ensureLoadingAnimation();
		return createSubmission(input);
	});
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	let ctx!: InteractiveModeContext;
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isPythonRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortPython,
			clearQueue,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getSessionName: () => "existing session",
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
		} as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortPython,
			addMessageToChat,
			cancelPendingSubmission,
			clearQueue,
			ensureLoadingAnimation,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			onInputCallback,
			prompt,
			requestRender,
			startPendingSubmission,
		},
	};
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

describe("InputController escape behavior", () => {
	it("prefers canceling a pending optimistic submission before aborting the session", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({ text: "hello", images: undefined });
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("falls back to aborting the active session when no pending optimistic submission exists", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});

	it("prefers aborting bash before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting python before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isPythonRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isPythonRunning: boolean }).isPythonRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortPython).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		expect(editor.shouldBypassAutocompleteOnEscape?.()).toBe(true);
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts streaming even when the working loader is no longer present", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});
});

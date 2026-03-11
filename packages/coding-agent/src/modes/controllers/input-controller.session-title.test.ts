import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";

const generateSessionTitleMock = vi.fn();
const setTerminalTitleMock = vi.fn();

mock.module("../../utils/title-generator", () => ({
	generateSessionTitle: generateSessionTitleMock,
	setTerminalTitle: setTerminalTitleMock,
}));

mock.module("../action-buttons", () => ({
	WORKFLOW_MENUS: [],
}));

const { InputController } = await import("./input-controller");

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

type SessionTitleFixture = {
	submit: (text: string) => Promise<void>;
	setCurrentSession: (next: { sessionId: string; title?: string }) => void;
	getCurrentTitle: () => string | undefined;
	setSessionNameSpy: ReturnType<typeof vi.fn>;
	editorAddToHistorySpy: ReturnType<typeof vi.fn>;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createSessionTitleFixture(initial: { sessionId: string; title?: string }): SessionTitleFixture {
	let currentSessionId = initial.sessionId;
	let currentTitle = initial.title;
	const editorAddToHistorySpy = vi.fn();
	const setSessionNameSpy = vi.fn(async (name: string) => {
		currentTitle = name;
	});
	const editor = {
		setText: vi.fn(),
		addToHistory: editorAddToHistorySpy,
		setCustomKeyHandler: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		statusLine: {
			getActiveMenu: vi.fn(() => null),
			executeSelectedMenuAction: vi.fn(),
		},
		agent: { state: { messages: [] } },
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			isCompacting: false,
			isBashRunning: false,
			isPythonRunning: false,
			sessionId: currentSessionId,
			modelRegistry: {},
			extensionRunner: undefined,
		},
		sessionManager: {
			getSessionName: vi.fn(() => currentTitle),
			setSessionName: setSessionNameSpy,
		},
		settings: {
			getModelRole: vi.fn(() => undefined),
		},
		pendingImages: [],
		flushPendingBashComponents: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();

	return {
		submit: async (text: string) => {
			const submitHandler = ctx.editor.onSubmit as ((value: string) => Promise<void>) | undefined;
			if (!submitHandler) throw new Error("Missing editor submit handler");
			await submitHandler(text);
		},
		setCurrentSession: next => {
			currentSessionId = next.sessionId;
			currentTitle = next.title;
			(ctx.session as { sessionId: string }).sessionId = next.sessionId;
		},
		getCurrentTitle: () => currentTitle,
		setSessionNameSpy,
		editorAddToHistorySpy,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	generateSessionTitleMock.mockReset();
	setTerminalTitleMock.mockReset();
	vi.restoreAllMocks();
});

describe("InputController session title generation", () => {
	it("does not overwrite a resumed session title when an earlier title request resolves late", async () => {
		const deferred = createDeferred<string | null>();
		generateSessionTitleMock.mockReturnValue(deferred.promise);
		const fixture = createSessionTitleFixture({ sessionId: "source-session" });

		await fixture.submit("resume ui component");
		expect(generateSessionTitleMock).toHaveBeenCalledWith("resume ui component", {}, undefined, "source-session");

		fixture.setCurrentSession({ sessionId: "resumed-session", title: "Original Session" });
		deferred.resolve("Resume UI Component");
		await flushMicrotasks();

		expect(fixture.setSessionNameSpy).not.toHaveBeenCalled();
		expect(setTerminalTitleMock).not.toHaveBeenCalled();
		expect(fixture.getCurrentTitle()).toBe("Original Session");
		expect(fixture.editorAddToHistorySpy).toHaveBeenCalledWith("resume ui component");
	});

	it("still applies the generated title when the active session has not changed", async () => {
		const deferred = createDeferred<string | null>();
		generateSessionTitleMock.mockReturnValue(deferred.promise);
		const fixture = createSessionTitleFixture({ sessionId: "source-session" });

		await fixture.submit("build ui component");
		deferred.resolve("Build UI Component");
		await flushMicrotasks();

		expect(fixture.setSessionNameSpy).toHaveBeenCalledWith("Build UI Component");
		expect(setTerminalTitleMock).toHaveBeenCalledWith("π: Build UI Component");
		expect(fixture.getCurrentTitle()).toBe("Build UI Component");
	});
});

import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import type { InteractiveModeContext } from "../../modes/types";

const spawnMock = vi.fn();
const getProjectDirMock = vi.fn(() => "/tmp/lazygit-test-cwd");

mock.module("node:child_process", () => ({
	spawn: spawnMock,
}));

mock.module("@oh-my-pi/pi-utils", () => ({
	$env: process.env,
	getProjectDir: getProjectDirMock,
}));

import { InputController } from "./input-controller";

type InputControllerWithLazygit = InputController & {
	openLazygit: () => Promise<void>;
	openEditorTerminalHandle: () => Promise<FileHandle | null>;
};

type LazygitFixture = {
	controller: InputControllerWithLazygit;
	ttyCloseSpy: ReturnType<typeof vi.fn>;
	uiStopSpy: ReturnType<typeof vi.fn>;
	uiStartSpy: ReturnType<typeof vi.fn>;
	uiRequestRenderSpy: ReturnType<typeof vi.fn>;
	releaseTerminalHandle: () => void;
	releaseTtyClose: () => void;
};

type ControllableChild = {
	process: ChildProcess;
	emitExit: () => void;
	hasExitListener: () => boolean;
};

function createControllableChild(): ControllableChild {
	const emitter = new EventEmitter();
	return {
		process: emitter as ChildProcess,
		emitExit: () => {
			emitter.emit("exit", 0);
		},
		hasExitListener: () => emitter.listenerCount("exit") > 0,
	};
}

function createFixture(): LazygitFixture {
	const uiStopSpy = vi.fn();
	const uiStartSpy = vi.fn();
	const uiRequestRenderSpy = vi.fn();
	let resolveTtyClose: (() => void) | null = null;
	const ttyCloseSpy = vi.fn(async () => {
		await new Promise<void>((resolve) => {
			resolveTtyClose = resolve;
		});
	});
	const ttyHandle = { fd: 77, close: ttyCloseSpy } as unknown as FileHandle;
	let resolveTerminalHandle: ((handle: FileHandle | null) => void) | null = null;
	const terminalHandlePromise = new Promise<FileHandle | null>((resolve) => {
		resolveTerminalHandle = resolve;
	});

	const ctx = {
		ui: {
			stop: uiStopSpy,
			start: uiStartSpy,
			requestRender: uiRequestRenderSpy,
		},
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new InputController(ctx) as InputControllerWithLazygit;
	vi.spyOn(controller, "openEditorTerminalHandle").mockReturnValue(terminalHandlePromise);

	return {
		controller,
		ttyCloseSpy,
		uiStopSpy,
		uiStartSpy,
		uiRequestRenderSpy,
		releaseTerminalHandle: () => resolveTerminalHandle?.(ttyHandle),
		releaseTtyClose: () => resolveTtyClose?.(),
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for async test condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function createKeyHandlerFixture(lazygitKeys: string[], externalEditorKeys: string[]) {
	const customHandlers = new Map<string, () => unknown>();
	const setCustomKeyHandlerSpy = vi.fn((key: string, handler: () => unknown) => {
		customHandlers.set(key, handler);
	});
	const getKeysSpy = vi.fn((action: string) => {
		if (action === "lazygit") return lazygitKeys;
		if (action === "externalEditor") return externalEditorKeys;
		return [];
	});
	const editor = {
		setCustomKeyHandler: setCustomKeyHandlerSpy,
		setText: vi.fn(),
		getText: vi.fn(() => ""),
		addToHistory: vi.fn(),
		insertText: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		keybindings: { getKeys: getKeysSpy },
		statusLine: {
			getActiveMenu: vi.fn(() => null),
			closeMenu: vi.fn(),
			toggleMenu: vi.fn(),
			navigateMenu: vi.fn(),
		},
		ui: { requestRender: vi.fn(), onDebug: undefined },
		session: { extensionRunner: undefined },
		isSubagentViewActive: vi.fn(() => false),
		exitSubagentView: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		showModelSelector: vi.fn(),
		showDebugSelector: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		handleClearCommand: vi.fn(),
		showSessionSelector: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const openLazygitSpy = vi.spyOn(controller, "openLazygit").mockResolvedValue();
	const openExternalEditorSpy = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
	return { controller, customHandlers, getKeysSpy, setCustomKeyHandlerSpy, openLazygitSpy, openExternalEditorSpy };
}

function createSubmitInterceptFixture() {
	const editorSetTextSpy = vi.fn();
	const editorAddToHistorySpy = vi.fn();
	const sessionPromptSpy = vi.fn(async () => undefined);
	const editor = {
		setText: editorSetTextSpy,
		addToHistory: editorAddToHistorySpy,
		setCustomKeyHandler: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		statusLine: { getActiveMenu: vi.fn(() => null), executeSelectedMenuAction: vi.fn() },
		session: {
			isStreaming: true,
			queuedMessageCount: 0,
			isCompacting: false,
			prompt: sessionPromptSpy,
			extensionRunner: undefined,
		},
		pendingImages: [],
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const openLazygitSpy = vi.spyOn(controller, "openLazygit").mockResolvedValue();
	controller.setupEditorSubmitHandler();
	return {
		openLazygitSpy,
		editorSetTextSpy,
		editorAddToHistorySpy,
		sessionPromptSpy,
		submit: async (text: string) => {
			const submitHandler = ctx.editor.onSubmit as ((value: string) => Promise<void>) | undefined;
			if (!submitHandler) throw new Error("Missing editor submit handler");
			await submitHandler(text);
		},
	};
}

afterEach(() => {
	spawnMock.mockReset();
	getProjectDirMock.mockReset();
	getProjectDirMock.mockReturnValue("/tmp/lazygit-test-cwd");
	vi.restoreAllMocks();
	delete process.env.GIT_DIR;
	delete process.env.GIT_WORK_TREE;
});

describe("InputController openLazygit", () => {
	it("launches lazygit in project cwd with a sanitized git environment", async () => {
		const fixture = createFixture();
		vi.spyOn(Bun, "which").mockReturnValue("/usr/bin/lazygit");
		getProjectDirMock.mockReturnValue("/tmp/repo-cwd");
		process.env.GIT_DIR = "/tmp/should-not-leak/git-dir";
		process.env.GIT_WORK_TREE = "/tmp/should-not-leak/work-tree";
		const child = createControllableChild();
		spawnMock.mockReturnValue(child.process);

		const runPromise = fixture.controller.openLazygit();
		expect(fixture.uiStopSpy).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();

		fixture.releaseTerminalHandle();
		await waitFor(() => spawnMock.mock.calls.length === 1);
		expect(fixture.uiStopSpy).toHaveBeenCalledTimes(1);
		expect(fixture.uiStopSpy.mock.invocationCallOrder[0]).toBeLessThan(
			spawnMock.mock.invocationCallOrder[0],
		);

		const [command, args, options] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ env: Record<string, string | undefined>; stdio: [number, number, number] }
		];
		expect(command).toBe("lazygit");
		expect(args).toEqual(["-p", "/tmp/repo-cwd"]);
		expect(options.stdio).toEqual([77, 77, 77]);
		expect(options.env.GIT_DIR).toBeUndefined();
		expect(options.env.GIT_WORK_TREE).toBeUndefined();

		await waitFor(() => child.hasExitListener());
		child.emitExit();
		await waitFor(() => fixture.ttyCloseSpy.mock.calls.length === 1);
		fixture.releaseTtyClose();
		await runPromise;
	});

	it("restores the TUI state and render after lazygit exits", async () => {
		const fixture = createFixture();
		vi.spyOn(Bun, "which").mockReturnValue("/usr/bin/lazygit");
		const child = createControllableChild();
		spawnMock.mockReturnValue(child.process);

		const runPromise = fixture.controller.openLazygit();
		let didResolve = false;
		runPromise.finally(() => {
			didResolve = true;
		});
		fixture.releaseTerminalHandle();
		await waitFor(() => spawnMock.mock.calls.length === 1);
		expect(fixture.uiStartSpy).not.toHaveBeenCalled();
		expect(fixture.uiRequestRenderSpy).not.toHaveBeenCalled();
		expect(didResolve).toBe(false);

		await waitFor(() => child.hasExitListener());
		expect(fixture.uiStartSpy).not.toHaveBeenCalled();
		expect(fixture.uiRequestRenderSpy).not.toHaveBeenCalled();
		child.emitExit();
		await waitFor(() => fixture.ttyCloseSpy.mock.calls.length === 1);
		expect(fixture.uiStartSpy).not.toHaveBeenCalled();
		expect(fixture.uiRequestRenderSpy).not.toHaveBeenCalled();
		expect(didResolve).toBe(false);

		fixture.releaseTtyClose();
		await runPromise;

		expect(fixture.ttyCloseSpy).toHaveBeenCalledTimes(1);
		expect(fixture.uiStartSpy).toHaveBeenCalledTimes(1);
		expect(fixture.uiRequestRenderSpy).toHaveBeenCalledTimes(1);
		expect(didResolve).toBe(true);
		expect(spawnMock.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.uiStartSpy.mock.invocationCallOrder[0],
		);
		expect(fixture.uiStartSpy.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.uiRequestRenderSpy.mock.invocationCallOrder[0],
		);
	});
});


describe("InputController lazygit keybinding and submit wiring", () => {
	it("registers custom handlers for each configured lazygit and external editor key", () => {
		const lazygitKeys = ["alt+g", "alt+shift+g"];
		const externalEditorKeys = ["alt+e", "alt+shift+e"];
		const fixture = createKeyHandlerFixture(lazygitKeys, externalEditorKeys);
		fixture.controller.setupKeyHandlers();

		expect(fixture.getKeysSpy).toHaveBeenCalledWith("lazygit");
		expect(fixture.getKeysSpy).toHaveBeenCalledWith("externalEditor");

		for (const key of lazygitKeys) {
			const handler = fixture.customHandlers.get(key);
			expect(handler).toBeTypeOf("function");
			(handler as () => unknown)();
		}
		for (const key of externalEditorKeys) {
			const handler = fixture.customHandlers.get(key);
			expect(handler).toBeTypeOf("function");
			(handler as () => unknown)();
		}

		expect(fixture.openLazygitSpy).toHaveBeenCalledTimes(lazygitKeys.length);
		expect(fixture.openExternalEditorSpy).toHaveBeenCalledTimes(externalEditorKeys.length);
	});

	it("intercepts typed /lazygit before streaming prompt dispatch", async () => {
		const fixture = createSubmitInterceptFixture();
		await fixture.submit("/lazygit");

		expect(fixture.editorSetTextSpy).toHaveBeenCalledWith("");
		expect(fixture.openLazygitSpy).toHaveBeenCalledTimes(1);
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
		expect(fixture.editorAddToHistorySpy).not.toHaveBeenCalled();
	});
});
import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as readlinePromises from "node:readline/promises";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { FileHandle } from "node:fs/promises";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../../modes/types";

const spawnMock = vi.fn();
const getSessionCwdMock = vi.fn(() => "/tmp/lazygit-test-cwd");

mock.module("node:child_process", () => ({
	...childProcess,
	spawn: spawnMock,
}));

mock.module("@oh-my-pi/pi-utils", () => ({
	...piUtils,
	$env: process.env,
}));

mock.module("../action-buttons", () => ({
	WORKFLOW_MENUS: [],
}));

const { detectLazygitInstallCommand, InputController } = await import("./input-controller");

type InputControllerWithLazygit = {
	openLazygit: () => Promise<void>;
	openEditorTerminalHandle: () => Promise<FileHandle | null>;
	toggleSTT: () => Promise<void>;
};

type LazygitFixture = {
	controller: InputControllerWithLazygit;
	ttyCloseSpy: ReturnType<typeof vi.fn>;
	uiStopSpy: ReturnType<typeof vi.fn>;
	uiStartSpy: ReturnType<typeof vi.fn>;
	uiRequestRenderSpy: ReturnType<typeof vi.fn>;
	showWarningSpy: ReturnType<typeof vi.fn>;
	releaseTerminalHandle: () => void;
	releaseTtyClose: () => void;
};

type ControllableChild = {
	process: ChildProcess;
	emitExit: () => void;
	hasExitListener: () => boolean;
};

const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
if (!originalProcessPlatformDescriptor) {
	throw new Error("Missing process.platform descriptor");
}

function setProcessPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		configurable: true,
		value: platform,
	});
}

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
	const showWarningSpy = vi.fn();
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
		showWarning: showWarningSpy,
		sessionManager: { getCwd: getSessionCwdMock },
	} as unknown as InteractiveModeContext;

	const controller = new InputController(ctx) as unknown as InputControllerWithLazygit;
	vi.spyOn(controller, "openEditorTerminalHandle").mockReturnValue(terminalHandlePromise);

	return {
		controller,
		ttyCloseSpy,
		uiStopSpy,
		uiStartSpy,
		uiRequestRenderSpy,
		showWarningSpy,
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

function createKeyHandlerFixture(
	lazygitKeys: string[],
	externalEditorKeys: string[],
	sttKeys: string[] = [],
) {
	const customHandlers = new Map<string, () => unknown>();
	const setCustomKeyHandlerSpy = vi.fn((key: string, handler: () => unknown) => {
		customHandlers.set(key, handler);
	});
	const getKeysSpy = vi.fn((action: string) => {
		if (action === "lazygit") return lazygitKeys;
		if (action === "externalEditor") return externalEditorKeys;
		if (action === "toggleSTT") return sttKeys;
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
		ui: { requestRender: vi.fn(), onDebug: undefined, addInputListener: vi.fn(() => vi.fn()) },
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
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		registerExtensionShortcuts: vi.fn(),
		handlePlanModeCommand: vi.fn(async () => undefined),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const openLazygitSpy = vi.spyOn(controller, "openLazygit").mockResolvedValue();
	const openExternalEditorSpy = vi.spyOn(controller, "openExternalEditor").mockResolvedValue();
	const toggleSTTSpy = vi.spyOn(controller, "toggleSTT").mockResolvedValue();
	return {
		controller,
		customHandlers,
		getKeysSpy,
		setCustomKeyHandlerSpy,
		openLazygitSpy,
		openExternalEditorSpy,
		toggleSTTSpy,
	};
}

function createSubmitInterceptFixture() {
	const editorSetTextSpy = vi.fn();
	const editorAddToHistorySpy = vi.fn();
	const sessionPromptSpy = vi.fn(async () => undefined);
	const showStatusSpy = vi.fn();
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
		showStatus: showStatusSpy,
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	const openLazygitSpy = vi.spyOn(controller, "openLazygit").mockResolvedValue();
	const toggleSTTSpy = vi.spyOn(controller, "toggleSTT").mockResolvedValue();
	controller.setupEditorSubmitHandler();
	return {
		openLazygitSpy,
		toggleSTTSpy,
		showStatusSpy,
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

function createWorkflowMenuSubmitFixture(action: { id: string; command: string; editorText?: string }) {
	const sessionPromptSpy = vi.fn(async () => undefined);
	const editorSetTextSpy = vi.fn();
	const editor = {
		setText: editorSetTextSpy,
		addToHistory: vi.fn(),
		setCustomKeyHandler: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		statusLine: {
			getActiveMenu: vi.fn(() => "worktree"),
			executeSelectedMenuAction: vi.fn(() => ({ ...action, baseLabel: action.id })),
			invalidate: vi.fn(),
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			isCompacting: false,
			prompt: sessionPromptSpy,
			extensionRunner: undefined,
		},
		sessionManager: { moveTo: vi.fn(), getCwd: vi.fn(() => "/tmp/session-cwd") },
		pendingImages: [],
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		updateEditorTopBorder: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return {
		controller,
		sessionPromptSpy,
		editorSetTextSpy,
		submit: async (text: string) => {
			const submitHandler = ctx.editor.onSubmit as ((value: string) => Promise<void>) | undefined;
			if (!submitHandler) throw new Error("Missing editor submit handler");
			await submitHandler(text);
		},
	};
}

afterEach(() => {
	spawnMock.mockReset();
	getSessionCwdMock.mockReset();
	getSessionCwdMock.mockReturnValue("/tmp/lazygit-test-cwd");
	vi.restoreAllMocks();
	Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
	delete process.env.GIT_DIR;
	delete process.env.GIT_WORK_TREE;
});

describe("InputController openLazygit", () => {
	it("launches lazygit in current session cwd with a sanitized git environment", async () => {
		const fixture = createFixture();
		vi.spyOn(Bun, "which").mockReturnValue("/usr/bin/lazygit");
		getSessionCwdMock.mockReturnValue("/tmp/repo-cwd");
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
			{ env: Record<string, string | undefined>; stdio: [number, number, number] },
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

describe("detectLazygitInstallCommand", () => {
	it("returns null on Windows before checking package managers", () => {
		setProcessPlatform("win32");
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		expect(detectLazygitInstallCommand()).toBeNull();
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers brew before system package managers", () => {
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(1000);
		const whichSpy = vi.spyOn(Bun, "which").mockImplementation((command: string) => {
			if (command === "brew") return "/opt/homebrew/bin/brew";
			if (command === "sudo") return null;
			if (command === "apt") return "/usr/bin/apt";
			return null;
		});

		expect(detectLazygitInstallCommand()).toEqual({ command: "brew", args: ["install", "lazygit"] });
		expect(whichSpy.mock.calls).toEqual([["brew"]]);
	});

	it("returns null when not root and sudo is unavailable", () => {
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(1000);
		const whichSpy = vi.spyOn(Bun, "which").mockImplementation((command: string) => {
			if (command === "brew") return null;
			if (command === "sudo") return null;
			if (command === "apt") return "/usr/bin/apt";
			return null;
		});

		expect(detectLazygitInstallCommand()).toBeNull();
		expect(whichSpy.mock.calls).toEqual([["brew"], ["sudo"]]);
	});

	const packageManagers = [
		{ name: "apt", args: ["install", "-y", "lazygit"] },
		{ name: "dnf", args: ["install", "-y", "lazygit"] },
		{ name: "pacman", args: ["-S", "--noconfirm", "lazygit"] },
		{ name: "apk", args: ["add", "lazygit"] },
	] as const;

	for (const manager of packageManagers) {
		it(`wraps ${manager.name} with sudo when not root`, () => {
			setProcessPlatform("linux");
			vi.spyOn(process, "getuid").mockReturnValue(1000);
			const whichSpy = vi.spyOn(Bun, "which").mockImplementation((command: string) => {
				if (command === "brew") return null;
				if (command === "sudo") return "/usr/bin/sudo";
				if (command === manager.name) return `/usr/bin/${manager.name}`;
				return null;
			});

			expect(detectLazygitInstallCommand()).toEqual({
				command: "sudo",
				args: [manager.name, ...manager.args],
			});
			expect(whichSpy).toHaveBeenCalledWith(manager.name);
		});

		it(`runs ${manager.name} directly when already root`, () => {
			setProcessPlatform("linux");
			vi.spyOn(process, "getuid").mockReturnValue(0);
			const whichSpy = vi.spyOn(Bun, "which").mockImplementation((command: string) => {
				if (command === "brew") return null;
				if (command === manager.name) return `/usr/bin/${manager.name}`;
				return null;
			});

			expect(detectLazygitInstallCommand()).toEqual({
				command: manager.name,
				args: [...manager.args],
			});
			expect(whichSpy).toHaveBeenCalledWith(manager.name);
		});
	}
});

describe("InputController shortcut and submit wiring", () => {
	it("registers custom handlers for each configured lazygit, external editor, and speech-to-text key", () => {
		const lazygitKeys = ["alt+g", "alt+shift+g"];
		const externalEditorKeys = ["alt+e", "alt+shift+e"];
		const sttKeys = ["alt+h"];
		const fixture = createKeyHandlerFixture(lazygitKeys, externalEditorKeys, sttKeys);
		fixture.controller.setupKeyHandlers();

		expect(fixture.getKeysSpy).toHaveBeenCalledWith("lazygit");
		expect(fixture.getKeysSpy).toHaveBeenCalledWith("externalEditor");
		expect(fixture.getKeysSpy).toHaveBeenCalledWith("toggleSTT");

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
		for (const key of sttKeys) {
			const handler = fixture.customHandlers.get(key);
			expect(handler).toBeTypeOf("function");
			(handler as () => unknown)();
		}

		expect(fixture.openLazygitSpy).toHaveBeenCalledTimes(lazygitKeys.length);
		expect(fixture.openExternalEditorSpy).toHaveBeenCalledTimes(externalEditorKeys.length);
		expect(fixture.toggleSTTSpy).toHaveBeenCalledTimes(sttKeys.length);
	});

	it("intercepts typed /lazygit before streaming prompt dispatch", async () => {
		const fixture = createSubmitInterceptFixture();
		await fixture.submit("/lazygit");

		expect(fixture.editorSetTextSpy).toHaveBeenCalledWith("");
		expect(fixture.openLazygitSpy).toHaveBeenCalledTimes(1);
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
		expect(fixture.editorAddToHistorySpy).not.toHaveBeenCalled();
	});

	it("intercepts typed /stt before streaming prompt dispatch", async () => {
		const fixture = createSubmitInterceptFixture();
		await fixture.submit("/stt");

		expect(fixture.editorSetTextSpy).toHaveBeenCalledWith("");
		expect(fixture.toggleSTTSpy).toHaveBeenCalledTimes(1);
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
		expect(fixture.editorAddToHistorySpy).not.toHaveBeenCalled();
	});

	it("shows usage for unsupported /stt arguments", async () => {
		const fixture = createSubmitInterceptFixture();
		await fixture.submit("/stt nope");

		expect(fixture.toggleSTTSpy).not.toHaveBeenCalled();
		expect(fixture.showStatusSpy).toHaveBeenCalledWith("Usage: /stt [on|off|status]");
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
	});
	it("handles freeform worktree menu action without prompting the model", async () => {
		const fixture = createWorkflowMenuSubmitFixture({
			id: "freeform-worktree",
			command: "/freeform-worktree",
		});
		const createSpy = vi.spyOn(fixture.controller as any, "createAndSwitchWorktree").mockResolvedValue(undefined);

		await fixture.submit("ignored");

		expect(createSpy).toHaveBeenCalledWith("freeform");
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
		expect(fixture.editorSetTextSpy).not.toHaveBeenCalled();
	});

	it("falls back to prompting for unknown workflow actions", async () => {
		const fixture = createWorkflowMenuSubmitFixture({
			id: "unknown-workflow-action",
			command: "/unknown-workflow-action",
		});

		await fixture.submit("ignored");

		expect(fixture.sessionPromptSpy).toHaveBeenCalledWith("/unknown-workflow-action");
	});


});

describe("InputController lazygit installation flow", () => {
	it("shows manual install warning when detectLazygitInstallCommand returns null", async () => {
		const fixture = createFixture();
		vi.spyOn(Bun, "which").mockReturnValue(null);
		setProcessPlatform("win32"); // will force detectLazygitInstallCommand to return null

		await fixture.controller.openLazygit();

		expect(fixture.controller.openEditorTerminalHandle).not.toHaveBeenCalled();
		expect(fixture.uiStopSpy).not.toHaveBeenCalled();
		expect(fixture.showWarningSpy).toHaveBeenCalledWith(
			"lazygit not found. Install it: https://github.com/jesseduffield/lazygit#installation"
		);
	});

	it("shows manual install warning when no TTY is available", async () => {
		const fixture = createFixture();
		vi.spyOn(Bun, "which").mockReturnValue(null);
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(0);
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => cmd === "apt" ? "/usr/bin/apt" : null);

		const originalStdinIsTTY = process.stdin.isTTY;
		const originalStdoutIsTTY = process.stdout.isTTY;

		try {
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

			await fixture.controller.openLazygit();

			expect(fixture.controller.openEditorTerminalHandle).not.toHaveBeenCalled();
			expect(fixture.uiStopSpy).not.toHaveBeenCalled();
			expect(fixture.showWarningSpy).toHaveBeenCalledWith(
				"lazygit not found. Install it: https://github.com/jesseduffield/lazygit#installation"
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
		}
	});

	it("restores the TUI when install prompt setup fails before launching install", async () => {
		const fixture = createFixture();
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(0);
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => (cmd === "apt" ? "/usr/bin/apt" : null));
		const promptError = new Error("prompt failed");
		const closeSpy = vi.fn();
		vi.spyOn(readlinePromises, "createInterface").mockReturnValue({
			question: vi.fn().mockRejectedValue(promptError),
			close: closeSpy,
		} as unknown as ReadlineInterface);

		const originalStdinIsTTY = process.stdin.isTTY;
		const originalStdoutIsTTY = process.stdout.isTTY;
		try {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

			await fixture.controller.openLazygit();

			expect(spawnMock).not.toHaveBeenCalled();
			expect(fixture.controller.openEditorTerminalHandle).not.toHaveBeenCalled();
			expect(fixture.uiStopSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiStartSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiRequestRenderSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(fixture.showWarningSpy).toHaveBeenCalledWith("Failed to install lazygit: prompt failed");
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
		}
	});

	it("restores the TUI and skips install when prompt is declined", async () => {
		const fixture = createFixture();
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(0);
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => (cmd === "apt" ? "/usr/bin/apt" : null));
		const closeSpy = vi.fn();
		vi.spyOn(readlinePromises, "createInterface").mockReturnValue({
			question: vi.fn().mockResolvedValue("n"),
			close: closeSpy,
		} as unknown as ReadlineInterface);

		const originalStdinIsTTY = process.stdin.isTTY;
		const originalStdoutIsTTY = process.stdout.isTTY;
		try {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

			await fixture.controller.openLazygit();

			expect(spawnMock).not.toHaveBeenCalled();
			expect(fixture.controller.openEditorTerminalHandle).not.toHaveBeenCalled();
			expect(fixture.uiStopSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiStartSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiRequestRenderSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(fixture.showWarningSpy).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
		}
	});

	it("restores the TUI when install command fails", async () => {
		const fixture = createFixture();
		setProcessPlatform("linux");
		vi.spyOn(process, "getuid").mockReturnValue(0);
		vi.spyOn(Bun, "which").mockImplementation((cmd: string) => (cmd === "apt" ? "/usr/bin/apt" : null));
		const closeSpy = vi.fn();
		vi.spyOn(readlinePromises, "createInterface").mockReturnValue({
			question: vi.fn().mockResolvedValue("y"),
			close: closeSpy,
		} as unknown as ReadlineInterface);
		const installChild = new EventEmitter() as ChildProcess;
		spawnMock.mockReturnValue(installChild);

		const originalStdinIsTTY = process.stdin.isTTY;
		const originalStdoutIsTTY = process.stdout.isTTY;
		try {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

			const runPromise = fixture.controller.openLazygit();
			await waitFor(() => installChild.listenerCount("exit") > 0);
			installChild.emit("exit", 1);
			await runPromise;

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(fixture.controller.openEditorTerminalHandle).not.toHaveBeenCalled();
			expect(fixture.uiStopSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiStartSpy).toHaveBeenCalledTimes(1);
			expect(fixture.uiRequestRenderSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(fixture.showWarningSpy).toHaveBeenCalledWith(
				"Failed to install lazygit: Install command exited with code 1"
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
		}
	});
});

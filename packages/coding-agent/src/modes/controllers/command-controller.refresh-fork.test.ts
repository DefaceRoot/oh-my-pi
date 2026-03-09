import { describe, expect, it, mock, vi } from "bun:test";
import { FORK_REINSTALL_COMMAND } from "../../cli/update-cli";
import type { InteractiveModeContext } from "../../modes/types";

class MockBashExecutionComponent {
	appendOutput = vi.fn();
	setComplete = vi.fn();
}

mock.module("../../modes/components/bash-execution", () => ({
	BashExecutionComponent: MockBashExecutionComponent,
}));

mock.module("../../modes/components/bordered-loader", () => ({
	BorderedLoader: class {},
}));

mock.module("../../modes/components/dynamic-border", () => ({
	DynamicBorder: class {},
}));

mock.module("../../modes/components/python-execution", () => ({
	PythonExecutionComponent: class {},
}));

mock.module("../../modes/theme/theme", () => ({
	getMarkdownTheme: () => ({}),
	getSymbolTheme: () => ({ success: "✓", error: "✗", warning: "!", info: "i" }),
	theme: {
		bold: (value: string) => value,
		fg: (_token: string, value: string) => value,
		info: (value: string) => value,
		status: { success: "✓", error: "✗", warning: "!" },
	},
}));

mock.module("../../tools/output-meta", () => ({
	outputMeta: () => ({
		truncationFromSummary: () => ({
			get: () => undefined,
		}),
	}),
}));

const spawnMock = vi.fn();
const unrefMock = vi.fn();
mock.module("node:child_process", () => ({
	spawn: (...args: unknown[]) => {
		spawnMock(...args);
		return { unref: unrefMock };
	},
}));

mock.module("../../task/omp-command", () => ({
	resolveOmpCommand: () => ({ cmd: "omp", args: [], shell: false }),
	buildOmpResumeArgs: (sessionFile?: string) => (sessionFile ? ["--resume", sessionFile] : []),
}));

import { CommandController } from "./command-controller";

type BashResult = {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
};

function makeBashResult(exitCode: number | undefined, cancelled = false): BashResult {
	return {
		output: "done",
		exitCode,
		cancelled,
		truncated: false,
		totalLines: 1,
		totalBytes: 4,
		outputLines: 1,
		outputBytes: 4,
	};
}

function createContext(result: BashResult) {
	const executeBash = vi.fn(async () => result);
	const showError = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const shutdown = vi.fn(async () => {});
	const addChatChild = vi.fn();
	const addPendingChild = vi.fn();
	const requestRender = vi.fn();

	const ctx = {
		session: {
			isStreaming: false,
			executeBash,
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionFile: () => "/tmp/project/.omp/session.jsonl",
		} as unknown as InteractiveModeContext["sessionManager"],
		chatContainer: {
			addChild: addChatChild,
		} as unknown as InteractiveModeContext["chatContainer"],
		pendingMessagesContainer: {
			addChild: addPendingChild,
		} as unknown as InteractiveModeContext["pendingMessagesContainer"],
		pendingBashComponents: [],
		ui: {
			requestRender,
		} as unknown as InteractiveModeContext["ui"],
		showError,
		showStatus,
		showWarning,
		shutdown,
		bashComponent: undefined,
	} as unknown as InteractiveModeContext;

	return {
		controller: new CommandController(ctx),
		executeBash,
		showError,
		shutdown,
	};
}

describe("CommandController refresh fork flow", () => {
	it("relaunches omp into the current session after a successful fork reinstall", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, shutdown, showError } = createContext(makeBashResult(0));

		await controller.handleRefreshForkInstall();

		expect(executeBash).toHaveBeenCalledWith(FORK_REINSTALL_COMMAND, expect.any(Function), {
			excludeFromContext: true,
		});
		expect(spawnMock).toHaveBeenCalledWith(
			"omp",
			["--resume", "/tmp/project/.omp/session.jsonl"],
			expect.objectContaining({ cwd: "/tmp/project", detached: true, shell: false, stdio: "inherit" }),
		);
		expect(unrefMock).toHaveBeenCalledTimes(1);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not relaunch omp when the fork reinstall fails", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, shutdown, showError } = createContext(makeBashResult(17));

		await controller.handleRefreshForkInstall();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("exit code 17"));
	});
});

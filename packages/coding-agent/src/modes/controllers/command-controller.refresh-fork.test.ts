import { describe, expect, it, mock, vi } from "bun:test";
import { FORK_REINSTALL_COMMAND, FORK_REPO_ROOT, FORK_UPSTREAM_REMOTE } from "../../cli/update-cli";
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

function makeBashResult({
	exitCode,
	cancelled = false,
	output = "",
}: {
	exitCode: number | undefined;
	cancelled?: boolean;
	output?: string;
}): BashResult {
	return {
		output,
		exitCode,
		cancelled,
		truncated: false,
		totalLines: output.length > 0 ? output.split("\n").length : 0,
		totalBytes: output.length,
		outputLines: output.length > 0 ? output.split("\n").length : 0,
		outputBytes: output.length,
	};
}

function createContext(results: BashResult[], options?: { confirmResult?: boolean }) {
	const queue = [...results];
	const executeBash = vi.fn(async () => queue.shift() ?? makeBashResult({ exitCode: 0 }));
	const showError = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showHookConfirm = vi.fn(async () => options?.confirmResult ?? true);
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
		showHookConfirm,
		shutdown,
		bashComponent: undefined,
	} as unknown as InteractiveModeContext;

	return {
		controller: new CommandController(ctx),
		executeBash,
		showError,
		showWarning,
		showHookConfirm,
		shutdown,
	};
}

describe("CommandController merge OMP flow", () => {
	it("fetches, rebases, reinstalls, and relaunches when upstream changes are safe", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, shutdown, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "2\n" }),
			makeBashResult({ exitCode: 0, output: "src/foo.ts\n" }),
			makeBashResult({ exitCode: 0, output: "src/bar.ts\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(executeBash).toHaveBeenNthCalledWith(1, `cd ${FORK_REPO_ROOT} && git remote`, expect.any(Function), {
			excludeFromContext: false,
		});
		expect(executeBash).toHaveBeenNthCalledWith(
			2,
			`cd ${FORK_REPO_ROOT} && git fetch ${FORK_UPSTREAM_REMOTE}`,
			expect.any(Function),
			{ excludeFromContext: true },
		);
		expect(executeBash).toHaveBeenLastCalledWith(FORK_REINSTALL_COMMAND, expect.any(Function), {
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

	it("shows a clear error when upstream remote is missing", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, shutdown, showError } = createContext([makeBashResult({ exitCode: 0, output: "origin\n" })]);

		await controller.handleMergeUpstreamFork();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining(`No '${FORK_UPSTREAM_REMOTE}' remote found`));
	});

	it("warns when upstream remote inspection is cancelled", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, showWarning, showError, shutdown } = createContext([
			makeBashResult({ exitCode: undefined, cancelled: true }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showWarning).toHaveBeenCalledWith("Upstream remote check cancelled.");
		expect(showError).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("reports successful cleanup when cancelled rebase aborts cleanly", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, showWarning, showError, shutdown } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 0, output: "src/a.ts\n" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: undefined, cancelled: true }),
			makeBashResult({ exitCode: 0 }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showWarning).toHaveBeenCalledWith("Merge cancelled. Rebase aborted.");
		expect(showError).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("asks for confirmation on overlapping files and cancels when declined", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showWarning, showHookConfirm, shutdown } = createContext(
			[
				makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
				makeBashResult({ exitCode: 0 }),
				makeBashResult({ exitCode: 0, output: "main\n" }),
				makeBashResult({ exitCode: 0, output: "1\n" }),
				makeBashResult({ exitCode: 0, output: "src/a.ts\nsrc/b.ts\n" }),
				makeBashResult({ exitCode: 0, output: "src/a.ts\n" }),
			],
			{ confirmResult: false },
		);

		await controller.handleMergeUpstreamFork();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(showWarning).toHaveBeenCalledWith("Merge cancelled.");
		expect(executeBash).toHaveBeenCalledTimes(6);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("reports abort failure when rebase cancellation cannot be cleaned up", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, showError, shutdown } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 0, output: "src/a.ts\n" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: undefined, cancelled: true }),
			makeBashResult({ exitCode: 1 }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showError).toHaveBeenCalledWith(expect.stringContaining("automatic rebase abort failed"));
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});
});

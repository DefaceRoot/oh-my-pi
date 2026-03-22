import { describe, expect, it, mock, vi } from "bun:test";
import { FORK_REPO_ROOT, FORK_UPSTREAM_REMOTE } from "../../cli/update-cli";
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
		showStatus,
		showWarning,
		showHookConfirm,
		shutdown,
	};
}

describe("CommandController merge OMP flow", () => {
	it("creates a merge worktree, merges upstream/main with --no-commit, and can launch omp", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showError, showHookConfirm } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "2\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/foo.ts\nsrc/bar.ts\n" }),
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
		expect(executeBash).toHaveBeenNthCalledWith(
			7,
			expect.stringContaining(`git merge ${FORK_UPSTREAM_REMOTE}/main --no-commit`),
			expect.any(Function),
			{ excludeFromContext: true },
		);
		expect(executeBash).toHaveBeenNthCalledWith(
			8,
			expect.stringContaining("git diff --name-only --diff-filter=U"),
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(showHookConfirm).toHaveBeenCalledWith(
			"Launch OMP in merge worktree?",
			expect.stringContaining("Open a new OMP session"),
		);
		expect(spawnMock).toHaveBeenCalledWith(
			"omp",
			[expect.stringContaining("You are in a merge worktree prepared by /merge-omp.")],
			expect.objectContaining({
				cwd: expect.stringMatching(/\.worktrees\/merge-upstream-\d{4}-\d{2}-\d{2}$/),
				detached: true,
				shell: false,
				stdio: "inherit",
			}),
		);
		expect(unrefMock).toHaveBeenCalledTimes(1);
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

	it("stops early when upstream has no new commits", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showStatus, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "0\n" }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(executeBash).toHaveBeenCalledTimes(4);
		expect(showStatus).toHaveBeenCalledWith("Already up to date with upstream. No changes to merge.");
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("creates merge worktree with conflicts and waits for manual resolution when launch is declined", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, showStatus, showError, showHookConfirm } = createContext(
			[
				makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
				makeBashResult({ exitCode: 0 }),
				makeBashResult({ exitCode: 0, output: "main\n" }),
				makeBashResult({ exitCode: 0, output: "3\n" }),
				makeBashResult({ exitCode: 1 }),
				makeBashResult({ exitCode: 0 }),
				makeBashResult({ exitCode: 1 }),
				makeBashResult({ exitCode: 0, output: "src/a.ts\nsrc/b.ts\n" }),
				makeBashResult({ exitCode: 0, output: "src/c.ts\n" }),
			],
			{ confirmResult: false },
		);

		await controller.handleMergeUpstreamFork();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Conflicting files: 2"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Cleanly merged files: 1"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Merge worktree ready at"));
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("cleans up the worktree when merge fails without conflict entries", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showError, showHookConfirm } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showHookConfirm).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("temporary merge worktree was cleaned up"));
		expect(executeBash).toHaveBeenNthCalledWith(
			10,
			expect.stringContaining("git worktree remove -f"),
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(executeBash).toHaveBeenNthCalledWith(
			11,
			expect.stringContaining("git branch -D merge-upstream-"),
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
	});

	it("adds a numeric suffix when the default merge branch already exists", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/merged.ts\n" }),
		]);

		await controller.handleMergeUpstreamFork();

		const recordedCalls = executeBash.mock.calls as unknown as Array<
			[string, unknown, { excludeFromContext: boolean }]
		>;
		const worktreeAddCommand = recordedCalls[6]?.[0];
		expect(typeof worktreeAddCommand).toBe("string");
		if (typeof worktreeAddCommand !== "string") {
			throw new Error("Expected worktree add command call.");
		}
		expect(worktreeAddCommand).toMatch(/merge-upstream-\d{4}-\d{2}-\d{2}-2/);
		expect(worktreeAddCommand).toContain("defaceroot/main");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});
});

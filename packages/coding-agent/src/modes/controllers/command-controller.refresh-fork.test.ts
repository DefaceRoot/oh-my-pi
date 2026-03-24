import { describe, expect, it, mock, vi } from "bun:test";
import { FORK_REPO_ROOT, FORK_UPSTREAM_REMOTE, FORK_UPSTREAM_URL } from "../../cli/update-cli";
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

type MergeBreakingChanges = {
	breakingCommits: Array<{ hash: string; subject: string; body: string }>;
	significantFileChanges: Array<{ file: string; changeType: string }>;
};

function getBreakingChangeDetector(controller: CommandController): (
	worktreePath: string,
	upstreamRef: string,
) => Promise<MergeBreakingChanges> {
	return (
		controller as unknown as {
			detectUpstreamBreakingChanges: (
				worktreePath: string,
				upstreamRef: string,
			) => Promise<MergeBreakingChanges>;
		}
	).detectUpstreamBreakingChanges.bind(controller);
}

describe("CommandController merge OMP flow", () => {
	it("creates a merge worktree, merges upstream/main with --no-commit, and can launch omp when no breaking changes are detected", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showError, showHookConfirm, showStatus } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "2\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/foo.ts\nsrc/bar.ts\n" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
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
		expect(executeBash).toHaveBeenNthCalledWith(
			10,
			expect.stringContaining('git log --pretty=format:"%H|||%s|||%b" HEAD..'),
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
		const promptArg = spawnMock.mock.calls[0]?.[1]?.[0];
		expect(typeof promptArg).toBe("string");
		if (typeof promptArg !== "string") {
			throw new Error("Expected launch prompt argument.");
		}
		expect(promptArg).not.toContain("Breaking changes from upstream:");
		expect(promptArg).toContain(
			"0. Present breaking changes summary to user and confirm approach for each area. Use the ask tool before proceeding.",
		);
		expect(promptArg).toContain("1. Delegate conflict resolution to the merge agent");
		expect(showStatus).not.toHaveBeenCalledWith(expect.stringContaining("⚠ Breaking changes detected:"));
		expect(unrefMock).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});

	it("uses upstream/main for counting and breaking-change inspection even on non-main branches", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "feature/auth-migration\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/foo.ts\n" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(executeBash).toHaveBeenNthCalledWith(
			4,
			`cd ${FORK_REPO_ROOT} && git rev-list --count defaceroot/main..${FORK_UPSTREAM_REMOTE}/main`,
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(executeBash).toHaveBeenNthCalledWith(
			7,
			expect.stringContaining(`git merge ${FORK_UPSTREAM_REMOTE}/main --no-commit`),
			expect.any(Function),
			{ excludeFromContext: true },
		);
		expect(executeBash).toHaveBeenNthCalledWith(
			10,
			expect.stringContaining(`HEAD..${FORK_UPSTREAM_REMOTE}/main`),
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(showError).not.toHaveBeenCalled();
	});


	it("includes breaking change guidance when upstream has conflicts", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const firstHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const secondHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const { controller, showStatus, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "3\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0, output: "src/a.ts\nsrc/b.ts\n" }),
			makeBashResult({ exitCode: 0, output: "src/c.ts\n" }),
			makeBashResult({
				exitCode: 0,
				output:
					`${firstHash}|||feat!: redesign authentication API|||BREAKING CHANGE: The auth() function signature changed from (token) to (config)\n${secondHash}|||feat: remove legacy database adapter|||BREAKING-CHANGE: PostgresLegacyAdapter has been removed`,
			}),
			makeBashResult({ exitCode: 0, output: "src/legacy/postgres-adapter.ts\n" }),
			makeBashResult({ exitCode: 0, output: "src/auth.ts → src/auth/index.ts\n" }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("⚠ Breaking changes detected:"));
		expect(showStatus).toHaveBeenCalledWith(
			expect.stringContaining(`  • ${firstHash.slice(0, 7)} feat!: redesign authentication API`),
		);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Deleted files: 1"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Renamed files: 1"));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Conflicting files: 2"));

		const promptArg = spawnMock.mock.calls[0]?.[1]?.[0];
		expect(typeof promptArg).toBe("string");
		if (typeof promptArg !== "string") {
			throw new Error("Expected launch prompt argument.");
		}
		expect(promptArg).toContain("Breaking changes from upstream:");
		expect(promptArg).toContain(`- ${firstHash.slice(0, 7)}: feat!: redesign authentication API`);
		expect(promptArg).toContain(
			"BREAKING CHANGE: The auth() function signature changed from (token) to (config)",
		);
		expect(promptArg).toContain("Significant file changes:");
		expect(promptArg).toContain("- DELETED: src/legacy/postgres-adapter.ts");
		expect(promptArg).toContain("- RENAMED: src/auth.ts → src/auth/index.ts");
		expect(promptArg).toContain("Use the ask tool before proceeding.");
		expect(promptArg).toContain("Delegate conflict resolution to the merge agent");
		expect(showError).not.toHaveBeenCalled();
	});

	it("detects breaking change markers from commit subject and body", async () => {
		const firstHash = "cccccccccccccccccccccccccccccccccccccccc";
		const secondHash = "dddddddddddddddddddddddddddddddddddddddd";
		const thirdHash = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
		const { controller, executeBash, showWarning } = createContext([
			makeBashResult({
				exitCode: 0,
				output:
					`${firstHash}|||feat!: remove legacy auth API|||\n${secondHash}|||feat: tighten auth validation|||Context line\nBREAKING CHANGE: validateAuth now requires options\n${thirdHash}|||fix: update docs|||`,
			}),
			makeBashResult({ exitCode: 0, output: "src/legacy/auth.ts\n" }),
			makeBashResult({ exitCode: 0, output: "src/auth.ts → src/auth/index.ts\n" }),
		]);

		const detectUpstreamBreakingChanges = getBreakingChangeDetector(controller);
		const breakingChanges = await detectUpstreamBreakingChanges("/tmp/merge-worktree", "upstream/main");

		expect(executeBash).toHaveBeenNthCalledWith(
			1,
			`cd /tmp/merge-worktree && git log --pretty=format:"%H|||%s|||%b" HEAD..upstream/main`,
			expect.any(Function),
			{ excludeFromContext: false },
		);
		expect(breakingChanges.breakingCommits.map(commit => commit.hash)).toEqual([firstHash, secondHash]);
		expect(breakingChanges.significantFileChanges).toEqual([
			{ file: "src/legacy/auth.ts", changeType: "DELETED" },
			{ file: "src/auth.ts → src/auth/index.ts", changeType: "RENAMED" },
		]);
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("handles git log failure gracefully when checking upstream breaking changes", async () => {
		const { controller, executeBash, showWarning } = createContext([
			makeBashResult({ exitCode: 1, output: "fatal: bad revision" }),
			makeBashResult({ exitCode: 0, output: "src/removed.ts\n" }),
			makeBashResult({ exitCode: 0, output: "src/old.ts → src/new.ts\n" }),
		]);

		const detectUpstreamBreakingChanges = getBreakingChangeDetector(controller);
		const breakingChanges = await detectUpstreamBreakingChanges("/tmp/merge-worktree", "upstream/main");

		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("Could not inspect upstream commit messages for breaking changes"),
		);
		expect(breakingChanges.breakingCommits).toEqual([]);
		expect(breakingChanges.significantFileChanges).toEqual([
			{ file: "src/removed.ts", changeType: "DELETED" },
			{ file: "src/old.ts → src/new.ts", changeType: "RENAMED" },
		]);
		expect(executeBash).toHaveBeenCalledTimes(3);
	});

	it("stops merge flow when breaking change inspection is cancelled", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, showWarning, showHookConfirm, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\nupstream\n" }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "main\n" }),
			makeBashResult({ exitCode: 0, output: "1\n" }),
			makeBashResult({ exitCode: 1 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0 }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/merged.ts\n" }),
			makeBashResult({ exitCode: undefined, cancelled: true }),
		]);

		await controller.handleMergeUpstreamFork();

		expect(showWarning).toHaveBeenCalledWith("Merge cancelled while inspecting upstream breaking changes.");
		expect(showHookConfirm).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});


	it("auto-registers upstream remote when missing and continues the flow", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, executeBash, showStatus, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\n" }),      // git remote (no upstream)
			makeBashResult({ exitCode: 0 }),                            // git remote add upstream
			makeBashResult({ exitCode: 0 }),                            // git fetch upstream
			makeBashResult({ exitCode: 0, output: "main\n" }),         // git rev-parse HEAD
			makeBashResult({ exitCode: 0, output: "0\n" }),            // rev-list --count (up to date)
		]);

		await controller.handleMergeUpstreamFork();

		expect(executeBash).toHaveBeenNthCalledWith(
			2,
			`cd ${FORK_REPO_ROOT} && git remote add ${FORK_UPSTREAM_REMOTE} ${FORK_UPSTREAM_URL}`,
			expect.any(Function),
			expect.any(Object),
		);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining(`${FORK_UPSTREAM_URL}`));
		expect(showStatus).toHaveBeenCalledWith("Already up to date with upstream. No changes to merge.");
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows error when auto-registration of upstream remote fails", async () => {
		spawnMock.mockClear();
		unrefMock.mockClear();
		const { controller, shutdown, showError } = createContext([
			makeBashResult({ exitCode: 0, output: "origin\n" }),  // git remote (no upstream)
			makeBashResult({ exitCode: 1 }),                        // git remote add upstream → fails
		]);

		await controller.handleMergeUpstreamFork();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(unrefMock).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining(`Failed to register '${FORK_UPSTREAM_REMOTE}' remote`));
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
				makeBashResult({ exitCode: 0, output: "" }),
				makeBashResult({ exitCode: 0, output: "" }),
				makeBashResult({ exitCode: 0, output: "" }),
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
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "src/merged.ts\n" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
			makeBashResult({ exitCode: 0, output: "" }),
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

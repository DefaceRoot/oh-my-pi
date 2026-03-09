import { describe, expect, test } from "bun:test";
import { isMissingGitLfsPushError, pushWorktreeBranchToOrigin } from "./worktree-runtime";

const missingGitLfsPushError = [
	"This repository is configured for Git LFS but 'git-lfs' was not found on your path.",
	"If you no longer wish to use Git LFS, remove this hook by deleting the 'pre-push' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').",
	"error: failed to push some refs to 'https://github.com/DefaceRoot/oh-my-pi.git'",
].join(" ");

describe("worktree remote sync Git LFS handling", () => {
	test("detects the missing git-lfs pre-push hook failure", () => {
		expect(isMissingGitLfsPushError(missingGitLfsPushError)).toBe(true);
		expect(isMissingGitLfsPushError("error: failed to push some refs to origin")).toBe(false);
	});

	test("fails closed instead of bypassing hooks when git-lfs is missing", async () => {
		const commands: string[][] = [];
		await expect(
			pushWorktreeBranchToOrigin(
				{ worktreePath: "/tmp/worktree", branchName: "feature/workflow-menu", baseBranch: "main" },
				{
					runAllowFail: async (cmd: string[]) => {
						commands.push(cmd);
						return { code: 1, stdout: "", stderr: missingGitLfsPushError };
					},
					listLfsTrackedFilesForPendingPush: async () => [],
				},
			),
		).rejects.toThrow("git-lfs is missing");
		expect(commands).toHaveLength(1);
		expect(commands[0]).not.toContain("--no-verify");
	});

	test("handles missing git-lfs errors emitted on stdout", async () => {
		await expect(
			pushWorktreeBranchToOrigin(
				{ worktreePath: "/tmp/worktree", branchName: "feature/workflow-menu", baseBranch: "main" },
				{
					runAllowFail: async () => ({ code: 1, stdout: missingGitLfsPushError, stderr: "\n" }),
					listLfsTrackedFilesForPendingPush: async () => [],
				},
			),
		).rejects.toThrow("git-lfs is missing");
	});


	test("reports blocking LFS files when git-lfs is missing", async () => {
		await expect(
			pushWorktreeBranchToOrigin(
				{ worktreePath: "/tmp/worktree", branchName: "feature/workflow-menu", baseBranch: "main" },
				{
					runAllowFail: async () => ({ code: 1, stdout: "", stderr: missingGitLfsPushError }),
					listLfsTrackedFilesForPendingPush: async () => ["packages/coding-agent/assets/app.wasm"],
				},
			),
		).rejects.toThrow("includes Git LFS-tracked files");
	});

	test("surfaces original push failures when not a git-lfs issue", async () => {
		await expect(
			pushWorktreeBranchToOrigin(
				{ worktreePath: "/tmp/worktree", branchName: "feature/workflow-menu", baseBranch: "main" },
				{
					runAllowFail: async () => ({ code: 1, stdout: "", stderr: "remote rejected" }),
					listLfsTrackedFilesForPendingPush: async () => undefined,
				},
			),
		).rejects.toThrow("remote rejected");
	});
});
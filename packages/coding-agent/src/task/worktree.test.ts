import { afterEach, describe, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { applyBaseline, captureBaseline, captureDeltaPatch, cleanupWorktree, ensureWorktree } from "./worktree";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
	return childProcess
		.execFileSync("git", args, {
			cwd,
			encoding: "utf8",
		})
		.trim();
}

async function createRepo(options?: { committed?: boolean; configureIdentity?: boolean }): Promise<string> {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-worktree-"));
	tempDirs.push(repoDir);
	runGit(repoDir, ["init"]);
	if (options?.configureIdentity !== false) {
		runGit(repoDir, ["config", "user.email", "worktree-tests@oh-my-pi.dev"]);
		runGit(repoDir, ["config", "user.name", "Worktree Tests"]);
	}
	runGit(repoDir, ["config", "commit.gpgSign", "false"]);
	runGit(repoDir, ["config", "core.hooksPath", "/dev/null"]);
	if (options?.committed) {
		await Bun.write(path.join(repoDir, "README.md"), "seed\n");
		runGit(repoDir, ["add", "README.md"]);
		runGit(repoDir, ["commit", "-m", "seed"]);
	}
	return repoDir;
}

async function makeTreeWritable(target: string): Promise<void> {
	const entries = await fs.readdir(target, { withFileTypes: true });
	await fs.chmod(target, 0o755);
	for (const entry of entries) {
		const fullPath = path.join(target, entry.name);
		if (entry.isDirectory()) {
			await makeTreeWritable(fullPath);
			continue;
		}
		await fs.chmod(fullPath, 0o644);
	}
}

async function withGitIdentityDisabled<T>(fn: () => Promise<T>): Promise<T> {
	const originalEnv = {
		HOME: process.env.HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
	};
	const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-identity-"));
	tempDirs.push(isolatedHome);
	process.env.HOME = isolatedHome;
	process.env.XDG_CONFIG_HOME = isolatedHome;
	process.env.GIT_CONFIG_GLOBAL = path.join(isolatedHome, "global.gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	try {
		return await fn();
	} finally {
		if (originalEnv.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = originalEnv.HOME;
		if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
		if (originalEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = originalEnv.GIT_CONFIG_GLOBAL;
		if (originalEnv.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
		else process.env.GIT_CONFIG_NOSYSTEM = originalEnv.GIT_CONFIG_NOSYSTEM;
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation in repos without commits", () => {
	test("captures nested unborn repositories without throwing", async () => {
		const repoDir = await createRepo({ committed: true });
		const nestedDir = path.join(repoDir, "vendor", "nested-repo");
		await fs.mkdir(nestedDir, { recursive: true });
		runGit(nestedDir, ["init"]);
		runGit(nestedDir, ["config", "user.email", "worktree-tests@oh-my-pi.dev"]);
		runGit(nestedDir, ["config", "user.name", "Worktree Tests"]);
		await Bun.write(path.join(nestedDir, "staged.txt"), "nested staged\n");
		runGit(nestedDir, ["add", "staged.txt"]);
		await Bun.write(path.join(nestedDir, "untracked.txt"), "nested untracked\n");

		const baseline = await captureBaseline(repoDir);
		const nested = baseline.nested.find(entry => entry.relativePath === path.join("vendor", "nested-repo"));

		expect(nested).toBeDefined();
		expect(nested?.baseline.headCommit).toBe("");
		expect(nested?.baseline.staged).toContain("staged.txt");
		expect(nested?.baseline.untracked).toContain("untracked.txt");
	});

	test("applies baselines for unborn roots that contain nested unborn repos", async () => {
		const repoDir = await createRepo();
		const nestedDir = path.join(repoDir, "vendor", "nested-unborn");
		await fs.mkdir(nestedDir, { recursive: true });
		runGit(nestedDir, ["init"]);
		await Bun.write(path.join(nestedDir, "nested.txt"), "nested baseline\n");

		const baseline = await captureBaseline(repoDir);
		expect(baseline.root.untracked.some(entry => entry.includes("nested-unborn"))).toBe(false);
		const worktreeDir = await ensureWorktree(repoDir, "nested-unborn-task");
		await applyBaseline(worktreeDir, baseline);

		const nestedWorktreeDir = path.join(worktreeDir, "vendor", "nested-unborn");
		expect(runGit(nestedWorktreeDir, ["rev-parse", "--show-toplevel"])).not.toBe("");
		expect(await Bun.file(path.join(nestedWorktreeDir, "nested.txt")).text()).toBe("nested baseline\n");

		await cleanupWorktree(repoDir, worktreeDir);
	});

	test("captures only task changes for committed nested repo baselines", async () => {
		const repoDir = await createRepo({ committed: true });
		const nestedDir = path.join(repoDir, "vendor", "nested-committed");
		await fs.mkdir(nestedDir, { recursive: true });
		runGit(nestedDir, ["init"]);
		runGit(nestedDir, ["config", "user.email", "worktree-tests@oh-my-pi.dev"]);
		runGit(nestedDir, ["config", "user.name", "Worktree Tests"]);
		runGit(nestedDir, ["config", "commit.gpgSign", "false"]);
		runGit(nestedDir, ["config", "core.hooksPath", "/dev/null"]);
		await Bun.write(path.join(nestedDir, "seed.txt"), "seed\n");
		runGit(nestedDir, ["add", "seed.txt"]);
		runGit(nestedDir, ["commit", "-m", "nested seed"]);
		await makeTreeWritable(path.join(nestedDir, ".git"));
		await Bun.write(path.join(nestedDir, "baseline.txt"), "baseline\n");

		const baseline = await captureBaseline(repoDir);
		const worktreeDir = await ensureWorktree(repoDir, "nested-committed-task");
		await applyBaseline(worktreeDir, baseline);
		const nestedWorktreeDir = path.join(worktreeDir, "vendor", "nested-committed");
		await Bun.write(path.join(nestedWorktreeDir, "baseline.txt"), "task\n");
		runGit(nestedWorktreeDir, ["add", "baseline.txt"]);
		runGit(nestedWorktreeDir, ["commit", "-m", "nested task"]);

		const delta = await captureDeltaPatch(worktreeDir, baseline);
		expect(delta.rootPatch).toBe("");
		const nestedPatch = delta.nestedPatches.find(
			entry => entry.relativePath === path.join("vendor", "nested-committed"),
		);

		expect(nestedPatch).toBeDefined();
		expect(nestedPatch?.patch).toContain("diff --git a/baseline.txt b/baseline.txt");
		expect(nestedPatch?.patch).toContain("-baseline");
		expect(nestedPatch?.patch).toContain("+task");
		expect(nestedPatch?.patch).not.toContain("new file mode");

		await cleanupWorktree(repoDir, worktreeDir);
	});

	test("captures only task changes for committed root baselines", async () => {
		const repoDir = await createRepo({ committed: true });
		await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");

		const baseline = await captureBaseline(repoDir);
		const worktreeDir = await ensureWorktree(repoDir, "root-committed-task");
		await applyBaseline(worktreeDir, baseline);
		await Bun.write(path.join(worktreeDir, "baseline.txt"), "task\n");
		runGit(worktreeDir, ["add", "baseline.txt"]);
		runGit(worktreeDir, ["commit", "-m", "root task"]);

		const delta = await captureDeltaPatch(worktreeDir, baseline);
		expect(delta.rootPatch).toContain("diff --git a/baseline.txt b/baseline.txt");
		expect(delta.rootPatch).toContain("-baseline");
		expect(delta.rootPatch).toContain("+task");
		expect(delta.rootPatch).not.toContain("new file mode");

		await cleanupWorktree(repoDir, worktreeDir);
	});

	test("captures task deltas after the first commit in an unborn repo worktree", async () => {
		const repoDir = await createRepo();
		const baseline = await captureBaseline(repoDir);
		expect(baseline.root.headCommit).toBe("");

		const worktreeDir = await ensureWorktree(repoDir, "isolated-task");
		await applyBaseline(worktreeDir, baseline);
		const managedBranch = runGit(worktreeDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		expect(managedBranch.startsWith("omp/worktree/isolated-task-")).toBe(true);
		await Bun.write(path.join(worktreeDir, "committed.txt"), "first commit\n");
		runGit(worktreeDir, ["add", "committed.txt"]);
		runGit(worktreeDir, ["commit", "-m", "first"]);

		const delta = await captureDeltaPatch(worktreeDir, baseline);
		expect(delta.rootPatch).toContain("committed.txt");

		await cleanupWorktree(repoDir, worktreeDir);
		expect(runGit(repoDir, ["branch", "--list", managedBranch])).toBe("");
	});

	test("does not delete pre-existing managed-prefix branches for detached worktrees", async () => {
		const repoDir = await createRepo({ committed: true });
		const preservedBranch = "omp/worktree/preserved-branch";
		runGit(repoDir, ["branch", preservedBranch]);

		const worktreeDir = await ensureWorktree(repoDir, "preserved-branch");
		expect(runGit(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
		await cleanupWorktree(repoDir, worktreeDir);

		expect(runGit(repoDir, ["branch", "--list", preservedBranch])).toContain(preservedBranch);
	});

	test("cleans only the created managed branch after branch switches", async () => {
		const repoDir = await createRepo();
		const baseline = await captureBaseline(repoDir);
		const worktreeDir = await ensureWorktree(repoDir, "branch-switch-task");
		await applyBaseline(worktreeDir, baseline);
		const managedBranch = runGit(worktreeDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		const userBranch = "user-branch";
		runGit(worktreeDir, ["switch", "-c", userBranch]);

		await cleanupWorktree(repoDir, worktreeDir);

		expect(runGit(repoDir, ["branch", "--list", managedBranch])).toBe("");
	});

	test("captures task deltas without requiring a first commit", async () => {
		const repoDir = await createRepo();
		const baseline = await captureBaseline(repoDir);
		const worktreeDir = await ensureWorktree(repoDir, "unstaged-task");
		await applyBaseline(worktreeDir, baseline);
		await Bun.write(path.join(worktreeDir, "unstaged.txt"), "pending change\n");

		const delta = await captureDeltaPatch(worktreeDir, baseline);
		expect(delta.rootPatch).toContain("unstaged.txt");

		await cleanupWorktree(repoDir, worktreeDir);
	});
	test("captures only task changes after committing over an unborn baseline", async () => {
		const repoDir = await createRepo();
		await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");
		const baseline = await captureBaseline(repoDir);
		const worktreeDir = await ensureWorktree(repoDir, "baseline-task");
		await applyBaseline(worktreeDir, baseline);
		expect(baseline.root.headCommit).not.toBe("");
		await Bun.write(path.join(worktreeDir, "baseline.txt"), "baseline updated\n");
		runGit(worktreeDir, ["add", "baseline.txt"]);
		runGit(worktreeDir, ["commit", "-m", "update baseline"]);

		const delta = await captureDeltaPatch(worktreeDir, baseline);
		expect(delta.rootPatch).toContain("diff --git a/baseline.txt b/baseline.txt");
		expect(delta.rootPatch).not.toContain("new file mode");

		await cleanupWorktree(repoDir, worktreeDir);
	});
	test("applies synthetic baselines without requiring git identity", async () => {
		await withGitIdentityDisabled(async () => {
			const repoDir = await createRepo({ configureIdentity: false });
			await Bun.write(path.join(repoDir, "baseline.txt"), "baseline\n");

			const baseline = await captureBaseline(repoDir);
			const worktreeDir = await ensureWorktree(repoDir, "identityless-task");
			await applyBaseline(worktreeDir, baseline);
			expect(baseline.root.headCommit).not.toBe("");

			await cleanupWorktree(repoDir, worktreeDir);
		});
	});
});

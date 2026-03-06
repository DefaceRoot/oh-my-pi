import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	detectBaseBranch,
	getRepoRoot,
	getWorktreeList,
	isInsideWorktree,
	run,
	runAllowFail,
	tryRun,
	type WorktreeInfo,
} from "./git-utils.ts";

interface CleanupCandidate extends WorktreeInfo {
	merged: boolean;
	lastCommitRelative: string;
	label: string;
}

export interface CleanupCommandResult {
	removedBranches: string[];
	deletedLocalBranches: string[];
	deletedRemoteBranches: string[];
	skippedBranches: string[];
	removedActiveWorktree: boolean;
}
export interface CleanupCommandOptions {
	onComplete?: (ctx: ExtensionCommandContext, result: CleanupCommandResult) => Promise<void> | void;
}

export function registerCleanupCommand(pi: ExtensionAPI, options: CleanupCommandOptions = {}): void {
	pi.registerCommand("cleanup", {
		description: "Clean up one or more worktrees and their branches",
		handler: async (_args, ctx) => {
			await runCleanupFlow(pi, ctx, options);
		},
	});
}

export async function runCleanupFlow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: CleanupCommandOptions = {},
): Promise<void> {
	try {
		if (!ctx.hasUI) {
			ctx.ui.notify("Cleanup requires an interactive UI session", "warning");
			return;
		}

		const cwd = process.cwd();
		const repoRoot = await getRepoRoot(cwd);
		const baseBranch = await detectBaseBranch(repoRoot);

		const all = await getWorktreeList(repoRoot);
		const worktrees = all.filter(w => !w.bare && Boolean(w.branch) && isInsideWorktree(w.path));

		if (worktrees.length === 0) {
			ctx.ui.notify("No worktrees to clean up", "info");
			return;
		}

		const candidates: CleanupCandidate[] = [];
		for (const wt of worktrees) {
			const mergeAssessment = await assessMergeStatus(repoRoot, wt.branch, baseBranch);
			const last = await run(["git", "log", "-1", "--format=%cr", wt.branch], repoRoot).catch(() => ({ stdout: "unknown" }));
			const rel = wt.path.startsWith(repoRoot) ? wt.path.slice(repoRoot.length + 1) : wt.path;
			const lastCommitRelative = last.stdout.trim() || "unknown";
			const label = `${wt.branch} (${rel}) -- ${mergeAssessment.label}, last commit ${lastCommitRelative}`;
			candidates.push({ ...wt, merged: mergeAssessment.merged, lastCommitRelative, label });
		}

		candidates.sort((a, b) => {
			if (a.merged !== b.merged) return a.merged ? -1 : 1;
			return a.branch.localeCompare(b.branch);
		});

		const selected = await selectWorktrees(candidates, ctx);
		if (selected.length === 0) {
			ctx.ui.notify("No worktrees selected", "info");
			return;
		}

		const originRemote = await runAllowFail(["git", "remote", "get-url", "origin"], repoRoot);
		const hasOriginRemote = originRemote.code === 0;

		const removed: string[] = [];
		const deletedLocalBranches: string[] = [];
		const deletedRemoteBranches: string[] = [];
		const skipped: string[] = [];
		let removedActiveWorktree = false;

		for (const wt of selected) {
			const removingCurrentSessionWorktree = isSameOrInside(cwd, wt.path);
			if (removingCurrentSessionWorktree) {
				process.chdir(repoRoot);
			}

			ctx.ui.setStatus("cleanup", `cleanup: removing ${wt.branch}...`);
			const removeRes = await run(["git", "worktree", "remove", wt.path, "--force"], repoRoot).catch((e) => e as Error);
			if (removeRes instanceof Error) {
				if (removingCurrentSessionWorktree) {
					process.chdir(cwd);
				}
				skipped.push(`${wt.branch} (worktree remove failed)`);
				continue;
			}

			const localDelete = await runAllowFail(["git", "branch", "-D", wt.branch], repoRoot);
			if (localDelete.code === 0 || /not found/i.test(`${localDelete.stdout}\n${localDelete.stderr}`)) {
				deletedLocalBranches.push(wt.branch);
			} else {
				const detail = summarizeCommandFailure(localDelete);
				skipped.push(`${wt.branch} (local branch delete failed${detail ? `: ${detail}` : ""})`);
			}

			if (hasOriginRemote) {
				const remoteHead = await runAllowFail(["git", "ls-remote", "--exit-code", "--heads", "origin", wt.branch], repoRoot);
				if (remoteHead.code === 0) {
					const remoteDelete = await runAllowFail(["git", "push", "origin", "--delete", wt.branch], repoRoot, 120_000);
					if (remoteDelete.code === 0) {
						deletedRemoteBranches.push(wt.branch);
					} else {
						const detail = summarizeCommandFailure(remoteDelete);
						skipped.push(`${wt.branch} (remote branch delete failed${detail ? `: ${detail}` : ""})`);
					}
				}
				await tryRun(["git", "branch", "-dr", `origin/${wt.branch}`], repoRoot);
			}
			await cleanupEmptyParents(repoRoot, wt.path);
			removed.push(wt.branch);
			if (removingCurrentSessionWorktree) {
				removedActiveWorktree = true;
			}
		}

		await tryRun(["git", "worktree", "prune"], repoRoot);

		ctx.ui.setStatus("cleanup", undefined);

		const parts: string[] = [];
		if (removed.length > 0) parts.push(`Removed worktrees ${removed.length}: ${removed.join(", ")}`);
		if (deletedLocalBranches.length > 0) parts.push(`Deleted local branches ${deletedLocalBranches.length}: ${deletedLocalBranches.join(", ")}`);
		if (deletedRemoteBranches.length > 0) parts.push(`Deleted remote branches ${deletedRemoteBranches.length}: ${deletedRemoteBranches.join(", ")}`);
		if (skipped.length > 0) parts.push(`Skipped ${skipped.length}: ${skipped.join("; ")}`);
		ctx.ui.notify(parts.join(" | ") || "Cleanup complete", "info");
		pi.appendEntry("cleanup/complete", {
			removedBranches: removed,
			deletedLocalBranches,
			deletedRemoteBranches,
			skippedBranches: skipped,
			updatedAt: Date.now(),
			removedActiveWorktree,
		});
		if (options.onComplete) {
			await options.onComplete(ctx, {
				removedBranches: removed,
				deletedLocalBranches,
				deletedRemoteBranches,
				skippedBranches: skipped,
				removedActiveWorktree,
			});
		}
	} catch (err) {
		ctx.ui.setStatus("cleanup", undefined);
		const msg = err instanceof Error ? err.message : String(err);
		pi.logger.error("plan-worktree: cleanup failed", { error: msg });
		ctx.ui.notify(`Cleanup failed: ${msg}`, "error");
	}
}

async function selectWorktrees(candidates: CleanupCandidate[], ctx: { ui: { select: (title: string, options: string[]) => Promise<string | undefined> } }): Promise<CleanupCandidate[]> {
	const labels = candidates.map(candidate => candidate.label);
	const popupSelections = await showMultiSelectPopupMenu("Select worktrees to clean up", labels);
	if (popupSelections === null) {
		const remaining = [...candidates];
		const selected: CleanupCandidate[] = [];

		while (remaining.length > 0) {
			const options = [
				...remaining.map(c => c.label),
				selected.length > 0 ? "Done selecting" : "Cancel",
			];
			const choice = await ctx.ui.select("Select worktree to clean up (choose one at a time)", options);
			if (!choice) break;

			if (choice === "Done selecting" || choice === "Cancel") break;
			const idx = remaining.findIndex(c => c.label === choice);
			if (idx < 0) continue;
			selected.push(remaining[idx]);
			remaining.splice(idx, 1);
		}

		return selected;
	}

	if (popupSelections.length === 0) {
		return [];
	}

	const selectedLabels = new Set(popupSelections);
	return candidates.filter(candidate => selectedLabels.has(candidate.label));
}

async function showMultiSelectPopupMenu(title: string, options: string[]): Promise<string[] | null> {
	const inTmux = Boolean(process.env.TMUX);
	if (!inTmux) return null;

	const menuScript = path.join(os.homedir(), ".omp", "agent", "scripts", "menu-popup.sh");
	if (!(await Bun.file(menuScript).exists())) return null;

	try {
		const proc = Bun.spawn(["bash", menuScript, "--multi", title, ...options], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env },
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		const out = await new Response(proc.stdout).text();
		if (!out.trim()) return [];
		return out.split("\n").map(line => line.trim()).filter(Boolean);
	} catch {
		return null;
	}
}

interface MergeAssessment {
	merged: boolean;
	label: string;
}

async function assessMergeStatus(repoRoot: string, branch: string, baseBranch: string): Promise<MergeAssessment> {
	const localBaseRef = `refs/heads/${baseBranch}`;
	if (await isAncestor(branch, localBaseRef, repoRoot)) {
		return { merged: true, label: `merged into ${baseBranch}` };
	}

	const originBaseRef = `refs/remotes/origin/${baseBranch}`;
	const hasOriginBase = await refExists(originBaseRef, repoRoot);
	if (hasOriginBase && (await isAncestor(branch, originBaseRef, repoRoot))) {
		return { merged: true, label: `merged into origin/${baseBranch} (cached)` };
	}

	const staleDetail = hasOriginBase ? await describeBaseBranchSync(localBaseRef, originBaseRef, repoRoot) : undefined;
	if (staleDetail) {
		return { merged: false, label: `NOT merged locally (${staleDetail})` };
	}

	return { merged: false, label: "NOT merged" };
}

async function isAncestor(ancestorRef: string, descendantRef: string, cwd: string): Promise<boolean> {
	const result = await runAllowFail(["git", "merge-base", "--is-ancestor", ancestorRef, descendantRef], cwd);
	return result.code === 0;
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
	const result = await runAllowFail(["git", "show-ref", "--verify", "--quiet", ref], cwd);
	return result.code === 0;
}

async function describeBaseBranchSync(localBaseRef: string, originBaseRef: string, cwd: string): Promise<string | undefined> {
	const localBranchName = localBaseRef.replace(/^refs\/heads\//, "");
	const sync = await runAllowFail(["git", "rev-list", "--left-right", "--count", `${localBaseRef}...${originBaseRef}`], cwd);
	if (sync.code !== 0) return undefined;

	const match = sync.stdout.trim().match(/^(\d+)\s+(\d+)$/);
	if (!match) return undefined;

	const localOnlyCount = Number.parseInt(match[1] ?? "0", 10);
	const originOnlyCount = Number.parseInt(match[2] ?? "0", 10);

	if (originOnlyCount > 0 && localOnlyCount > 0) {
		return `${localBranchName} diverges from cached origin (${localOnlyCount} ahead / ${originOnlyCount} behind)`;
	}
	if (originOnlyCount > 0) {
		return `${localBranchName} is behind cached origin by ${originOnlyCount}`;
	}
	if (localOnlyCount > 0) {
		return `${localBranchName} is ahead of cached origin by ${localOnlyCount}`;
	}

	return undefined;
}

function isSameOrInside(candidatePath: string, parentPath: string): boolean {
	const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function summarizeCommandFailure(result: { stdout: string; stderr: string }): string {
	const detail = (result.stderr || result.stdout).trim();
	if (!detail) return "";
	const compact = detail.replace(/\s+/g, " ");
	return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}


async function cleanupEmptyParents(repoRoot: string, removedWorktreePath: string): Promise<void> {
	const worktreesRoot = path.join(repoRoot, ".worktrees");
	let dir = path.dirname(removedWorktreePath);

	while (dir.startsWith(worktreesRoot) && dir !== worktreesRoot) {
		try {
			if (!fs.existsSync(dir)) {
				dir = path.dirname(dir);
				continue;
			}
			const entries = fs.readdirSync(dir);
			if (entries.length > 0) break;
			fs.rmdirSync(dir);
			dir = path.dirname(dir);
		} catch {
			break;
		}
	}
}

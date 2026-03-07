import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import {
	detectBaseBranch,
	getCurrentBranch,
	isInsideWorktree,
	run,
	runAllowFail,
	tryRun,
} from "./git-utils.ts";

interface ExistingPr {
	number: number;
	url: string;
}

interface CommitBuckets {
	added: string[];
	fixed: string[];
	changed: string[];
}

export interface SubmitPrCommandOptions {
	onSuccess?: (ctx: ExtensionCommandContext) => Promise<void> | void;
}

export function registerSubmitPrCommand(pi: ExtensionAPI, options: SubmitPrCommandOptions = {}): void {
	pi.registerCommand("submit-pr", {
		description: "Rebase current worktree branch and create or update a PR",
		handler: async (_args, ctx) => {
			const cwd = process.cwd();
			ctx.ui.setStatus("submit-pr", "submit-pr: validating...");

			try {
				if (!isInsideWorktree(cwd)) {
					ctx.ui.setStatus("submit-pr", undefined);
					ctx.ui.notify("Run /submit-pr from inside a worktree", "error");
					return;
				}

				const ghCheck = await runAllowFail(["gh", "--version"], cwd);
				if (ghCheck.code !== 0) {
					ctx.ui.setStatus("submit-pr", undefined);
					ctx.ui.notify("GitHub CLI (gh) is required for /submit-pr", "error");
					return;
				}

				const dirty = await run(["git", "status", "--porcelain"], cwd);
				if (dirty.stdout.trim()) {
					ctx.ui.setStatus("submit-pr", undefined);
					ctx.ui.notify("Working tree is dirty. Commit or stash changes before /submit-pr", "error");
					return;
				}

				const baseBranch = await detectBaseBranch(cwd);
				const branch = await getCurrentBranch(cwd);
				if (!branch) {
					ctx.ui.setStatus("submit-pr", undefined);
					ctx.ui.notify("Could not determine current branch", "error");
					return;
				}

				ctx.ui.setStatus("submit-pr", "submit-pr: fetching...");
				await run(["git", "fetch", "origin", baseBranch], cwd);

				const subjectsBeforeRebase = await getBranchCommitSubjects(cwd, baseBranch);
				if (subjectsBeforeRebase.length === 0) {
					ctx.ui.setStatus("submit-pr", undefined);
					ctx.ui.notify(`No changes to submit vs origin/${baseBranch}`, "error");
					return;
				}

				const existingPr = await getExistingPr(cwd, branch);

				ctx.ui.setStatus("submit-pr", "submit-pr: rebasing...");
				const rebase = await runAllowFail(["git", "rebase", `origin/${baseBranch}`], cwd, 120_000);
				if (rebase.code !== 0) {
					const resolved = await resolveRebaseConflicts(pi, ctx, cwd, baseBranch);
					if (!resolved) {
						ctx.ui.setStatus("submit-pr", undefined);
						ctx.ui.notify("Rebase failed after multiple conflict rounds. Rebase aborted.", "error");
						return;
					}
				}

				ctx.ui.setStatus("submit-pr", "submit-pr: pushing...");
				await run(["git", "push", "origin", branch, "--force-with-lease"], cwd, 120_000);

				ctx.ui.setStatus("submit-pr", "submit-pr: creating PR...");
				const subjectsAfterRebase = await getBranchCommitSubjects(cwd, baseBranch);
				const subjects = subjectsAfterRebase.length > 0 ? subjectsAfterRebase : subjectsBeforeRebase;
				const buckets = categorizeCommits(subjects);
				const title = buildPrTitle(branch, buckets);
				const body = await buildPrBody(cwd, baseBranch, subjects, buckets);
				const prUrl = await createOrUpdatePr(cwd, baseBranch, branch, title, body, existingPr);

				ctx.ui.setStatus("submit-pr", undefined);
				ctx.ui.notify(`PR ready: ${prUrl}`, "info");
				pi.sendMessage({
					customType: "submit-pr/ready",
					content: `## PR ready\n\n- Branch: \`${branch}\`\n- Base: \`${baseBranch}\`\n- URL: ${prUrl}`,
					display: true,
					details: { branch, baseBranch, prUrl },
				});
				if (options.onSuccess) {
					await options.onSuccess(ctx);
				}
			} catch (err) {
				ctx.ui.setStatus("submit-pr", undefined);
				const msg = err instanceof Error ? err.message : String(err);
				pi.logger.error("implementation-engine: submit-pr failed", { error: msg });
				ctx.ui.notify(`submit-pr failed: ${msg}`, "error");
			}
		},
	});
}

async function getBranchCommitSubjects(cwd: string, baseBranch: string): Promise<string[]> {
	const log = await run(["git", "log", "--format=%s", "--no-merges", `origin/${baseBranch}..HEAD`], cwd);
	return log.stdout
		.split("\n")
		.map(s => s.trim())
		.filter(Boolean);
}

async function getExistingPr(cwd: string, branch: string): Promise<ExistingPr | null> {
	const result = await runAllowFail(["gh", "pr", "list", "--head", branch, "--json", "number,url", "--limit", "1"], cwd);
	if (result.code !== 0 || !result.stdout.trim()) return null;
	try {
		const parsed = JSON.parse(result.stdout) as Array<{ number: number; url: string }>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		return { number: parsed[0].number, url: parsed[0].url };
	} catch {
		return null;
	}
}

async function resolveRebaseConflicts(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	baseBranch: string,
): Promise<boolean> {
	for (let round = 1; round <= 5; round++) {
		const conflictFiles = await getConflictFiles(cwd);
		if (conflictFiles.length === 0) {
			return true;
		}

		ctx.ui.setStatus("submit-pr", `submit-pr: resolving conflicts (round ${round}/5)...`);

		for (const relPath of conflictFiles) {
			const absPath = `${cwd}/${relPath}`;
			const before = await Bun.file(absPath).text().catch(() => "");
			if (!before) {
				throw new Error(`Conflict file unreadable: ${relPath}`);
			}

			const snippet = before.length > 4000 ? `${before.slice(0, 4000)}\n...<truncated>...` : before;
			pi.sendUserMessage(
				[
					`Resolve merge conflicts in file: ${relPath}`,
					`Context: rebasing current branch onto origin/${baseBranch}.`,
					"Requirements:",
					"- Remove all conflict markers: <<<<<<<, =======, >>>>>>>",
					"- Keep feature-branch intent while incorporating upstream changes",
					"- Do not leave TODO markers",
					"",
					"```",
					snippet,
					"```",
				].join("\n"),
				{ deliverAs: "steer" },
			);
			await ctx.waitForIdle();

			let after = await Bun.file(absPath).text().catch(() => "");
			if (hasConflictMarkers(after)) {
				pi.sendUserMessage(
					`File ${relPath} still has conflict markers. Resolve all <<<<<<< / ======= / >>>>>>> markers now.`,
					{ deliverAs: "steer" },
				);
				await ctx.waitForIdle();
				after = await Bun.file(absPath).text().catch(() => "");
				if (hasConflictMarkers(after)) {
					throw new Error(`Conflict markers remain in ${relPath}`);
				}
			}

			await run(["git", "add", relPath], cwd);
		}

		const cont = await runAllowFail(["git", "rebase", "--continue"], cwd, 120_000);
		if (cont.code === 0) {
			const remaining = await getConflictFiles(cwd);
			if (remaining.length === 0 && !(await isRebaseInProgress(cwd))) {
				return true;
			}
		}
	}

	await tryRun(["git", "rebase", "--abort"], cwd);
	return false;
}

async function getConflictFiles(cwd: string): Promise<string[]> {
	const res = await run(["git", "diff", "--name-only", "--diff-filter=U"], cwd);
	return res.stdout
		.split("\n")
		.map(s => s.trim())
		.filter(Boolean);
}

function hasConflictMarkers(content: string): boolean {
	return /<<<<<<<|=======|>>>>>>>/.test(content);
}

async function isRebaseInProgress(cwd: string): Promise<boolean> {
	const res = await runAllowFail(
		["bash", "-lc", "test -d \"$(git rev-parse --git-path rebase-merge)\" -o -d \"$(git rev-parse --git-path rebase-apply)\""],
		cwd,
	);
	return res.code === 0;
}

function categorizeCommits(subjects: string[]): CommitBuckets {
	const buckets: CommitBuckets = { added: [], fixed: [], changed: [] };

	for (const raw of subjects) {
		const subject = raw.trim();
		if (!subject) continue;
		if (/^(chore|build|ci)(\(|:|!)/i.test(subject)) continue;

		const clean = humanizeCommitSubject(subject);
		if (!clean) continue;

		if (/^(feat)(\(|:|!)/i.test(subject) || subject.includes("✨")) buckets.added.push(clean);
		else if (/^(fix)(\(|:|!)/i.test(subject) || subject.includes("🐛")) buckets.fixed.push(clean);
		else buckets.changed.push(clean);
	}

	return buckets;
}

function humanizeCommitSubject(subject: string): string {
	let s = subject.trim();
	s = s.replace(/^[✨🐛⚡♻🎨📝\s-]+/, "");
	s = s.replace(/^(feat|fix|perf|refactor|style|docs|chore|build|ci|test)(\([^)]+\))?!?:\s*/i, "");
	s = s.trim();
	if (!s) return "";
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildPrTitle(branch: string, buckets: CommitBuckets): string {
	const hasAdded = buckets.added.length > 0;
	const hasFixed = buckets.fixed.length > 0;
	const hasChanged = buckets.changed.length > 0;

	if (hasAdded && !hasFixed && !hasChanged) {
		return `feat: ${buckets.added[0]}`;
	}
	if (hasFixed && !hasAdded && !hasChanged) {
		return `fix: ${buckets.fixed[0]}`;
	}

	const summary = branch
		.split("/")
		.filter(Boolean)
		.slice(-1)[0]
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, c => c.toUpperCase());

	if (hasAdded) return `feat: ${summary}`;
	if (hasFixed) return `fix: ${summary}`;
	return `chore: ${summary}`;
}

async function buildPrBody(
	cwd: string,
	baseBranch: string,
	subjects: string[],
	buckets: CommitBuckets,
): Promise<string> {
	const diffStat = await run(["git", "diff", "--stat", `origin/${baseBranch}..HEAD`], cwd);
	const commits = subjects.map(s => `- ${s}`).join("\n");
	const summaryLines = [
		...dedupe(buckets.added).map(item => `- Added: ${item}`),
		...dedupe(buckets.fixed).map(item => `- Fixed: ${item}`),
		...dedupe(buckets.changed).map(item => `- Changed: ${item}`),
	];

	return [
		"## Summary",
		"",
		summaryLines.length > 0 ? summaryLines.join("\n") : "- No categorized summary available",
		"",
		"## Files Changed",
		"",
		"```text",
		diffStat.stdout.trim() || "(no diff stat available)",
		"```",
		"",
		"## Commits",
		"",
		commits || "- (none)",
	].join("\n");
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

async function resolveGitPath(cwd: string, gitRelativePath: string): Promise<string> {
	const resolved = await run(["git", "rev-parse", "--git-path", gitRelativePath], cwd);
	const gitPath = resolved.stdout.trim();
	if (!gitPath) {
		throw new Error(`Could not resolve git path for ${gitRelativePath}`);
	}
	return path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
}

async function createOrUpdatePr(
	cwd: string,
	baseBranch: string,
	branch: string,
	title: string,
	body: string,
	existingPr: ExistingPr | null,
): Promise<string> {
	const bodyFile = await resolveGitPath(cwd, ".omp-submit-pr-body.md");
	await Bun.write(bodyFile, body);

	try {
		if (existingPr) {
			await run(["gh", "pr", "edit", String(existingPr.number), "--title", title, "--body-file", bodyFile], cwd, 120_000);
			return existingPr.url;
		}

		const create = await run(
			["gh", "pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyFile],
			cwd,
			120_000,
		);
		const url = create.stdout.trim().split("\n").map(s => s.trim()).find(s => /^https?:\/\//.test(s));
		if (!url) throw new Error(`Could not parse PR URL from gh output: ${create.stdout.trim()}`);
		return url;
	} finally {
		await tryRun(["rm", "-f", bodyFile], cwd);
	}
}
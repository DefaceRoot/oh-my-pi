import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const FALSE_ENV_VALUES = ["0", "false", "off", "no"];

export interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number;
}

export async function run(
	cmd: string[],
	cwd: string,
	timeoutMs = 30_000,
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});

	const timer = setTimeout(() => proc.kill(), timeoutMs);

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(timer);

	if (code !== 0) {
		const detail = (stderr || stdout).trim();
		throw new Error(`\`${cmd.join(" ")}\` failed (code ${code}): ${detail}`);
	}

	return { stdout, stderr, code };
}

export async function tryRun(
	cmd: string[],
	cwd: string,
	timeoutMs = 30_000,
): Promise<void> {
	try {
		await run(cmd, cwd, timeoutMs);
	} catch {
		// best-effort, ignore
	}
}

export async function runAllowFail(
	cmd: string[],
	cwd: string,
	timeoutMs = 30_000,
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});

	const timer = setTimeout(() => proc.kill(), timeoutMs);

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(timer);

	return { stdout, stderr, code };
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		return await Bun.file(filePath).exists();
	} catch {
		return false;
	}
}

async function tryRunCapture(
	cmd: string[],
	cwd: string,
	timeoutMs: number,
): Promise<string | null> {
	try {
		const result = await run(cmd, cwd, timeoutMs);
		return result.stdout;
	} catch {
		return null;
	}
}

export async function cleanupEmptyWorktreeParents(
	repoRoot: string,
	removedWorktreePath: string,
): Promise<void> {
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

export async function createWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	params: { baseBranch: string; branchName: string; worktreePath: string },
): Promise<void> {
	const { baseBranch, branchName, worktreePath } = params;

	// Skip if worktree already exists
	try {
		if (await Bun.file(`${worktreePath}/.git`).exists()) {
			pi.logger.debug(
				`implementation-engine: worktree already exists at ${worktreePath}, skipping`,
			);
			return;
		}
	} catch {
		// doesn't exist, continue
	}

	// Check if branch already exists
	const branchCheck = await run(
		["git", "rev-parse", "--verify", `refs/heads/${branchName}`],
		repoRoot,
	).catch(() => null);

	if (branchCheck?.stdout.trim()) {
		pi.logger.debug(
			`implementation-engine: branch ${branchName} exists, adding worktree`,
		);
		await run(["git", "worktree", "add", worktreePath, branchName], repoRoot);
	} else {
		pi.logger.debug(
			`implementation-engine: creating branch ${branchName} from ${baseBranch}`,
		);
		await run(
			["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch],
			repoRoot,
		);
	}
}

export async function verifyWorktree(
	repoRoot: string,
	params: { branchName: string; worktreePath: string },
): Promise<void> {
	const { branchName, worktreePath } = params;

	// 1) .git file must exist in worktree dir
	const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
	if (!gitExists) {
		throw new Error(
			`Worktree verification failed: ${worktreePath}/.git does not exist. ` +
				`git worktree add may have silently failed.`,
		);
	}

	// 2) Branch ref must exist
	const ref = await run(
		["git", "rev-parse", "--verify", `refs/heads/${branchName}`],
		repoRoot,
	);
	if (!ref.stdout.trim()) {
		throw new Error(
			`Branch verification failed: refs/heads/${branchName} not found`,
		);
	}

	// 3) git worktree list must include our path
	const list = await run(["git", "worktree", "list", "--porcelain"], repoRoot);
	if (!list.stdout.includes(`worktree ${worktreePath}`)) {
		throw new Error(
			`Worktree list verification failed: ${worktreePath} not found in:\n${list.stdout.slice(0, 500)}`,
		);
	}
}

export async function warnGitignore(
	ctx: ExtensionContext,
	repoRoot: string,
): Promise<void> {
	try {
		const gitignore = Bun.file(`${repoRoot}/.gitignore`);
		if (!(await gitignore.exists())) return;
		const content = await gitignore.text();
		if (!/^\.worktrees\/?$/m.test(content)) {
			ctx.ui.notify(
				"Tip: add .worktrees/ to .gitignore so worktrees don't show in git status",
				"info",
			);
		}
	} catch {
		// ignore
	}
}

export async function bestEffortLinkProjectAgentsSkills(
	pi: ExtensionAPI,
	repoRoot: string,
	worktreePath: string,
): Promise<void> {
	const sourceSkillsDir = path.join(repoRoot, ".agents", "skills");
	if (!fs.existsSync(sourceSkillsDir)) return;

	const targetAgentsDir = path.join(worktreePath, ".agents");
	const targetSkillsDir = path.join(targetAgentsDir, "skills");

	try {
		fs.lstatSync(targetSkillsDir);
		return;
	} catch {
		// target missing, continue
	}

	try {
		fs.mkdirSync(targetAgentsDir, { recursive: true });
		fs.symlinkSync(sourceSkillsDir, targetSkillsDir, "dir");
		pi.logger.debug(
			"implementation-engine: linked project .agents/skills into worktree",
			{
				sourceSkillsDir,
				targetSkillsDir,
			},
		);
		return;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		pi.logger.warn(
			"implementation-engine: symlink for project .agents/skills failed, attempting copy",
			{
				error: message,
				sourceSkillsDir,
				targetSkillsDir,
			},
		);
	}

	try {
		fs.cpSync(sourceSkillsDir, targetSkillsDir, { recursive: true });
		pi.logger.warn(
			"implementation-engine: copied project .agents/skills into worktree after symlink failure",
			{
				sourceSkillsDir,
				targetSkillsDir,
			},
		);
	} catch (err) {
		pi.logger.warn(
			"implementation-engine: failed to expose project .agents/skills in worktree",
			{
				error: err instanceof Error ? err.message : String(err),
				sourceSkillsDir,
				targetSkillsDir,
			},
		);
	}
}

export async function bestEffortSetup(worktreePath: string): Promise<void> {
	// Dynamically discover project manifests and install deps in each directory.
	// Uses `find` to locate lock files / manifests, skipping common output dirs.
	const skipDirs = [
		"node_modules",
		".git",
		"target",
		"dist",
		".next",
		".nuxt",
		"__pycache__",
		".venv",
		"venv",
	];
	const pruneArgs = skipDirs.flatMap((d) => ["-name", d, "-o"]).slice(0, -1); // drop trailing -o
	// Build: find <root> \( -name node_modules -o -name .git -o ... \) -prune -o -name <file> -print
	const findManifests = async (filename: string): Promise<string[]> => {
		const res = await tryRunCapture(
			[
				"find",
				worktreePath,
				"(",
				...pruneArgs,
				")",
				"-prune",
				"-o",
				"-name",
				filename,
				"-print",
			],
			worktreePath,
			10_000,
		);
		if (!res) return [];
		return res
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	};

	// ── Node.js / Bun ──
	// Find all package.json files, then pick the right installer per directory
	const packageJsons = await findManifests("package.json");
	for (const pj of packageJsons) {
		const dir = pj.substring(0, pj.lastIndexOf("/"));
		// Determine which package manager to use based on lock files in that dir
		const hasBunLock =
			(await fileExists(`${dir}/bun.lockb`)) ||
			(await fileExists(`${dir}/bun.lock`));
		const hasPnpmLock = await fileExists(`${dir}/pnpm-lock.yaml`);
		const hasYarnLock = await fileExists(`${dir}/yarn.lock`);

		if (hasBunLock) {
			await tryRun(["bun", "install"], dir, 120_000);
		} else if (hasPnpmLock) {
			await tryRun(["pnpm", "install"], dir, 120_000);
		} else if (hasYarnLock) {
			await tryRun(["yarn", "install"], dir, 120_000);
		} else {
			await tryRun(["npm", "install"], dir, 120_000);
		}
	}

	// ── Rust ──
	const cargoTomls = await findManifests("Cargo.toml");
	// Only fetch at workspace roots (has [workspace] or no parent Cargo.toml above it)
	for (const ct of cargoTomls) {
		const dir = ct.substring(0, ct.lastIndexOf("/"));
		// Skip if a parent Cargo.toml exists (this is a workspace member, not root)
		const isNested = cargoTomls.some(
			(other) =>
				other !== ct &&
				ct.startsWith(other.substring(0, other.lastIndexOf("/") + 1)),
		);
		if (!isNested) {
			await tryRun(["cargo", "fetch"], dir, 120_000);
		}
	}

	// ── Go ──
	const goMods = await findManifests("go.mod");
	for (const gm of goMods) {
		const dir = gm.substring(0, gm.lastIndexOf("/"));
		await tryRun(["go", "mod", "download"], dir, 120_000);
	}

	// ── Python ──
	const pyprojects = await findManifests("pyproject.toml");
	for (const pp of pyprojects) {
		const dir = pp.substring(0, pp.lastIndexOf("/"));
		if (await fileExists(`${dir}/uv.lock`)) {
			await tryRun(["uv", "sync"], dir, 120_000);
		} else if (await fileExists(`${dir}/requirements.txt`)) {
			await tryRun(["pip", "install", "-r", "requirements.txt"], dir, 120_000);
		}
	}
}

export interface AuggieIndexWarmupOptions {
	statusKey?: string | null;
	statusText?: string | null;
	missingCliNotify?: string | null;
	failureNotify?: string | null;
	successNotify?: string | null;
	timeoutMs?: number;
}

export async function bestEffortAuggieIndex(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workspacePath: string,
	options: AuggieIndexWarmupOptions = {},
): Promise<boolean> {
	const enabledRaw =
		process.env.OMP_IMPLEMENT_AUGGIE_INDEX?.trim().toLowerCase();
	if (enabledRaw && FALSE_ENV_VALUES.includes(enabledRaw)) {
		pi.logger.debug(
			"implementation-engine: skipping auggie indexing (disabled by env)",
		);
		return false;
	}

	const {
		statusKey = "worktree",
		statusText = "worktree: indexing with auggie...",
		missingCliNotify = "Auggie CLI not found; skipping automatic index warmup",
		failureNotify = "Auggie index warmup failed; you may need to run 'auggie' manually",
		successNotify = "Auggie index warmup completed for the new worktree",
		timeoutMs = 180_000,
	} = options;

	if (ctx.hasUI && statusKey && statusText) {
		ctx.ui.setStatus(statusKey, statusText);
	}

	try {
		const version = await runAllowFail(
			["auggie", "--version"],
			workspacePath,
			10_000,
		);
		if (version.code !== 0) {
			const detail = (version.stderr || version.stdout).trim().slice(0, 240);
			pi.logger.warn(
				"implementation-engine: auggie not available for automatic indexing",
				{ detail, workspacePath },
			);
			if (ctx.hasUI && missingCliNotify) {
				ctx.ui.notify(missingCliNotify, "warning");
			}
			return false;
		}

		const warmupInstruction =
			"Warm this workspace index for Augment context retrieval. Reply with exactly: indexed";
		const warmup = await runAllowFail(
			[
				"auggie",
				"--workspace-root",
				workspacePath,
				"--quiet",
				"--print",
				warmupInstruction,
			],
			workspacePath,
			timeoutMs,
		);

		if (warmup.code !== 0) {
			const detail = (warmup.stderr || warmup.stdout).trim().slice(0, 240);
			pi.logger.warn("implementation-engine: automatic auggie indexing failed", {
				detail,
				workspacePath,
			});
			if (ctx.hasUI && failureNotify) {
				ctx.ui.notify(failureNotify, "warning");
			}
			return false;
		}

		pi.logger.debug("implementation-engine: auggie index warmup completed", {
			workspacePath,
		});
		if (ctx.hasUI && successNotify) {
			ctx.ui.notify(successNotify, "info");
		}
		return true;
	} finally {
		if (ctx.hasUI && statusKey) {
			ctx.ui.setStatus(statusKey, undefined);
		}
	}
}

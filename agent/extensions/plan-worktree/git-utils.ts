import * as fs from "node:fs";

export interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
	bare: boolean;
}

export async function run(cmd: string[], cwd: string, timeoutMs = 30_000): Promise<SpawnResult> {
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

export async function runAllowFail(cmd: string[], cwd: string, timeoutMs = 30_000): Promise<SpawnResult> {
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

export async function tryRun(cmd: string[], cwd: string, timeoutMs = 30_000): Promise<void> {
	try {
		await run(cmd, cwd, timeoutMs);
	} catch {
		// best-effort helper
	}
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		return await Bun.file(path).exists();
	} catch {
		return false;
	}
}

export async function getRepoRoot(cwd: string): Promise<string> {
	const res = await run(["git", "rev-parse", "--show-toplevel"], cwd);
	const root = res.stdout.trim();
	if (!root) throw new Error(`Could not detect git repo root from ${cwd}`);
	return root;
}

export function isInsideWorktree(cwd: string): boolean {
	const gitPath = `${cwd}/.git`;
	try {
		if (!fs.existsSync(gitPath)) return false;
		return fs.lstatSync(gitPath).isFile();
	} catch {
		return false;
	}
}

export async function getCurrentBranch(cwd: string): Promise<string> {
	const res = await run(["git", "branch", "--show-current"], cwd);
	return res.stdout.trim();
}

export async function getWorktreeList(repoRoot: string): Promise<WorktreeInfo[]> {
	const res = await run(["git", "worktree", "list", "--porcelain"], repoRoot);
	const blocks = res.stdout
		.split("\n\n")
		.map(s => s.trim())
		.filter(Boolean);

	const out: WorktreeInfo[] = [];
	for (const block of blocks) {
		const lines = block.split("\n").map(s => s.trim()).filter(Boolean);
		let path = "";
		let branch = "";
		let head = "";
		let bare = false;

		for (const line of lines) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
			else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				branch = ref.replace(/^refs\/heads\//, "");
			}
			else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
			else if (line === "bare") bare = true;
		}

		if (path) out.push({ path, branch, head, bare });
	}

	return out;
}

export async function isBranchMerged(branch: string, into: string, cwd: string): Promise<boolean> {
	if (!branch) return false;
	const res = await run(["git", "branch", "--merged", into], cwd);
	const lines = res.stdout
		.split("\n")
		.map(s => s.replace(/^\*\s*/, "").trim())
		.filter(Boolean);
	return lines.includes(branch);
}

export async function detectBaseBranch(repoRoot: string): Promise<"master" | "main"> {
	const master = await runAllowFail(["git", "show-ref", "--verify", "--quiet", "refs/heads/master"], repoRoot);
	if (master.code === 0) return "master";
	return "main";
}

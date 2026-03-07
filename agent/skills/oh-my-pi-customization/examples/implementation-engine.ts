/**
 * implementation-engine extension — reference implementation
 *
 * Demonstrates:
 * - Intercepting /implement via before_agent_start
 * - Interactive UI prompts (select, input)
 * - Synchronous blocking work before agent starts
 * - Using Bun.spawn (not pi.exec) for reliable subprocess execution
 * - Switching session cwd with process.chdir()
 * - Returning both message + systemPrompt from handler
 * - Registering a custom /worktree command
 * - Dynamic dependency discovery with `find`
 *
 * See ~/.omp/agent/extensions/implementation-engine/index.ts for the live version.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function implementationEngineExample(pi: ExtensionAPI) {
	let setupDone = false;

	pi.on("session_switch", async () => {
		setupDone = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI || setupDone) return;

		const promptText = event.prompt ?? "";
		if (!promptText.trimStart().toLowerCase().startsWith("/implement")) return;

		try {
			// 1. Detect repo root (pi.exec is safe during handler)
			const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
			const repoRoot = res.stdout.trim();
			if (!repoRoot) throw new Error("Not in a git repository");

			// 2. UI prompt: base branch
			const baseChoice = await ctx.ui.select("Base branch?", ["master", "main", "Other (type custom...)"]);
			if (!baseChoice) { ctx.abort(); return; }
			const baseBranch = baseChoice.startsWith("Other")
				? await ctx.ui.input("Enter base branch:", "master")
				: baseChoice;
			if (!baseBranch) { ctx.abort(); return; }

			// 3. UI prompt: new branch name
			const branchName = await ctx.ui.input("New branch name:", "feature/my-feature");
			if (!branchName) { ctx.abort(); return; }

			// 4. Create worktree (synchronous, using Bun.spawn for reliable stdio)
			ctx.ui.setStatus("worktree", "worktree: creating...");

			// Preserve slashes in branch name for nested grouping:
			// "fix/auth-error" → .worktrees/fix/auth-error
			const dirName = branchName.replace(/[^a-zA-Z0-9._\/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
			const worktreePath = `${repoRoot}/.worktrees/${dirName}`;

			// mkdir -p parent (for nested paths like .worktrees/fix/)
			const parentDir = worktreePath.substring(0, worktreePath.lastIndexOf("/"));
			await run(["mkdir", "-p", parentDir], repoRoot);

			await run(["git", "worktree", "add", "-b", branchName, worktreePath, baseBranch], repoRoot);

			// 5. Dynamic dependency installation
			ctx.ui.setStatus("worktree", "worktree: installing deps...");
			// Find all package.json files, detect package manager, install
			const findRes = await run(
				["find", worktreePath, "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune",
				 "-o", "-name", "package.json", "-print"],
				worktreePath,
				10_000,
			).catch(() => ({ stdout: "" }));

			for (const pj of findRes.stdout.split("\n").filter(Boolean)) {
				const dir = pj.substring(0, pj.lastIndexOf("/"));
				const hasBun = await fileExists(`${dir}/bun.lockb`) || await fileExists(`${dir}/bun.lock`);
				if (hasBun) {
					await tryRun(["bun", "install"], dir, 120_000);
				} else {
					await tryRun(["npm", "install"], dir, 120_000);
				}
			}

			// 6. Switch session to worktree
			process.chdir(worktreePath);
			setupDone = true;
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify("Worktree ready", "info");

			// 7. Return message + system prompt addendum
			return {
				message: {
					customType: "implement-worktree/ready",
					content: `## Worktree ready\n\n- Branch: \`${branchName}\`\n- Path: \`${worktreePath}\``,
					display: true,
					details: { baseBranch, branchName, worktreePath },
				},
				systemPrompt:
					event.systemPrompt +
					`\n\n## Worktree Active\nBranch: ${branchName}\nPath: ${worktreePath}\n`,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("implementation-engine: setup failed", { error: msg });
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify(`Worktree error: ${msg}`, "error");
			ctx.abort();
		}
	});
}

// Bun.spawn wrapper — reliable stdio capture (unlike pi.exec in background contexts)
async function run(cmd: string[], cwd: string, timeoutMs = 30_000) {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(timer);
	if (code !== 0) throw new Error(`\`${cmd.join(" ")}\` failed (code ${code}): ${(stderr || stdout).trim()}`);
	return { stdout, stderr, code };
}

async function tryRun(cmd: string[], cwd: string, timeoutMs = 30_000) {
	try { await run(cmd, cwd, timeoutMs); } catch { /* best-effort */ }
}

async function fileExists(path: string) {
	try { return await Bun.file(path).exists(); } catch { return false; }
}

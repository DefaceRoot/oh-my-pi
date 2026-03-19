import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

type InputProfileMode = "minimal" | "standard" | "detailed";

type SemanticTask = {
	id: string;
	title: string;
	description: string;
	constraints: string[];
	acceptance_criteria: string[];
	summary?: string;
	intent?: string;
	blockers?: string[];
};

type ToonDelegationResult = {
	toon: string;
	metadata: {
		contract_version: string;
		envelope: {
			id: string;
			created_at: string;
			parent_envelope_id?: string;
		};
		input_policy: {
			mode: InputProfileMode;
		};
		context: {
			repo_root: string;
			workflow_mode?: string;
			plan_path?: string;
			plan_workspace_dir?: string;
			plan_excerpt?: string;
			git?: {
				branch: string;
				commit: string;
				base_branch?: string;
			};
			worktree?: {
				path: string;
			};
			untrusted_context?: unknown;
		};
		roles: {
			delegator: string;
			delegate: string;
		};
		progress?: {
			completed_tasks?: unknown[];
			upstream_tasks?: unknown[];
			lessons_learned?: unknown[];
		};
		task: SemanticTask;
		retry_context?: unknown;
		output_contract?: unknown;
	};
};

type ToonDelegationBuilderModule = {
	buildToonDelegation: (input: {
		session: ToolSession;
		delegate: string;
		task: SemanticTask;
	}) => ToonDelegationResult | Promise<ToonDelegationResult>;
};

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: {
			get: () => undefined,
		} as never,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getRuntimeRole: () => "  IMPLEMENT  ",
		getSessionEntries: () => [],
		getPlanModeState: () => undefined,
		getCompactContext: () => "",
		...overrides,
	} as ToolSession;
}

function createSemanticTask(overrides: Partial<SemanticTask> = {}): SemanticTask {
	return {
		id: "toon-delegation-builder-red",
		title: "Build the TOON delegation envelope",
		description: "Assemble the structured TOON payload and typed metadata for a child delegate.",
		constraints: ["Keep the field order stable", "Do not re-emit legacy wrappers"],
		acceptance_criteria: ["Returns a TOON string", "Returns typed metadata"],
		...overrides,
	};
}

function makeInheritedContext(): string {
	return [
		"<delegation_context>",
		`repository_cwd: ${JSON.stringify("/inherited/workspace")}`,
		`workflow_mode: ${JSON.stringify("plan_linked")}`,
		`repo_root: ${JSON.stringify("/inherited/repo")}`,
		`branch_name: ${JSON.stringify("feature/inherited")}`,
		`base_branch: ${JSON.stringify("origin/main")}`,
		"</delegation_context>",
	].join("\n");
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

async function createGitRepoWithUpstream(): Promise<{
	repoRoot: string;
	remoteRoot: string;
	branch: string;
	commit: string;
	baseBranch: string;
}> {
	const repoRoot = makeTempDir("@omp-toon-builder-repo-");
	const remoteRoot = makeTempDir("@omp-toon-builder-remote-");

	try {
		runGit(repoRoot, ["init"]);
		runGit(repoRoot, ["checkout", "-b", "main"]);
		runGit(repoRoot, ["config", "user.name", "TOON Builder Test"]);
		runGit(repoRoot, ["config", "user.email", "toon-builder-test@example.com"]);
		await Bun.write(path.join(repoRoot, "README.md"), "seed\n");
		runGit(repoRoot, ["add", "README.md"]);
		runGit(repoRoot, ["commit", "-m", "seed"]);
		runGit(remoteRoot, ["init", "--bare"]);
		runGit(repoRoot, ["remote", "add", "origin", remoteRoot]);
		runGit(repoRoot, ["push", "-u", "origin", "main"]);

		return {
			repoRoot,
			remoteRoot,
			branch: runGit(repoRoot, ["branch", "--show-current"]),
			commit: runGit(repoRoot, ["rev-parse", "HEAD"]),
			baseBranch: runGit(repoRoot, ["for-each-ref", "--format=%(upstream:short)", "refs/heads/main"]),
		};
	} catch (error) {
		fs.rmSync(repoRoot, { recursive: true, force: true });
		fs.rmSync(remoteRoot, { recursive: true, force: true });
		throw error;
	}
}

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = makeTempDir("@omp-toon-builder-");
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

async function loadBuilderModule(): Promise<ToonDelegationBuilderModule> {
	return (await import("../../src/task/toon-delegation-builder")) as ToonDelegationBuilderModule;
}

async function buildToonDelegation(input: {
	session: ToolSession;
	delegate: string;
	task: SemanticTask;
}): Promise<ToonDelegationResult> {
	const builder = await loadBuilderModule();
	expect(typeof builder.buildToonDelegation).toBe("function");
	return await builder.buildToonDelegation(input);
}

describe("toon delegation builder", () => {
	it("renders the minimal contract root and typed sections", async () => {
		await withTempDir(async cwd => {
			const session = createSession(cwd);
			const task = createSemanticTask();

			const result = await buildToonDelegation({
				session,
				delegate: "lint",
				task,
			});

			expect(result.toon.startsWith('delegation:\n  contract_version: "omp-delegation/v1"')).toBe(true);
			expect(result.toon).toContain("\n  envelope:\n");
			expect(result.toon).toContain("\n  input_policy:\n");
			expect(result.toon).toContain("\n  context:\n");
			expect(result.toon).toContain("\n  roles:\n");
			expect(result.toon).toContain("\n  task:\n");
			expect(result.toon).not.toContain("\n  progress:\n");
			expect(result.toon).not.toContain("\n  retry_context:\n");
			expect(result.toon).not.toContain("\n  output_contract:\n");

			expect(result.metadata.contract_version).toBe("omp-delegation/v1");
			expect(result.metadata.envelope.id).toMatch(/^del_[0-9a-f]{12}$/);
			expect(result.metadata.envelope.created_at).toBeTruthy();
			expect(result.metadata.input_policy.mode).toBe("minimal");
			expect(result.metadata.context.repo_root).toBe(cwd);
			expect(result.metadata.context.workflow_mode).toBeTruthy();
			expect(result.metadata.context.git).toBeUndefined();
			expect(result.metadata.roles.delegator).toBe("implement");
			expect(result.metadata.roles.delegate).toBe("lint");
			expect(result.metadata.task.id).toBe(task.id);
			expect(result.metadata.task.title).toBe(task.title);
			expect(result.metadata.task.description).toBe(task.description);
			expect(result.metadata.task.constraints).toEqual(task.constraints);
			expect(result.metadata.task.acceptance_criteria).toEqual(task.acceptance_criteria);
			expect(result.metadata.progress).toBeUndefined();
		});
	});

	it("keeps the envelope id stable for the same semantic task", async () => {
		await withTempDir(async cwd => {
			const session = createSession(cwd);
			const task = createSemanticTask();

			const clean = await buildToonDelegation({
				session,
				delegate: "lint",
				task,
			});

			const inherited = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeInheritedContext() }),
				delegate: "lint",
				task,
			});

			const whitespaceVariant = await buildToonDelegation({
				session,
				delegate: "lint",
				task: createSemanticTask({
					title: `  ${task.title}  `,
					description: `\n${task.description}\n`,
					constraints: task.constraints.map(constraint => ` ${constraint} `),
					acceptance_criteria: task.acceptance_criteria.map(criteria => `\t${criteria}\t`),
				}),
			});

			const changed = await buildToonDelegation({
				session,
				delegate: "lint",
				task: createSemanticTask({
					acceptance_criteria: [...task.acceptance_criteria, "Capture typed metadata in the sidecar"],
				}),
			});

			expect(clean.metadata.envelope.id).toMatch(/^del_[0-9a-f]{12}$/);
			expect(inherited.metadata.envelope.id).toBe(clean.metadata.envelope.id);
			expect(whitespaceVariant.metadata.envelope.id).toBe(clean.metadata.envelope.id);
			expect(changed.metadata.envelope.id).not.toBe(clean.metadata.envelope.id);
		});
	});

	it("selects input profile defaults by delegate name and keeps git metadata without a worktree", async () => {
		const gitRepo = await createGitRepoWithUpstream();
		try {
			const cases: Array<[string, InputProfileMode]> = [
				["lint", "minimal"],
				["code-reviewer", "minimal"],
				["explore", "standard"],
				["research", "standard"],
				["plan-verifier", "standard"],
				["implement", "detailed"],
				["task", "detailed"],
			];

			for (const [delegate, expectedMode] of cases) {
				const result = await buildToonDelegation({
					session: createSession(gitRepo.repoRoot, {
						getRuntimeRole: () => "implement",
						getSessionEntries: () => [],
						getPlanModeState: () => undefined,
					}),
					delegate,
					task: createSemanticTask(),
				});

				expect(result.metadata.input_policy.mode).toBe(expectedMode);
			}

			const builderModule = (await loadBuilderModule()) as ToonDelegationBuilderModule & {
				resolveInputProfile?: (delegate: string, override?: InputProfileMode) => InputProfileMode;
			};
			if (typeof builderModule.resolveInputProfile === "function") {
				expect(builderModule.resolveInputProfile("lint", "detailed")).toBe("detailed");
			}

			const gitResult = await buildToonDelegation({
				session: createSession(gitRepo.repoRoot, {
					getRuntimeRole: () => "implement",
					getSessionEntries: () => [],
					getPlanModeState: () => undefined,
				}),
				delegate: "research",
				task: createSemanticTask(),
			});

			expect(gitResult.metadata.context.repo_root).toBe(gitRepo.repoRoot);
			expect(gitResult.metadata.context.worktree).toBeUndefined();
			expect(gitResult.metadata.context.git).toMatchObject({
				branch: gitRepo.branch,
				commit: gitRepo.commit,
				base_branch: gitRepo.baseBranch,
			});
			expect(gitResult.toon).toContain(gitRepo.branch);
		} finally {
			fs.rmSync(gitRepo.repoRoot, { recursive: true, force: true });
			fs.rmSync(gitRepo.remoteRoot, { recursive: true, force: true });
		}
	});
});

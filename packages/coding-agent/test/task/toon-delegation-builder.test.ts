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
	validation_passed: boolean;
	quality_report?: {
		warnings: string[];
		errors: string[];
	};
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
		options?: {
			profile?: InputProfileMode;
			progress?: {
				completed_tasks?: unknown[];
				upstream_tasks?: unknown[];
				lessons_learned?: string[];
			};
		};
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

function makeDelegationContext(fields: Record<string, string>): string {
	return [
		"<delegation_context>",
		...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
		"</delegation_context>",
	].join("\n");
}

function makeInheritedContext(): string {
	return makeDelegationContext({
		repository_cwd: "/inherited/workspace",
		workflow_mode: "plan_linked",
		repo_root: "/inherited/repo",
		branch_name: "feature/inherited",
		base_branch: "origin/main",
	});
}

const RICH_PLAN_CONTENT = [
	"# Launch TOON delegation",
	"",
	"## Plan Excerpt",
	"Keep the handoff compact while preserving the upstream reasoning trail.",
	"Use the plan file rather than synthetic placeholders.",
	"",
	"## Goals",
	"Ship detailed-profile TOON envelopes that reuse plan context instead of inventing placeholders.",
	"",
	"## Dependencies",
	"- id: normalize-context",
	"  summary: Normalize inherited plan metadata before rendering TOON",
	"- id: summarize-plan",
	"  summary: Extract plan sections into concise delegation metadata",
	"",
	"## Lessons Learned",
	"- Keep plan excerpts short.",
	"- Only surface dependencies when the plan names them.",
	"- Prefer inherited intent over empty defaults.",
	"- Do not invent pseudo-plan structure.",
	"- Cap lessons learned to five entries.",
	"- This sixth entry must be excluded by the cap.",
].join("\n");

const BARE_PLAN_CONTENT = [
	"# Launch TOON delegation",
	"",
	"## Notes",
	"No structured handoff metadata is available yet.",
].join("\n");

async function writePlanFixture(filePath: string, content: string): Promise<void> {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
}

function makePlanContext(cwd: string, planPath: string): string {
	return makeDelegationContext({
		repository_cwd: cwd,
		workflow_mode: "plan_linked",
		repo_root: cwd,
		plan_file_path: planPath,
		plan_workspace_dir: path.dirname(planPath),
	});
}

function makeImplementationContext(cwd: string, extraFields: Record<string, string> = {}): string {
	return makeDelegationContext({
		repository_cwd: cwd,
		workflow_mode: "implement",
		repo_root: cwd,
		...extraFields,
	});
}

async function createPlanFixtureSet(cwd: string): Promise<{
	richPlanPath: string;
	barePlanPath: string;
}> {
	const richPlanPath = path.join(cwd, "plan-fixtures", "rich.md");
	const barePlanPath = path.join(cwd, "plan-fixtures", "bare.md");
	await writePlanFixture(richPlanPath, RICH_PLAN_CONTENT);
	await writePlanFixture(barePlanPath, BARE_PLAN_CONTENT);
	return { richPlanPath, barePlanPath };
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
	options?: {
		profile?: InputProfileMode;
	};
}): Promise<ToonDelegationResult> {
	const builder = await loadBuilderModule();
	expect(typeof builder.buildToonDelegation).toBe("function");
	return await builder.buildToonDelegation(input);
}

async function buildDelegation(input: {
	cwd: string;
	compactContext: string;
	delegate?: string;
	profile?: InputProfileMode;
	task?: SemanticTask;
}): Promise<ToonDelegationResult> {
	return await buildToonDelegation({
		session: createSession(input.cwd, {
			getCompactContext: () => input.compactContext,
		}),
		delegate: input.delegate ?? "task",
		task: input.task ?? createSemanticTask(),
		options: { profile: input.profile ?? "detailed" },
	});
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
	it("extracts a plan excerpt only when the matching heading exists", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath, barePlanPath } = await createPlanFixtureSet(cwd);
			const richContext = makePlanContext(cwd, richPlanPath);

			const detailedResult = await buildDelegation({
				cwd,
				compactContext: richContext,
			});
			expect(detailedResult.metadata.context.plan_excerpt).toEqual(
				expect.stringContaining("Keep the handoff compact while preserving the upstream reasoning trail."),
			);
			expect(detailedResult.metadata.context.plan_excerpt).toEqual(
				expect.stringContaining("Use the plan file rather than synthetic placeholders."),
			);

			const standardResult = await buildDelegation({
				cwd,
				compactContext: richContext,
				profile: "standard",
			});
			expect(standardResult.metadata.context.plan_excerpt).toBeUndefined();

			const bareResult = await buildDelegation({
				cwd,
				compactContext: makePlanContext(cwd, barePlanPath),
			});
			expect(bareResult.metadata.context.plan_excerpt).toBeUndefined();
		});
	});

	it("includes upstream task summaries only when plan dependencies are available", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath, barePlanPath } = await createPlanFixtureSet(cwd);
			const richContext = makePlanContext(cwd, richPlanPath);

			const detailedResult = await buildDelegation({
				cwd,
				compactContext: richContext,
			});

			const upstreamTasks = detailedResult.metadata.progress?.upstream_tasks as
				| Array<{ summary?: string }>
				| undefined;
			expect(upstreamTasks).toHaveLength(2);
			expect(upstreamTasks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						summary: "Normalize inherited plan metadata before rendering TOON",
					}),
					expect.objectContaining({
						summary: "Extract plan sections into concise delegation metadata",
					}),
				]),
			);

			const standardResult = await buildDelegation({
				cwd,
				compactContext: richContext,
				profile: "standard",
			});
			expect(standardResult.metadata.progress?.upstream_tasks).toBeUndefined();

			const bareResult = await buildDelegation({
				cwd,
				compactContext: makePlanContext(cwd, barePlanPath),
			});
			expect(bareResult.metadata.progress?.upstream_tasks).toBeUndefined();
		});
	});

	it("populates commander intent from plan goals or inherited context", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath } = await createPlanFixtureSet(cwd);
			const goalContext = makePlanContext(cwd, richPlanPath);
			const goalResult = await buildDelegation({
				cwd,
				compactContext: goalContext,
			});
			expect(goalResult.metadata.task.intent).toBe(
				"Ship detailed-profile TOON envelopes that reuse plan context instead of inventing placeholders.",
			);

			const inheritedIntent = "Carry forward the original migration intent without adding pseudo-sections.";
			const inheritedResult = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd, {
					commander_intent: inheritedIntent,
				}),
			});
			expect(inheritedResult.metadata.task.intent).toBe(inheritedIntent);

			const missingResult = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
			});
			expect(missingResult.metadata.task.intent).toBeUndefined();
		});
	});

	it("caps lessons learned to five entries and omits them when absent", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath, barePlanPath } = await createPlanFixtureSet(cwd);
			const richContext = makePlanContext(cwd, richPlanPath);
			const detailedResult = await buildDelegation({
				cwd,
				compactContext: richContext,
			});
			const lessons = detailedResult.metadata.progress?.lessons_learned;
			expect(lessons).toHaveLength(5);
			expect(lessons).toEqual([
				"Keep plan excerpts short.",
				"Only surface dependencies when the plan names them.",
				"Prefer inherited intent over empty defaults.",
				"Do not invent pseudo-plan structure.",
				"Cap lessons learned to five entries.",
			]);
			// Sixth entry must be excluded by the cap
			expect(lessons).not.toContain("This sixth entry must be excluded by the cap.");

			const bareResult = await buildDelegation({
				cwd,
				compactContext: makePlanContext(cwd, barePlanPath),
			});
			expect(bareResult.metadata.progress?.lessons_learned).toBeUndefined();
		});
	});
});

describe("delegation quality linter", () => {
	it("passes for a well-formed delegation", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask(),
			});
			expect(result.quality_report?.warnings).toEqual([]);
			expect(result.quality_report?.errors).toEqual([]);
		});
	});

	it("warns when task.description is under 20 characters", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask({ description: "Too short" }),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("task.description is under 20 characters"))).toBe(true);
		});
	});

	it("warns when task.constraints is empty", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask({ constraints: [] }),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("task.constraints is empty or missing"))).toBe(true);
		});
	});

	it("warns when task.acceptance_criteria is empty", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask({ acceptance_criteria: [] }),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("task.acceptance_criteria is empty or missing"))).toBe(true);
		});
	});

	it("errors when plan_path is set but file does not exist on disk", async () => {
		await withTempDir(async cwd => {
			const missingPlanPath = path.join(cwd, "nonexistent", "plan.md");
			const result = await buildDelegation({
				cwd,
				compactContext: makePlanContext(cwd, missingPlanPath),
			});
			const errors = result.quality_report?.errors ?? [];
			expect(errors.some(e => e.includes("plan_path is set but file does not exist"))).toBe(true);
		});
	});
});

describe("token budget trimming", () => {
	it("does not trim an envelope under the budget", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask(),
			});
			const tokenCount = Math.ceil(result.toon.length / 4);
			expect(tokenCount).toBeLessThanOrEqual(2000);
			const baseTask = createSemanticTask();
			expect(result.metadata.task.title).toBe(baseTask.title);
			expect(result.metadata.task.constraints).toEqual(baseTask.constraints);
			expect(result.metadata.task.acceptance_criteria).toEqual(baseTask.acceptance_criteria);
		});
	});

	it("preserves title, constraints, and acceptance_criteria when description must be truncated", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const longDescription = "A".repeat(8500);
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask({ description: longDescription }),
			});
			const baseTask = createSemanticTask();
			expect(result.metadata.task.title).toBe(baseTask.title);
			expect(result.metadata.task.constraints).toEqual(baseTask.constraints);
			expect(result.metadata.task.acceptance_criteria).toEqual(baseTask.acceptance_criteria);
			expect(result.metadata.task.description.length).toBeLessThanOrEqual(200);
		});
	});

	it("removes lessons_learned before truncating description when over budget", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const longDescription = "A".repeat(8500);
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask({ description: longDescription }),
				options: {
					profile: "detailed",
					progress: {
						lessons_learned: ["Lesson A", "Lesson B", "Lesson C"],
					},
				},
			});
			expect(result.metadata.progress?.lessons_learned).toBeUndefined();
		});
	});
});

describe("TOON round-trip validation", () => {
	it("sets validation_passed true for a well-formed envelope", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask(),
			});
			expect(result.validation_passed).toBe(true);
		});
	});

	it("includes contract_version, envelope id, and task title in the TOON output", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask(),
			});
			expect(result.toon).toContain('contract_version: "omp-delegation/v1"');
			expect(result.toon).toContain(`id: ${JSON.stringify(result.metadata.envelope.id)}`);
			expect(result.toon).toContain(`title: ${JSON.stringify(result.metadata.task.title)}`);
		});
	});
});

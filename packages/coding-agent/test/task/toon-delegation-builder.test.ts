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
			retryContext?: Record<string, unknown>;
			outputContract?: Record<string, unknown>;
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

const PLAN_WITH_PROGRESS_CONTENT = [
	"# Feature implementation",
	"",
	"## Goals",
	"Deliver the end-to-end feature with tests and documentation.",
	"",
	"## Progress",
	"- [x] Design the data schema",
	"- [x] Write unit tests",
	"- [x] Implement core logic",
	"- [x] Wire up the API",
	"- [x] Review and fix edge cases",
	"- [x] Update documentation",
	"- [ ] Deploy to staging",
	"- [ ] Verify in production",
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

	it("does not warn when task.constraints is empty", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask({ constraints: [] }),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("task.constraints is empty or missing"))).toBe(false);
		});
	});

	it("does not warn when task.acceptance_criteria is empty", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask({ acceptance_criteria: [] }),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("task.acceptance_criteria is empty or missing"))).toBe(false);
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

// ────────────────────────────────────────────────────────────────────
// Unit 2.5: progress extraction from plan and todo list
// ────────────────────────────────────────────────────────────────────

describe("progress population - plan workflow", () => {
	it("extracts completed tasks from plan checkboxes for detailed profile", async () => {
		await withTempDir(async cwd => {
			const planPath = path.join(cwd, "plan.md");
			await writePlanFixture(planPath, PLAN_WITH_PROGRESS_CONTENT);
			const result = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makePlanContext(cwd, planPath) }),
				delegate: "implement",
				task: createSemanticTask(),
			});
			const completedTasks = result.metadata.progress?.completed_tasks as
				| Array<{ summary: string; status: string }>
				| undefined;
			// detailed: window=10; plan has 6 completed items
			expect(completedTasks).toHaveLength(6);
			expect(completedTasks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ summary: "Design the data schema", status: "completed" }),
					expect.objectContaining({ summary: "Update documentation", status: "completed" }),
				]),
			);
		});
	});

	it("applies standard profile window of 5 to plan completed tasks", async () => {
		await withTempDir(async cwd => {
			const planPath = path.join(cwd, "plan.md");
			await writePlanFixture(planPath, PLAN_WITH_PROGRESS_CONTENT);
			const result = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makePlanContext(cwd, planPath) }),
				delegate: "implement",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			// standard: window=5; plan has 6 → last 5
			expect(result.metadata.progress?.completed_tasks).toHaveLength(5);
		});
	});

	it("omits completed_tasks for minimal profile", async () => {
		await withTempDir(async cwd => {
			const planPath = path.join(cwd, "plan.md");
			await writePlanFixture(planPath, PLAN_WITH_PROGRESS_CONTENT);
			const result = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makePlanContext(cwd, planPath) }),
				delegate: "lint",
				task: createSemanticTask(),
			});
			// minimal profile: no plan enrichment loaded
			expect(result.metadata.progress?.completed_tasks).toBeUndefined();
		});
	});

	it("does not count unchecked items as completed", async () => {
		await withTempDir(async cwd => {
			const planPath = path.join(cwd, "plan.md");
			await writePlanFixture(planPath, PLAN_WITH_PROGRESS_CONTENT);
			const result = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makePlanContext(cwd, planPath) }),
				delegate: "implement",
				task: createSemanticTask(),
			});
			const completedTasks = result.metadata.progress?.completed_tasks as Array<{ summary: string }> | undefined;
			// "Deploy to staging" and "Verify in production" are unchecked - must not appear
			const summaries = completedTasks?.map(t => t.summary) ?? [];
			expect(summaries).not.toContain("Deploy to staging");
			expect(summaries).not.toContain("Verify in production");
		});
	});
});

describe("progress population - non-plan workflow", () => {
	it("extracts completed tasks from session todo list", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeImplementationContext(cwd),
					getTodoPhases: () => [
						{
							id: "phase-1",
							name: "Phase 1",
							tasks: [
								{ id: "task-1", content: "Research the API design", status: "completed" as const },
								{ id: "task-2", content: "Write the schema", status: "completed" as const },
								{ id: "task-3", content: "Implement the feature", status: "in_progress" as const },
							],
						},
					],
				}),
				delegate: "implement",
				task: createSemanticTask(),
			});
			const completedTasks = result.metadata.progress?.completed_tasks as
				| Array<{ summary: string; status: string }>
				| undefined;
			expect(completedTasks).toHaveLength(2);
			expect(completedTasks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ summary: "Research the API design", status: "completed" }),
					expect.objectContaining({ summary: "Write the schema", status: "completed" }),
				]),
			);
		});
	});

	it("omits completed_tasks when all todos are pending or in_progress", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeImplementationContext(cwd),
					getTodoPhases: () => [
						{
							id: "phase-1",
							name: "Phase 1",
							tasks: [
								{ id: "task-1", content: "Pending task", status: "pending" as const },
								{ id: "task-2", content: "In progress task", status: "in_progress" as const },
							],
						},
					],
				}),
				delegate: "implement",
				task: createSemanticTask(),
			});
			expect(result.metadata.progress?.completed_tasks).toBeUndefined();
		});
	});

	it("applies standard window of 5 to todo-derived completed tasks", async () => {
		await withTempDir(async cwd => {
			const manyTasks = Array.from({ length: 8 }, (_, i) => ({
				id: `task-${i + 1}`,
				content: `Completed task ${i + 1}`,
				status: "completed" as const,
			}));
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeImplementationContext(cwd),
					getTodoPhases: () => [{ id: "phase-1", name: "Phase 1", tasks: manyTasks }],
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			// standard: window=5; 8 completed → last 5
			expect(result.metadata.progress?.completed_tasks).toHaveLength(5);
			const completedTasks = result.metadata.progress?.completed_tasks as Array<{ summary: string }> | undefined;
			// Last 5 items are tasks 4-8
			expect(completedTasks?.[0]).toMatchObject({ summary: "Completed task 4" });
			expect(completedTasks?.[4]).toMatchObject({ summary: "Completed task 8" });
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Unit 2.5: retry context serialization
// ────────────────────────────────────────────────────────────────────

describe("retry context serialization", () => {
	it("includes retry_context in TOON and metadata when provided", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const retryCtx = {
				attempt: 2,
				prior_failure: {
					error_type: "test_failure",
					failing_step: "bun test",
					what_was_tried: "Ran unit tests for the feature",
					diagnosis: "Type error in the transform pipeline",
				},
			};
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask(),
				options: { retryContext: retryCtx },
			});
			expect(result.metadata.retry_context).toMatchObject(retryCtx);
			expect(result.toon).toContain("retry_context:");
			expect(result.toon).toContain('error_type: "test_failure"');
		});
	});

	it("omits retry_context when not provided (first attempt)", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd),
				delegate: "implement",
				task: createSemanticTask(),
			});
			expect(result.metadata.retry_context).toBeUndefined();
			expect(result.toon).not.toContain("retry_context:");
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Unit 2.6: TOON multi-hop inheritance
// ────────────────────────────────────────────────────────────────────

function makeToonCompactContext(toonBlock: string): string {
	return `# Conversation Context\n\n## User\n\n${toonBlock}\n\n## Assistant\n\nI will work on this.`;
}

function makeParentToon(envelopeId: string, repoRoot: string, workflowMode = "plan_linked"): string {
	return [
		"delegation:",
		'  contract_version: "omp-delegation/v1"',
		"  envelope:",
		`    id: ${JSON.stringify(envelopeId)}`,
		'    created_at: "2026-03-19T00:00:00.000Z"',
		"  input_policy:",
		'    mode: "detailed"',
		"  context:",
		`    repo_root: ${JSON.stringify(repoRoot)}`,
		`    workflow_mode: ${JSON.stringify(workflowMode)}`,
		"  roles:",
		'    delegator: "orchestrator"',
		'    delegate: "implement"',
		"  task:",
		'    id: "parent-task"',
		'    title: "Parent task"',
		'    description: "Parent delegation work"',
		"    constraints[0]:",
		"    acceptance_criteria[0]:",
	].join("\n");
}

describe("TOON multi-hop inheritance", () => {
	it("parses parent TOON from compact context and links envelope via parent_envelope_id", async () => {
		await withTempDir(async cwd => {
			const parentEnvelopeId = "del_parent_abc123def";
			const parentToon = makeParentToon(parentEnvelopeId, cwd);
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeToonCompactContext(parentToon),
				}),
				delegate: "lint",
				task: createSemanticTask(),
			});
			expect(result.metadata.envelope.parent_envelope_id).toBe(parentEnvelopeId);
			expect(result.metadata.context.repo_root).toBe(cwd);
		});
	});

	it("inherits workflow_mode from parent TOON context", async () => {
		await withTempDir(async cwd => {
			const parentToon = makeParentToon("del_xyz_hop_789abc", cwd, "plan_linked");
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => parentToon,
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			expect(result.metadata.context.workflow_mode).toBe("plan_linked");
			expect(result.metadata.envelope.parent_envelope_id).toBe("del_xyz_hop_789abc");
		});
	});

	it("uses last delegation block when multiple TOON blocks appear in compact context", async () => {
		await withTempDir(async cwd => {
			const firstToon = makeParentToon("del_first_000aaa111", cwd);
			const secondToon = makeParentToon("del_second_bbb222cc", cwd);
			const compactContext = `${firstToon}\n\n## Assistant\n\nHandled.\n\n## User\n\n${secondToon}`;
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => compactContext,
				}),
				delegate: "code-reviewer",
				task: createSemanticTask(),
			});
			// Should use the last TOON block's envelope id
			expect(result.metadata.envelope.parent_envelope_id).toBe("del_second_bbb222cc");
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Unit 2.6: late plan binding and ask/default delegation modes
// ────────────────────────────────────────────────────────────────────

describe("late plan binding", () => {
	it("resolves plan path from active plan-mode session state when compact context has no plan", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath } = await createPlanFixtureSet(cwd);
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeImplementationContext(cwd),
					getPlanModeState: () => ({ enabled: true, planFilePath: richPlanPath }) as any,
				}),
				delegate: "implement",
				task: createSemanticTask(),
			});
			expect(result.metadata.context.plan_path).toBe(richPlanPath);
			// With a rich plan, intent should be populated from plan Goals section
			expect(result.metadata.task.intent).toBeTruthy();
		});
	});

	it("plan path in compact context takes precedence over session state", async () => {
		await withTempDir(async cwd => {
			const { richPlanPath, barePlanPath } = await createPlanFixtureSet(cwd);
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makePlanContext(cwd, richPlanPath),
					getPlanModeState: () => ({ enabled: true, planFilePath: barePlanPath }) as any,
				}),
				delegate: "implement",
				task: createSemanticTask(),
			});
			// Compact context wins
			expect(result.metadata.context.plan_path).toBe(richPlanPath);
		});
	});
});

describe("ask and default delegation modes", () => {
	it("sets workflow_mode to ask when runtime role is ask", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => "",
					getRuntimeRole: () => "ask",
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			expect(result.metadata.context.workflow_mode).toBe("ask");
			expect(result.metadata.roles.delegator).toBe("ask");
		});
	});

	it("sets workflow_mode to default when runtime role is default", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => "",
					getRuntimeRole: () => "default",
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			expect(result.metadata.context.workflow_mode).toBe("default");
			expect(result.metadata.roles.delegator).toBe("default");
		});
	});

	it("ask mode overrides inherited workflow_mode from parent context", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => makeImplementationContext(cwd, { workflow_mode: "plan_linked" }),
					getRuntimeRole: () => "ask",
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			// ask runtime role takes precedence over inherited plan_linked
			expect(result.metadata.context.workflow_mode).toBe("ask");
		});
	});
});

// ────────────────────────────────────────────────────────────────────
// Coverage extensions: output_contract, debug profile, task fields,
// linter gaps, and mixed inheritance precedence
// ────────────────────────────────────────────────────────────────────

describe("output contract serialization", () => {
	it("includes output_contract in TOON and metadata when provided", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const contract = {
				schema: { type: "object", properties: { verdict: { type: "string" } } },
				required_fields: ["verdict", "reason"],
			};
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask(),
				options: { outputContract: contract },
			});
			expect(result.metadata.output_contract).toMatchObject(contract);
			expect(result.toon).toContain("output_contract:");
			expect(result.toon).toContain('type: "object"');
		});
	});

	it("omits output_contract when not provided", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				task: createSemanticTask(),
			});
			expect(result.metadata.output_contract).toBeUndefined();
			expect(result.toon).not.toContain("output_contract:");
		});
	});
});

describe("debug delegate profile default", () => {
	it("defaults to detailed profile for debug delegate", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd),
				delegate: "debug",
				task: createSemanticTask(),
			});
			expect(result.metadata.input_policy.mode).toBe("detailed");
		});
	});
});

describe("task summary and blockers propagation", () => {
	it("includes summary and blockers in TOON when provided", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd),
				delegate: "implement",
				task: createSemanticTask({
					summary: "Compact summary of the task.",
					blockers: ["Waiting on upstream schema", "API rate limit"],
				}),
			});
			expect(result.metadata.task.summary).toBe("Compact summary of the task.");
			expect(result.metadata.task.blockers).toEqual(["Waiting on upstream schema", "API rate limit"]);
			expect(result.toon).toContain('summary: "Compact summary of the task."');
			expect(result.toon).toContain("blockers");
		});
	});

	it("omits summary and blockers when not provided", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd),
				delegate: "lint",
				task: createSemanticTask(),
			});
			expect(result.metadata.task.summary).toBeUndefined();
			expect(result.metadata.task.blockers).toBeUndefined();
			expect(result.toon).not.toContain("summary:");
			expect(result.toon).not.toContain("blockers");
		});
	});

	it("normalizes whitespace in summary and blockers", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd),
				delegate: "implement",
				task: createSemanticTask({
					summary: "  Padded summary  ",
					blockers: ["  Leading spaces  ", "\tTabbed blocker\t"],
				}),
			});
			expect(result.metadata.task.summary).toBe("Padded summary");
			expect(result.metadata.task.blockers).toEqual(["Leading spaces", "Tabbed blocker"]);
		});
	});
});

describe("delegation quality linter - extended coverage", () => {
	it("warns when plan_path exists but plan_excerpt extraction failed for detailed profile", async () => {
		await withTempDir(async cwd => {
			// Create a bare plan that has no 'Plan Excerpt' section
			const { barePlanPath } = await createPlanFixtureSet(cwd);
			const result = await buildDelegation({
				cwd,
				compactContext: makePlanContext(cwd, barePlanPath),
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("plan_excerpt extraction failed"))).toBe(true);
		});
	});

	it("warns when output_contract is missing for implement delegate in non-minimal mode", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				delegate: "implement",
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("output_contract missing for implement delegate"))).toBe(true);
		});
	});

	it("does not warn about output_contract for non-implement delegates", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				delegate: "explore",
				profile: "standard",
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("output_contract missing"))).toBe(false);
		});
	});

	it("does not warn about output_contract for implement in minimal mode", async () => {
		await withTempDir(async cwd => {
			const result = await buildDelegation({
				cwd,
				compactContext: makeImplementationContext(cwd),
				delegate: "implement",
				profile: "minimal",
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("output_contract missing"))).toBe(false);
		});
	});

	it("suppresses output_contract warning when contract is provided", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask(),
				options: { outputContract: { schema: {} } },
			});
			const warnings = result.quality_report?.warnings ?? [];
			expect(warnings.some(w => w.includes("output_contract missing"))).toBe(false);
		});
	});

	it("skips file existence check for local:// plan paths", async () => {
		await withTempDir(async cwd => {
			// local:// plan paths should not produce a file-not-found error
			const result = await buildDelegation({
				cwd,
				compactContext: makeDelegationContext({
					repository_cwd: cwd,
					workflow_mode: "plan_linked",
					repo_root: cwd,
					plan_file_path: "local://my-plan/plan.md",
				}),
			});
			const errors = result.quality_report?.errors ?? [];
			expect(errors.some(e => e.includes("file does not exist"))).toBe(false);
		});
	});
});

describe("mixed TOON and legacy inheritance precedence", () => {
	it("TOON fields override legacy XML for overlapping context fields", async () => {
		await withTempDir(async cwd => {
			// Build a compact context with both legacy XML and TOON block
			const legacyBlock = makeDelegationContext({
				repository_cwd: "/legacy/workspace",
				workflow_mode: "legacy_mode",
				repo_root: "/legacy/repo",
			});
			const toonBlock = makeParentToon("del_toon_parent_999", "/toon/repo", "plan_linked");
			const combined = `${legacyBlock}\n\n## Assistant\n\nProcessing.\n\n## User\n\n${toonBlock}`;
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => combined,
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			// TOON overrides legacy for context fields present in both parsers
			expect(result.metadata.context.workflow_mode).toBe("plan_linked");
			expect(result.metadata.context.repo_root).toBe("/toon/repo");
			// The parent TOON envelope.id becomes the fallback parent_envelope_id
			expect(result.metadata.envelope.parent_envelope_id).toBe("del_toon_parent_999");
		});
	});

	it("falls back to legacy XML when TOON block is absent", async () => {
		await withTempDir(async cwd => {
			const legacyContext = makeDelegationContext({
				repository_cwd: "/legacy/workspace",
				repo_root: "/legacy/repo",
				workflow_mode: "plan_linked",
				parent_envelope_id: "del_legacy_only",
			});
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => legacyContext,
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			expect(result.metadata.envelope.parent_envelope_id).toBe("del_legacy_only");
			expect(result.metadata.context.workflow_mode).toBe("plan_linked");
		});
	});
});

describe("TOON parser edge cases", () => {
	it("handles empty compact context gracefully", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => "" }),
				delegate: "lint",
				task: createSemanticTask(),
			});
			// Should produce a valid TOON without any inherited context
			expect(result.validation_passed).toBe(true);
			expect(result.metadata.envelope.parent_envelope_id).toBeUndefined();
		});
	});

	it("handles compact context with no TOON or legacy block", async () => {
		await withTempDir(async cwd => {
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => "## User\n\nHello world\n\n## Assistant\n\nI will help.",
				}),
				delegate: "lint",
				task: createSemanticTask(),
			});
			expect(result.validation_passed).toBe(true);
			expect(result.metadata.envelope.parent_envelope_id).toBeUndefined();
		});
	});

	it("parses TOON block with plan_path and plan_workspace_dir", async () => {
		await withTempDir(async cwd => {
			const planPath = "/repo/.omp/sessions/plans/my-plan/plan.md";
			const planWorkspaceDir = "/repo/.omp/sessions/plans/my-plan";
			const parentToon = [
				"delegation:",
				'  contract_version: "omp-delegation/v1"',
				"  envelope:",
				'    id: "del_plan_context_abc"',
				'    created_at: "2026-03-19T00:00:00.000Z"',
				"  context:",
				`    repo_root: ${JSON.stringify(cwd)}`,
				`    plan_path: ${JSON.stringify(planPath)}`,
				`    plan_workspace_dir: ${JSON.stringify(planWorkspaceDir)}`,
				'    workflow_mode: "plan_linked"',
				"  roles:",
				'    delegator: "orchestrator"',
				'    delegate: "implement"',
				"  task:",
				'    id: "test"',
				'    title: "Test"',
				'    description: "Test"',
			].join("\n");
			const result = await buildToonDelegation({
				session: createSession(cwd, {
					getCompactContext: () => parentToon,
				}),
				delegate: "explore",
				task: createSemanticTask(),
				options: { profile: "standard" },
			});
			// plan_path and plan_workspace_dir should be inherited from parent TOON
			expect(result.metadata.context.plan_path).toBe(planPath);
			expect(result.metadata.context.plan_workspace_dir).toBe(planWorkspaceDir);
		});
	});
});

describe("TOON rendering field ordering", () => {
	it("renders root-level sections in canonical order", async () => {
		await withTempDir(async cwd => {
			const builderModule = await loadBuilderModule();
			const result = await builderModule.buildToonDelegation({
				session: createSession(cwd, { getCompactContext: () => makeImplementationContext(cwd) }),
				delegate: "implement",
				task: createSemanticTask(),
				options: {
					outputContract: { schema: {} },
					retryContext: { attempt: 1 },
				},
			});
			const toon = result.toon;
			const sectionPositions = [
				toon.indexOf("contract_version:"),
				toon.indexOf("envelope:"),
				toon.indexOf("input_policy:"),
				toon.indexOf("context:"),
				toon.indexOf("\n  roles:"),
				toon.indexOf("\n  task:"),
				toon.indexOf("retry_context:"),
				toon.indexOf("output_contract:"),
			];
			// Every expected section must be present
			for (const pos of sectionPositions) {
				expect(pos).toBeGreaterThan(-1);
			}
			// Sections must appear in ascending order
			for (let i = 1; i < sectionPositions.length; i++) {
				expect(sectionPositions[i]!).toBeGreaterThan(sectionPositions[i - 1]!);
			}
		});
	});
});

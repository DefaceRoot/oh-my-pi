import { describe, expect, test } from "bun:test";
import {
	applyScopedFileMetadataToTaskInput,
	buildImplementationUnitFileScopes,
	collectTaskUnitsFromTaskInput,
	computeFilesDelta,
	createImplementationTaskScopeMetadata,
	createImplementationWorkerGateState,
	evaluateImplementationWorkerGateTaskResult,
	getImplementationWorkerSubmitDecision,
	isImplementationWorkerPrompt,
	parseGitStatusSnapshot,
	recordImplementationWorkerGateOutcome,
	rewriteCodeRabbitTaskInput,
} from "./task-file-tracker";

describe("parseGitStatusSnapshot", () => {
	test("parses porcelain output into file set", () => {
		const output = " M src/foo.ts\n M src/bar.ts\n?? new-file.ts\n";
		const result = parseGitStatusSnapshot(output);
		expect(result).toEqual(new Set(["src/foo.ts", "src/bar.ts", "new-file.ts"]));
	});

	test("handles renamed files (both old and new paths)", () => {
		const output = "R  old-name.ts -> new-name.ts\n";
		const result = parseGitStatusSnapshot(output);
		expect(result.has("old-name.ts")).toBe(true);
		expect(result.has("new-name.ts")).toBe(true);
	});

	test("handles empty output", () => {
		expect(parseGitStatusSnapshot("")).toEqual(new Set());
	});

	test("handles added, modified, deleted statuses", () => {
		const output = "A  added.ts\nM  modified.ts\nD  deleted.ts\n";
		const result = parseGitStatusSnapshot(output);
		expect(result).toEqual(new Set(["added.ts", "modified.ts", "deleted.ts"]));
	});

	test("trims whitespace from paths", () => {
		const output = " M  src/foo.ts \n";
		const result = parseGitStatusSnapshot(output);
		expect(result.has("src/foo.ts")).toBe(true);
	});
});

describe("computeFilesDelta", () => {
	test("returns files in after but not in before", () => {
		const before = new Set(["existing.ts"]);
		const after = new Set(["existing.ts", "new.ts", "another.ts"]);
		expect(computeFilesDelta(before, after)).toEqual(
			new Set(["new.ts", "another.ts"]),
		);
	});

	test("returns empty set when no new files", () => {
		const before = new Set(["a.ts", "b.ts"]);
		const after = new Set(["a.ts", "b.ts"]);
		expect(computeFilesDelta(before, after)).toEqual(new Set());
	});

	test("handles empty before set", () => {
		const after = new Set(["a.ts"]);
		expect(computeFilesDelta(new Set(), after)).toEqual(new Set(["a.ts"]));
	});

	test("handles empty after set", () => {
		const before = new Set(["a.ts"]);
		expect(computeFilesDelta(before, new Set())).toEqual(new Set());
	});
});

describe("task unit scope metadata", () => {
	test("collects task units from task input payload", () => {
		const units = collectTaskUnitsFromTaskInput({
			tasks: [
				{
					id: "UnitAlpha",
					description: "Update orchestrator metadata wiring",
					assignment: "## Target\n- Files: `agent/extensions/implementation-engine/index.ts`",
				},
			],
		});

		expect(units).toEqual([
			{
				id: "UnitAlpha",
				description: "Update orchestrator metadata wiring",
				assignment: "## Target\n- Files: `agent/extensions/implementation-engine/index.ts`",
			},
		]);
	});

	test("maps renamed and generated files to the owning implementation unit", () => {
		const units = [
			{
				id: "UIRefactor",
				assignment: "## Target\n- Files: `src/ui/old-panel.tsx -> src/ui/new-panel.tsx`",
			},
			{
				id: "ApiCleanup",
				assignment: "## Target\n- Files: `src/api/client.ts`",
			},
		];

		const scopes = buildImplementationUnitFileScopes(
			units,
			new Set([
				"src/ui/old-panel.tsx",
				"src/ui/new-panel.tsx",
				"src/ui/new-panel.generated.ts",
				"src/api/client.ts",
			]),
		);

		expect(scopes.get("UIRefactor")).toEqual(
			new Set([
				"src/ui/old-panel.tsx",
				"src/ui/new-panel.tsx",
				"src/ui/new-panel.generated.ts",
			]),
		);
		expect(scopes.get("ApiCleanup")).toEqual(new Set(["src/api/client.ts"]));
	});

	test("injects authoritative edited-file metadata into task assignments", () => {
		const input = {
			agent: "verifier",
			tasks: [
				{
					id: "UIRefactor",
					description: "Verify updated panel",
					assignment: "Verify refactor completion.",
				},
			],
		};

		const didMutate = applyScopedFileMetadataToTaskInput({
			input,
			scopeByUnitId: new Map([
				["UIRefactor", new Set(["src/ui/new-panel.tsx", "src/ui/new-panel.generated.ts"])],
			]),
		});

		expect(didMutate).toBe(true);
		expect(input.tasks[0]?.assignment).toContain("<edited_file_scope_metadata>");
		expect(input.tasks[0]?.assignment).toContain("Implementation unit id: `UIRefactor`");
		expect(input.tasks[0]?.assignment).toContain("`src/ui/new-panel.tsx`");
	});

	test("uses fallback scope when only one task unit exists", () => {
		const input = {
			agent: "code-reviewer",
			tasks: [
				{
					id: "UnitSolo",
					assignment: "Review implementation output.",
				},
			],
		};

		const didMutate = applyScopedFileMetadataToTaskInput({
			input,
			scopeByUnitId: new Map(),
			fallbackScope: new Set(["src/feature/entry.ts", "src/feature/generated.ts"]),
		});

		expect(didMutate).toBe(true);
		expect(input.tasks[0]?.assignment).toContain("<edited_file_scope_metadata>");
		expect(input.tasks[0]?.assignment).toContain("`src/feature/entry.ts`");
		expect(input.tasks[0]?.assignment).toContain("`src/feature/generated.ts`");
	});

	test("does not leak fallback scope across multiple task units", () => {
		const input = {
			agent: "verifier",
			tasks: [
				{ id: "UnitOne", assignment: "Verify unit one." },
				{ id: "UnitTwo", assignment: "Verify unit two." },
			],
		};


		const didMutate = applyScopedFileMetadataToTaskInput({
			input,
			scopeByUnitId: new Map(),
			fallbackScope: new Set(["src/unrelated.ts"]),
		});


		expect(didMutate).toBe(false);
		expect(input.tasks[0]?.assignment).not.toContain("<edited_file_scope_metadata>");
		expect(input.tasks[1]?.assignment).not.toContain("<edited_file_scope_metadata>");
	});


	test("rewrites coderabbit tasks to CLI-only handoff with authoritative scope", () => {
		const input = {
			agent: "coderabbit",
			context: [
				"## Goal",	
				"Independent phase-end review for a completed implementation slice.",
				"## Constraints",	
				"- Repository: `/tmp/worktree`.",
				"- Review the implemented slices for correctness, regressions, and plan adherence.",
			].join("\n"),
			tasks: [
				{
					id: "CodeRabbitMonocleOverhaul",
					assignment: [
						"## Target",
						"Review the files changed for this implementation slice.",
						"",
						"## Check",
						"1. Review the completed implementation against the approved plan.",
						"2. Identify any correctness issues, regressions, or missing required updates.",
					].join("\n"),
				},
			],
		};


		const didMutate = rewriteCodeRabbitTaskInput({
			input,
			scopeByUnitId: new Map(),
			fallbackScope: new Set([
				"dashboards/monocle-monitor.json",
				"tests/test_monitor_dashboard.py",
			]),
			baseBranch: "main",
			worktreePath: "/tmp/worktree",
		});


		expect(didMutate).toBe(true);
		expect(input.context).toContain("Run CodeRabbit CLI only");
		expect(input.context).toContain("`/tmp/worktree`");
		expect(input.context).toContain("`--base main`");
		expect(input.tasks[0]?.assignment).toContain("Do not perform manual review");
		expect(input.tasks[0]?.assignment).toContain("`dashboards/monocle-monitor.json`");
		expect(input.tasks[0]?.assignment).not.toContain("Review the completed implementation against the approved plan");
	});


	test("rewrites coderabbit tasks to report blocked handoff when required scope metadata is missing", () => {
		const input = {
			agent: "coderabbit",
			tasks: [
				{ id: "CodeRabbitBlocked", assignment: "Review the implementation and report findings." },
			],
		};


		const didMutate = rewriteCodeRabbitTaskInput({
			input,
			scopeByUnitId: new Map(),
		});


		expect(didMutate).toBe(true);
		expect(input.context).toContain("Parent handoff is incomplete");
		expect(input.tasks[0]?.assignment).toContain("Return `verdict: \"no_go\"`");
		expect(input.tasks[0]?.assignment).toContain("Do not inspect repository files manually");
	});


	test("creates phase-end metadata with per-unit scopes and coderrabbit context", () => {
		const metadata = createImplementationTaskScopeMetadata({
			agent: "implement",
			units: [
				{
					id: "UIRefactor",
					assignment: "## Target\n- Files: `src/ui/new-panel.tsx`",
				},
			],
			changedFiles: new Set(["src/ui/new-panel.tsx", "src/ui/new-panel.generated.ts"]),
			baseBranch: "main",
			worktreePath: "/tmp/worktree",
		});

		expect(metadata.agent).toBe("implement");
		expect(metadata.units).toEqual([
			{
				unitId: "UIRefactor",
				declaredFileHints: ["src/ui/new-panel.tsx"],
				editedFiles: ["src/ui/new-panel.generated.ts", "src/ui/new-panel.tsx"],
			},
		]);
		expect(metadata.codeRabbit).toEqual({
			baseBranch: "main",
			worktreePath: "/tmp/worktree",
			editedFiles: ["src/ui/new-panel.generated.ts", "src/ui/new-panel.tsx"],
		});
	});
});


describe("isImplementationWorkerPrompt", () => {
	test("identifies implementation worker system prompt markers", () => {
		expect(
			isImplementationWorkerPrompt(
				"<role>Implementation subagent for delegated coding work with optional explore-agent fan-out.</role>",
				"",
			),
		).toBe(true);
	});

	test("does not match unrelated subagent prompts", () => {
		expect(
			isImplementationWorkerPrompt(
				"<role>Verifier subagent for delegated coding work.</role>",
				"",
			),
		).toBe(false);
	});
});

describe("evaluateImplementationWorkerGateTaskResult", () => {
	test("rejects missing structured submit_result payload", () => {
		const outcome = evaluateImplementationWorkerGateTaskResult(
			{
				isError: false,
				details: {
					results: [
						{
							exitCode: 0,
							aborted: false,
							extractedToolData: {},
						},
					],
				},
			},
			"lint",
		);

		expect(outcome.success).toBe(false);
		expect(outcome.reason).toContain("missing structured submit_result payload");
	});

	test("rejects lint payloads where checks did not pass", () => {
		const outcome = evaluateImplementationWorkerGateTaskResult(
			{
				isError: false,
				details: {
					results: [
						{
							exitCode: 0,
							aborted: false,
							extractedToolData: {
								submit_result: [{ status: "success", data: { passed: false } }],
							},
						},
					],
				},
			},
			"lint",
		);

		expect(outcome.success).toBe(false);
		expect(outcome.reason).toContain("lint output indicates checks did not pass");
	});

	test("rejects code-reviewer payloads with no_go verdict", () => {
		const outcome = evaluateImplementationWorkerGateTaskResult(
			{
				isError: false,
				details: {
					results: [
						{
							exitCode: 0,
							aborted: false,
							extractedToolData: {
								submit_result: [{ status: "success", data: { verdict: "no_go" } }],
							},
						},
					],
				},
			},
			"code-reviewer",
		);

		expect(outcome.success).toBe(false);
		expect(outcome.reason).toContain("code-reviewer output verdict is not go");
	});

	test("rejects commit payloads where push/commit failed", () => {
		const outcome = evaluateImplementationWorkerGateTaskResult(
			{
				isError: false,
				details: {
					results: [
						{
							exitCode: 0,
							aborted: false,
							extractedToolData: {
								submit_result: [{ status: "success", data: { success: false } }],
							},
						},
					],
				},
			},
			"commit",
		);

		expect(outcome.success).toBe(false);
		expect(outcome.reason).toContain("commit output indicates commit/push did not succeed");
	});

	test("accepts successful structured submit_result payload for the stage", () => {
		const outcome = evaluateImplementationWorkerGateTaskResult(
			{
				isError: false,
				details: {
					results: [
						{
							exitCode: 0,
							aborted: false,
							extractedToolData: {
								submit_result: [{ status: "success", data: { success: true } }],
							},
						},
					],
				},
			},
			"commit",
		);

		expect(outcome).toEqual({ success: true });
	});
});

describe("implementation worker submit gate", () => {
	test("blocks submit_result until lint, review, and commit succeed in order", () => {
		let state = createImplementationWorkerGateState();
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(false);

		state = recordImplementationWorkerGateOutcome(state, "lint", { success: true });
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(false);

		state = recordImplementationWorkerGateOutcome(state, "code-reviewer", {
			success: true,
		});
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(false);

		state = recordImplementationWorkerGateOutcome(state, "commit", { success: true });
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(true);
	});

	test("allows submit_result after retry path ends with successful final sequence", () => {
		let state = createImplementationWorkerGateState();

		state = recordImplementationWorkerGateOutcome(state, "lint", {
			success: false,
			reason: "lint failed",
		});
		state = recordImplementationWorkerGateOutcome(state, "lint", { success: true });

		state = recordImplementationWorkerGateOutcome(state, "code-reviewer", {
			success: false,
			reason: "review findings",
		});
		state = recordImplementationWorkerGateOutcome(state, "commit", { success: true });
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(false);

		state = recordImplementationWorkerGateOutcome(state, "code-reviewer", {
			success: true,
		});
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(false);

		state = recordImplementationWorkerGateOutcome(state, "commit", { success: true });
		expect(getImplementationWorkerSubmitDecision(state).allowed).toBe(true);
	});
});
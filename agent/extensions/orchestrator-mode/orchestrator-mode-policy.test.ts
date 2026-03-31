import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _testExports } from "./index.ts";

type PolicyContext = ReturnType<(typeof _testExports)["isOrchestratorContext"]>;

const parentOrchestratorContext = (): PolicyContext =>
	_testExports.isOrchestratorContext({
		role: "orchestrator",
		promptText: "Please coordinate this fix",
		hasUI: true,
		sessionFile: "/home/colin/.omp/agent/sessions/-repo/2026-03-07T00-00-00-000Z_abcdef12.jsonl",
	});

const defaultContext = (): PolicyContext =>
	_testExports.isOrchestratorContext({
		role: "default",
		promptText: "Please coordinate this fix",
		hasUI: true,
		sessionFile: "/home/colin/.omp/agent/sessions/-repo/2026-03-07T00-00-00-000Z_abcdef12.jsonl",
	});

const nestedTaskContext = (): PolicyContext =>
	_testExports.isOrchestratorContext({
		role: "orchestrator",
		promptText: "Please coordinate this fix",
		hasUI: true,
		sessionFile:
			"/home/colin/.omp/agent/sessions/-repo/2026-03-07T00-00-00-000Z_abcdef12/0-UnitAlpha.jsonl",
	});

const assignmentPromptContext = (): PolicyContext =>
	_testExports.isOrchestratorContext({
		role: "orchestrator",
		promptText: "Your assignment is below.",
		hasUI: true,
		sessionFile: "/home/colin/.omp/agent/sessions/-repo/2026-03-07T00-00-00-000Z_abcdef12.jsonl",
	});

const handoffPromptContext = (): PolicyContext =>
	_testExports.isOrchestratorContext({
		role: "orchestrator",
		promptText:
			"Write a comprehensive handoff document that will allow another instance to continue this work without losing context.",
		hasUI: true,
		sessionFile: "/home/colin/.omp/agent/sessions/-repo/2026-03-07T00-00-00-000Z_abcdef12.jsonl",
	});

const emptyTodoContext = () => ({
	...parentOrchestratorContext(),
	todoBootstrapRequired: true,
	todoRefreshRequired: false,
	todoDeficiencyReason: "Create at least 2 named phases.",
});

const staleTodoContext = () => ({
	...parentOrchestratorContext(),
	todoBootstrapRequired: false,
	todoRefreshRequired: true,
});

const decisionFor = (context: Record<string, unknown>, toolName: string, input?: Record<string, unknown>) =>
	_testExports.shouldBlockTool(
		{
			toolName,
			input,
		},
		context as never,
	);

const expectBlocked = (context: Record<string, unknown>, toolName: string, input?: Record<string, unknown>) => {
	const decision = decisionFor(context, toolName, input);
	expect(decision?.block).toBe(true);
};

const expectAllowed = (context: Record<string, unknown>, toolName: string, input?: Record<string, unknown>) => {
	const decision = decisionFor(context, toolName, input);
	expect(decision).toBeUndefined();
};

const shouldRequireTodoRefreshAfterResult = (event: Record<string, unknown>) =>
	(
		_testExports as {
			shouldRequireTodoRefreshAfterResult?: (event: Record<string, unknown>) => boolean;
		}
	).shouldRequireTodoRefreshAfterResult?.(event);

describe("orchestrator-mode todo refresh triggers", () => {
	it("does not require a todo refresh after launching background task jobs", () => {
		expect(
			shouldRequireTodoRefreshAfterResult({
				toolName: "task",
				details: {
					results: [],
					async: { state: "running", jobId: "job-1", type: "task" },
				},
			}),
		).toBe(false);
	});

	it("requires a todo refresh after a synchronous task result", () => {
		expect(
			shouldRequireTodoRefreshAfterResult({
				toolName: "task",
				details: {
					results: [{ id: "result-1" }],
					totalDurationMs: 10,
				},
			}),
		).toBe(true);
	});

	it("requires a todo refresh after an async task batch completes", () => {
		expect(
			shouldRequireTodoRefreshAfterResult({
				toolName: "task",
				details: {
					results: [],
					async: { state: "completed", jobId: "job-1", type: "task" },
				},
			}),
		).toBe(true);
	});

	it("does not require a todo refresh after an await timeout with only running jobs", () => {
		expect(
			shouldRequireTodoRefreshAfterResult({
				toolName: "await",
				details: {
					jobs: [
						{ id: "job-1", type: "task", status: "running", label: "Designer", durationMs: 30_000 },
					],
				},
			}),
		).toBe(false);
	});

	it("requires a todo refresh after await observes completed work", () => {
		expect(
			shouldRequireTodoRefreshAfterResult({
				toolName: "await",
				details: {
					jobs: [
						{ id: "job-1", type: "task", status: "completed", label: "Designer", durationMs: 35_000 },
					],
				},
			}),
		).toBe(true);
	});
});

describe("orchestrator-mode policy", () => {
	it("detects parent orchestrator turns", () => {
		expect(parentOrchestratorContext().orchestratorModeThisTurn).toBe(true);
		expect(parentOrchestratorContext().activeAgentIsParentTurn).toBe(true);
	});

	it("ignores default role turns", () => {
		expect(defaultContext().orchestratorModeThisTurn).toBe(false);
	});

	it("ignores nested task sessions", () => {
		expect(nestedTaskContext().orchestratorModeThisTurn).toBe(false);
		expect(nestedTaskContext().activeAgentIsParentTurn).toBe(false);
	});

	it("ignores explicit delegated assignment prompts", () => {
		expect(assignmentPromptContext().orchestratorModeThisTurn).toBe(false);
		expect(assignmentPromptContext().activeAgentIsParentTurn).toBe(false);
	});

	it("ignores native handoff prompts", () => {
		expect(handoffPromptContext().orchestratorModeThisTurn).toBe(false);
		expect(handoffPromptContext().activeAgentIsParentTurn).toBe(false);
	});

	it("blocks edit tool", () => {
		expectBlocked(parentOrchestratorContext(), "edit");
	});

	it("blocks write tool", () => {
		expectBlocked(parentOrchestratorContext(), "write");
	});

	it("allows notebook tool from the orchestrator role config", () => {
		expectAllowed(parentOrchestratorContext(), "notebook");
	});

	it("blocks grep tool", () => {
		expectBlocked(parentOrchestratorContext(), "grep");
	});

	it("blocks find tool from the orchestrator role config", () => {
		expectBlocked(parentOrchestratorContext(), "find");
	});

	it("blocks lsp tool", () => {
		expectBlocked(parentOrchestratorContext(), "lsp", { action: "hover" });
	});

	it("blocks non-allowlisted MCP tools", () => {
		expectBlocked(parentOrchestratorContext(), "mcp_chrome_devtools_take_snapshot");
	});

	it("still blocks task while allowing read to gather todo context", () => {
		expectBlocked(emptyTodoContext(), "task", { agent: "implement" });
		expectAllowed(emptyTodoContext(), "read", { path: "agent/AGENTS.md" });
		expectAllowed(emptyTodoContext(), "todo_write");
	});

	it("allows await while todo bootstrap is required so running subagents can finish", () => {
		expectAllowed(emptyTodoContext(), "await");
	});

	it("blocks everything except todo_write, await, and agent:// reads when todo refresh is required", () => {
		expectBlocked(staleTodoContext(), "task", { agent: "implement" });
		expectBlocked(staleTodoContext(), "ask");
		expectBlocked(staleTodoContext(), "read", { path: "agent/AGENTS.md" });
		expectAllowed(staleTodoContext(), "read", { path: "agent://del_abc/output" });
		expectAllowed(staleTodoContext(), "todo_write");
		expectAllowed(staleTodoContext(), "await");
	});

	it("allows task tool after a detailed todo exists", () => {
		expectAllowed(parentOrchestratorContext(), "task", { agent: "implement" });
	});

	it("allows ask tool after a detailed todo exists", () => {
		expectAllowed(parentOrchestratorContext(), "ask");
	});

	it("allows await tool after a detailed todo exists", () => {
		expectAllowed(parentOrchestratorContext(), "await");
	});

	it("allows todo_write tool", () => {
		expectAllowed(parentOrchestratorContext(), "todo_write");
	});

	it("allows read tool after a detailed todo exists", () => {
		expectAllowed(parentOrchestratorContext(), "read", { path: "agent/AGENTS.md" });
	});

	it("allows bash tool before command narrowing", () => {
		expectAllowed(parentOrchestratorContext(), "bash", { command: "git status --short" });
	});


	it("reads orchestrator tools and MCP prefixes from roles.yml", () => {
		const rolesPath = path.resolve(import.meta.dir, "..", "..", "roles.yml");
		const access = _testExports.resolveOrchestratorToolAccess?.(rolesPath);
		expect(access?.toolNames.has("notebook")).toBe(true);
		expect(access?.toolNames.has("find")).toBe(false);
		expect(access?.toolNames.has("ast_grep")).toBe(false);
		expect(access?.toolNames.has("bash")).toBe(true);
		expect(access?.mcpPrefixes).toContain("mcp_augment_");
	});

	it("reloads orchestrator access after roles.yml changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-orchestrator-roles-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`roles:\n  orchestrator:\n    tools:\n      - read\n    mcp:\n      - augment\n    skills: all\nsubagents: {}\n`,
			);

			const initialAccess = _testExports.resolveOrchestratorToolAccess?.(rolesPath);
			expect(initialAccess?.toolNames.has("notebook")).toBe(false);

			await fs.writeFile(
				rolesPath,
				`roles:\n  orchestrator:\n    tools:\n      - read\n      - notebook\n    mcp:\n      - augment\n    skills: all\nsubagents: {}\n`,
			);

			const updatedAccess = _testExports.resolveOrchestratorToolAccess?.(rolesPath);
			expect(updatedAccess?.toolNames.has("notebook")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("blocks ast_grep from the orchestrator role config", () => {
		expectBlocked(parentOrchestratorContext(), "ast_grep", { command: "ast_grep query" });
	});

	it("blocks discovery tools when role access is unavailable", () => {
		expectBlocked({ ...parentOrchestratorContext(), orchestratorToolAccess: undefined }, "find");
	});

	it("allows augment MCP retrieval from the orchestrator role config", () => {
		expectAllowed(parentOrchestratorContext(), "mcp_augment_codebase_retrieval");
	});

	it("allows cd-prefixed git status commands when bash fallback applies", () => {
		expect(_testExports.shouldBlockBashCommand?.("git status --short", false)).toBeUndefined();
		expect(_testExports.shouldBlockBashCommand?.("cd /tmp && git status --short", false)).toBeUndefined();
		expect(_testExports.shouldBlockBashCommand?.("git status --short; rm -rf /tmp/x", false)?.block).toBe(true);
		expect(_testExports.shouldBlockBashCommand?.("cd /tmp && git status --short; echo pwned", false)?.block).toBe(true);
		expect(_testExports.shouldBlockBashCommand?.("cd $(touch /tmp/pwned) && git status --short", false)?.block).toBe(true);
		expect(_testExports.shouldBlockBashCommand?.("cd `echo /tmp` && git status --short", false)?.block).toBe(true);
		expect(_testExports.shouldBlockBashCommand?.("echo hi", false)?.block).toBe(true);
	});

	it("allows bash to reach the fallback when the role config omits it", () => {
		const restrictedAccess = { toolNames: new Set(["read"]), mcpPrefixes: [] };
		expect(
			_testExports.shouldBlockTool(
				{ toolName: "bash", input: { command: "git status --short" } },
				{ ...parentOrchestratorContext(), orchestratorToolAccess: restrictedAccess } as never,
				),
		).toBeUndefined();
		expect(_testExports.shouldBlockBashCommand?.("cd /tmp && git status", false)).toBeUndefined();
		expect(_testExports.shouldBlockBashCommand?.("echo hi", false)?.block).toBe(true);
	});

	it("blocks todo_write until Must-Read Skills are read", () => {
		try {
			_testExports.syncAutoSkillTracking?.("session-1", "# Must-Read Skills\n- `skill://toon-delegation`\n");
			expectBlocked(parentOrchestratorContext(), "todo_write");
			expectAllowed(parentOrchestratorContext(), "read", { path: "skill://toon-delegation" });
		} finally {
			_testExports.syncAutoSkillTracking?.(undefined, undefined);
		}
	});

	it("prompt requires immediate orchestration without preamble", () => {
		const prompt = _testExports.buildOrchestratorPrompt();
		expect(prompt).toContain("This role NEVER implements directly, even for tiny requests.");
		expect(prompt).toContain("Skip the preamble. Do not output a numbered execution list before acting.");
		expect(prompt).toContain("create a detailed phased todo list with todo_write");
		expect(prompt).toContain("otherwise only the git status fallback is permitted");
		expect(prompt).toContain("If Must-Read Skills remain unread, read them before calling todo_write.");
		expect(prompt).toContain("Do not keep a shallow todo list.");
		expect(prompt).toContain("After every subagent result or new user instruction, update todo_write before any other orchestration action.");
		expect(prompt).toContain("Never park on indefinite await. Every await call MUST set timeout");
		expect(prompt).toContain("After each await timeout or completion, immediately check whether independent work can be dispatched now.");
		expect(prompt).toContain("Dispatch any ready independent work before issuing another await call.");
		expect(prompt).toContain("Routing decision tree: bug reports, failing tests, and unexpected behavior MUST go to the debug subagent.");
		expect(prompt).toContain("Routing decision tree: known-good scoped code changes go to implement after diagnosis is complete.");
		expect(prompt).toContain("Routing decision tree: direct git-only handoff goes to commit only when no implementation-owned file set is pending.");
		expect(prompt).toContain("Do not delegate lint or code-reviewer directly from the parent turn;");
		expect(prompt).toContain("- debug         : root-cause debugging specialist (diagnose, reproduce, and fix)");
	});
});

describe("orchestrator-mode todo structure helpers", () => {
	it("detects missing todo structure", () => {
		expect(_testExports.getTodoPlanDeficiency([])).toContain("Create at least 2 named phases");
		expect(
			_testExports.getTodoPlanDeficiency([
				{ id: "phase-1", name: "Discovery", tasks: [{ id: "task-1", content: "Inspect scope", status: "pending" }] },
			]),
		).toContain("Create at least 2 named phases");
	});

	it("detects too-few tasks", () => {
		expect(
			_testExports.getTodoPlanDeficiency([
				{ id: "phase-1", name: "Discovery", tasks: [{ id: "task-1", content: "Inspect scope", status: "pending" }] },
				{ id: "phase-2", name: "Delivery", tasks: [{ id: "task-2", content: "Delegate work", status: "pending" }] },
			]),
		).toContain("Expand the todo list");
	});

	it("accepts detailed phased todos", () => {
		expect(
			_testExports.getTodoPlanDeficiency([
				{
					id: "phase-1",
					name: "Discovery",
					tasks: [
						{ id: "task-1", content: "Inspect the new instruction and update the execution shape", status: "completed" },
						{ id: "task-2", content: "Map the files and constraints that the workers need", status: "completed" },
					],
				},
				{
					id: "phase-2",
					name: "Delivery",
					tasks: [
						{ id: "task-3", content: "Dispatch the implementation worker with explicit acceptance criteria", status: "in_progress" },
					],
				},
			]),
		).toBeUndefined();
	});

	it("reads the latest todo phases from entries", () => {
		const phases = _testExports.getLatestTodoPhasesFromEntries([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo_write",
					isError: false,
					details: {
						phases: [
							{
								id: "phase-1",
								name: "Discovery",
								tasks: [{ id: "task-1", content: "Inspect scope", status: "pending" }],
							},
						],
					},
				},
			},
		]);

		expect(phases).toEqual([
			{
				id: "phase-1",
				name: "Discovery",
				tasks: [{ id: "task-1", content: "Inspect scope", status: "pending", notes: undefined }],
			},
		]);
	});
});


describe("orchestrator-mode context-gathering checkpoint protocol", () => {
	const exploreTaskInput = {
		tasks: [{ agent: "explore", id: "e1", description: "scout", assignment: "explore the codebase" }],
	};
	const researchTaskInput = {
		tasks: [{ agent: "research", id: "r1", description: "research", assignment: "research the API" }],
	};
	const implementTaskInput = {
		tasks: [{ agent: "implement", id: "i1", description: "impl", assignment: "implement the feature" }],
	};
	const debugTaskInput = {
		tasks: [{ agent: "debug", id: "d1", description: "debug", assignment: "debug the issue" }],
	};
	const verifierTaskInput = {
		tasks: [{ agent: "verifier", id: "v1", description: "verify", assignment: "verify the work" }],
	};

	const contextWithCheckpoint = (): Record<string, unknown> => ({
		...parentOrchestratorContext(),
		checkpointCreatedThisTurn: true,
		rewindRequiredBeforeImplementation: false,
	});

	const contextWithoutCheckpoint = (): Record<string, unknown> => ({
		...parentOrchestratorContext(),
		checkpointCreatedThisTurn: false,
		rewindRequiredBeforeImplementation: false,
	});

	const contextWithRewindRequired = (): Record<string, unknown> => ({
		...parentOrchestratorContext(),
		checkpointCreatedThisTurn: true,
		rewindRequiredBeforeImplementation: true,
	});

	it("blocks explore task dispatch without a prior checkpoint", () => {
		expectBlocked(contextWithoutCheckpoint(), "task", exploreTaskInput);
	});

	it("blocks research task dispatch without a prior checkpoint", () => {
		expectBlocked(contextWithoutCheckpoint(), "task", researchTaskInput);
	});

	it("allows explore task dispatch after checkpoint is created", () => {
		expectAllowed(contextWithCheckpoint(), "task", exploreTaskInput);
	});

	it("allows research task dispatch after checkpoint is created", () => {
		expectAllowed(contextWithCheckpoint(), "task", researchTaskInput);
	});

	it("does not enforce checkpoint gate when todo bootstrap is still required", () => {
		// Bootstrap gate blocks first — checkpoint gate does not fire for explore tasks
		// when the orchestrator hasn't initialized its todo list yet.
		expectBlocked(emptyTodoContext(), "task", exploreTaskInput);
	});

	it("blocks implementation task dispatch when rewind is required after exploration", () => {
		expectBlocked(contextWithRewindRequired(), "task", implementTaskInput);
	});

	it("blocks debug task dispatch when rewind is required after exploration", () => {
		expectBlocked(contextWithRewindRequired(), "task", debugTaskInput);
	});

	it("allows implementation task dispatch when rewind is not required", () => {
		expectAllowed(contextWithCheckpoint(), "task", implementTaskInput);
	});

	it("does not block non-implementation agent types when rewind is required", () => {
		// verifier/coderabbit/commit are not affected by the rewind gate
		expectAllowed(contextWithRewindRequired(), "task", verifierTaskInput);
	});

	it("allows checkpoint tool when todo refresh is required (bypasses refresh gate)", () => {
		expectAllowed(staleTodoContext(), "checkpoint");
	});

	it("allows rewind tool when todo refresh is required (bypasses refresh gate)", () => {
		expectAllowed(staleTodoContext(), "rewind");
	});

	it("detects explore agents in tasks array", () => {
		const { hasExploreAgents } = _testExports as unknown as {
			hasExploreAgents: (input: unknown) => boolean;
		};
		expect(hasExploreAgents(exploreTaskInput)).toBe(true);
		expect(hasExploreAgents(researchTaskInput)).toBe(true);
		expect(hasExploreAgents(implementTaskInput)).toBe(false);
		expect(hasExploreAgents({})).toBe(false);
		expect(hasExploreAgents(null)).toBe(false);
	});

	it("detects implementation agents in tasks array", () => {
		const { hasImplementationAgents } = _testExports as unknown as {
			hasImplementationAgents: (input: unknown) => boolean;
		};
		expect(hasImplementationAgents(implementTaskInput)).toBe(true);
		expect(hasImplementationAgents(debugTaskInput)).toBe(true);
		expect(hasImplementationAgents(exploreTaskInput)).toBe(false);
		expect(hasImplementationAgents(verifierTaskInput)).toBe(false);
		expect(hasImplementationAgents({})).toBe(false);
	});
});
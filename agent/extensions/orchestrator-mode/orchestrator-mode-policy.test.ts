import { describe, expect, it } from "bun:test";
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

	it("blocks notebook tool", () => {
		expectBlocked(parentOrchestratorContext(), "notebook");
	});

	it("blocks grep tool", () => {
		expectBlocked(parentOrchestratorContext(), "grep");
	});

	it("blocks find tool", () => {
		expectBlocked(parentOrchestratorContext(), "find");
	});

	it("blocks lsp tool", () => {
		expectBlocked(parentOrchestratorContext(), "lsp", { action: "hover" });
	});

	it("blocks non-allowlisted MCP tools", () => {
		expectBlocked(parentOrchestratorContext(), "mcp_chrome_devtools_take_snapshot");
	});

	it("blocks task until a detailed todo exists", () => {
		expectBlocked(emptyTodoContext(), "task", { agent: "implement" });
		expectBlocked(emptyTodoContext(), "read", { path: "agent/AGENTS.md" });
		expectAllowed(emptyTodoContext(), "todo_write");
	});

	it("allows await while todo bootstrap is required so running subagents can finish", () => {
		expectAllowed(emptyTodoContext(), "await");
	});

	it("blocks everything except todo_write and await when todo refresh is required", () => {
		expectBlocked(staleTodoContext(), "task", { agent: "implement" });
		expectBlocked(staleTodoContext(), "ask");
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

	it("prompt requires detailed live todo tracking", () => {
		const prompt = _testExports.buildOrchestratorPrompt();
		expect(prompt).toContain("This role NEVER implements directly, even for tiny requests.");
		expect(prompt).toContain("create a detailed phased todo list with todo_write");
		expect(prompt).toContain("Do not keep a shallow todo list.");
		expect(prompt).toContain("After every subagent result or new user instruction, update todo_write before any other orchestration action.");
		expect(prompt).toContain("The only exception is await when background work is already running");
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

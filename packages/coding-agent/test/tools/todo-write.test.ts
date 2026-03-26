import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";
import {
	getLatestTodoPhasesFromEntries,
	TODO_BOOTSTRAP_ENTRY_TYPE,
	withTodoPhasesPreserveData,
} from "../../src/tools/todo-write";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after replace", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [{ content: "status" }, { content: "diagnostics" }],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("task-1 status [in_progress] (Execution)");
		expect(summary.text).toContain("task-2 diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [{ content: "status" }, { content: "diagnostics" }],
						},
					],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", status: "completed" }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("task-2 diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", {
			ops: [{ op: "update", id: "task-2", status: "completed" }],
		});
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (!completedSummary || completedSummary.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});

	it("keeps only one in_progress task when replace input contains multiples", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Execution",
							tasks: [
								{ content: "status", status: "in_progress" },
								{ content: "diagnostics", status: "in_progress" },
							],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});
});

function createMessageEntry(
	id: string,
	message: Record<string, unknown>,
	parentId: string | null = null,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message,
	} as unknown as SessionEntry;
}

function createCompactionEntry(
	id: string,
	preserveData: Record<string, unknown> | undefined,
	parentId: string,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		firstKeptEntryId: parentId,
		tokensBefore: 123,
		preserveData,
	} as unknown as SessionEntry;
}

describe("todo state compaction helpers", () => {
	const phases: TodoPhase[] = [
		{
			id: "phase-1",
			name: "Execution",
			tasks: [{ id: "task-1", content: "keep task", status: "in_progress" }],
		},
	];

	it("restores todo phases from compaction preserve data", () => {
		const entries: SessionEntry[] = [
			createMessageEntry("msg-1", { role: "user", content: "start" }),
			createCompactionEntry("cmp-1", withTodoPhasesPreserveData(undefined, phases), "msg-1"),
		];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(phases);
	});

	it("does not resurrect stale todo state from before compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry("todo-1", {
				role: "toolResult",
				toolName: "todo_write",
				details: { phases },
				content: [{ type: "text", text: "updated todo" }],
			}),
			createCompactionEntry("cmp-1", undefined, "todo-1"),
		];

		expect(getLatestTodoPhasesFromEntries(entries)).toEqual([]);
	});
});

describe("todo bootstrap entries", () => {
	it("reads prepopulated phases when no todo_write result exists yet", () => {
		const phases = getLatestTodoPhasesFromEntries([
			{
				type: "custom",
				id: "bootstrap-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: TODO_BOOTSTRAP_ENTRY_TYPE,
				data: {
					phases: [
						{
							id: "phase-1",
							name: "Phase 1 — Bootstrap",
							tasks: [
								{
									id: "task-1",
									content: "Unit 1.1: Parse headings",
									status: "in_progress",
								},
							],
						},
					],
				},
			},
		]);

		expect(phases).toEqual([
			{
				id: "phase-1",
				name: "Phase 1 — Bootstrap",
				tasks: [
					{
						id: "task-1",
						content: "Unit 1.1: Parse headings",
						status: "in_progress",
						notes: undefined,
					},
				],
			},
		]);
	});
});

describe("TodoWriteTool details field", () => {
	it("preserves details through replace op", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [
								{ content: "Fix parser", details: "Update src/parser.ts line 42" },
								{ content: "Add tests" },
							],
						},
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].details).toBe("Update src/parser.ts line 42");
		expect(tasks[1].details).toBeUndefined();
	});

	it("preserves details through add_task op", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "First" }] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "add_task", phase: "phase-1", content: "Second", details: "Check edge cases" }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[1].details).toBe("Check edge cases");
	});

	it("updates details via update op", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [{ name: "Work", tasks: [{ content: "Fix bug", details: "Old details" }] }],
				},
			],
		});

		const result = await tool.execute("call-2", {
			ops: [{ op: "update", id: "task-1", details: "New details with\nlines" }],
		});

		const task = result.details?.phases[0]?.tasks[0];
		expect(task?.details).toBe("New details with\nlines");
	});

	it("includes details in summary for in_progress tasks", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "replace",
					phases: [
						{
							name: "Work",
							tasks: [{ content: "Fix parser", details: "Edit src/parser.ts" }],
						},
					],
				},
			],
		});

		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		// Task is auto-promoted to in_progress, so details should appear in summary
		expect(summary.text).toContain("Edit src/parser.ts");
	});
});

import { beforeAll, describe, expect, test, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

// ─── Setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
	await initTheme(false);
});

// ─── Minimal mock context ────────────────────────────────────────────────

function createMockContext(): {
	ctx: InteractiveModeContext;
	ingestSpy: ReturnType<typeof vi.fn>;
	refreshSpy: ReturnType<typeof vi.fn>;
} {
	const ingestSpy = vi.fn();
	const refreshSpy = vi.fn();

	const ctx = {
		isInitialized: true,
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map(),
		chatContainer: { addChild: vi.fn() },
		session: {
			subscribe: vi.fn(() => vi.fn()),
			getToolByName: vi.fn(),
			isTtsrAbortPending: false,
			retryAttempt: 0,
		},
		editor: { onEscape: undefined, setText: vi.fn() },
		toolOutputExpanded: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn(), addChild: vi.fn() },
		retryLoader: undefined,
		retryEscapeHandler: undefined,
		autoCompactionEscapeHandler: undefined,
		autoCompactionLoader: undefined,
		hideThinkingBlock: false,
		setTodos: vi.fn(),
		handleExitPlanModeTool: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingModelSwitch: vi.fn(async () => undefined),
		applyPendingWorkingMessage: vi.fn(),
		addMessageToChat: vi.fn(),
		init: vi.fn(async () => undefined),
		ingestTaskToolResult: ingestSpy,
		requestSubagentRefresh: refreshSpy,
	} as unknown as InteractiveModeContext;

	return { ctx, ingestSpy, refreshSpy };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("EventController task result ingestion", () => {
	test("tool_execution_end for task tool calls ctx.ingestTaskToolResult with result details", async () => {
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const mockResults = [
			{
				id: "0-Explore",
				agent: "explore",
				tokens: 1200,
				outputPath: "/tmp/sessions/0-Explore.md",
				task: "## Context\nExplore the codebase",
			},
			{
				id: "1-Research",
				agent: "research",
				tokens: 3400,
				outputPath: "/tmp/sessions/1-Research.md",
				task: "## Context\nResearch best practices",
			},
		];

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_abc123",
			toolName: "task",
			result: {
				details: {
					results: mockResults,
				},
			},
			isError: false,
		};

		await controller.handleEvent(event);

		expect(ingestSpy).toHaveBeenCalledTimes(1);
		expect(ingestSpy).toHaveBeenCalledWith(mockResults);
	});

	test("tool_execution_end for task tool with error does not call ingestTaskToolResult", async () => {
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_err",
			toolName: "task",
			result: {
				details: {
					results: [{ id: "0-Failed", agent: "explore" }],
				},
			},
			isError: true,
		};

		await controller.handleEvent(event);

		expect(ingestSpy).not.toHaveBeenCalled();
	});

	test("tool_execution_end for non-task tool does not call ingestTaskToolResult", async () => {
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_read",
			toolName: "read",
			result: { content: "file content" },
			isError: false,
		};

		await controller.handleEvent(event);

		expect(ingestSpy).not.toHaveBeenCalled();
	});

	test("tool_execution_end for task with missing details does not throw", async () => {
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_empty",
			toolName: "task",
			result: {},
			isError: false,
		};

		// Should not throw
		await controller.handleEvent(event);

		// Should not ingest since no results
		expect(ingestSpy).not.toHaveBeenCalled();
	});

	test("tool_execution_end for task with empty results array does not call ingestTaskToolResult", async () => {
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_nowork",
			toolName: "task",
			result: {
				details: {
					results: [],
				},
			},
			isError: false,
		};

		await controller.handleEvent(event);

		expect(ingestSpy).not.toHaveBeenCalled();
	});

	test("end-to-end: task result ingestion path is typed correctly", async () => {
		// Proves the path: tool_execution_end event → EventController → ctx.ingestTaskToolResult(results)
		// The ctx.ingestTaskToolResult in production wires to SubagentIndex.ingestTaskResults()
		const { ctx, ingestSpy } = createMockContext();
		const controller = new EventController(ctx);

		const taskResults = [
			{
				id: "0-Implement",
				agent: "implement",
				description: "Implement feature X",
				tokens: 8000,
				modelOverride: "claude-sonnet-4-20250514",
				outputPath: "/sessions/0-Implement.md",
				task: "## Target\nImplement the feature",
				durationMs: 12000,
				usage: {
					inputTokens: 5000,
					outputTokens: 3000,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 2000,
				},
				status: "completed",
			},
		];

		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call_impl",
			toolName: "task",
			result: {
				details: { results: taskResults },
			},
			isError: false,
		};

		await controller.handleEvent(event);

		// Verify ingestTaskToolResult was called with the exact results array
		expect(ingestSpy).toHaveBeenCalledTimes(1);
		const passedResults = ingestSpy.mock.calls[0][0];
		expect(passedResults).toBe(taskResults);
		expect(passedResults[0].id).toBe("0-Implement");
		expect(passedResults[0].agent).toBe("implement");
		expect(passedResults[0].tokens).toBe(8000);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import type { AgentDefinition } from "../../src/task/types";

const createAgentSessionMock = mock(async (): Promise<CreateAgentSessionResult> => {
	throw new Error("createAgentSession mock not configured");
});

const sdkMockFactory = () => ({
	createAgentSession: createAgentSessionMock,
	discoverAuthStorage: async () => ({}),
});

mock.module("../../src/sdk", sdkMockFactory);
mock.module("../../src/sdk.ts", sdkMockFactory);

const { runSubprocess } = await import("../../src/task/executor");

function createAssistantMessage(text: string, usage: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage as unknown as AssistantMessage["usage"],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: "test" } },
		model: {
			api: "openai-responses",
			provider: "openai",
			id: "mock",
			contextWindow: 200_000,
			maxTokens: 200_000,
		} as const,
		extensionRunner: undefined,
		sessionId: "mock-session-id",
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "submit_result"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			promptIndex += 1;
			onPrompt({ promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

describe("runSubprocess token usage semantics", () => {
	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-token-usage",
		settings: Settings.isolated(),
		authStorage: {} as unknown as AuthStorage,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [],
		} as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	beforeEach(() => {
		createAgentSessionMock.mockReset();
	});

	test("deduplicates repeated assistant message_end usage for result tokens and usage", async () => {
		const assistant = createAssistantMessage("latest", {
			input: 5,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			total_tokens: 12,
		});
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex !== 1) return;
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
			emit({ type: "message_end", message: assistant });
			emit({ type: "message_end", message: assistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-repeat",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		createAgentSessionMock.mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-repeat-message-end" });
		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
		expect(result.tokens).toBe(12);
		expect(result.usage).toMatchObject({
			input: 5,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 12,
		});
	});

	test("retains distinct assistant turns even with identical usage values", async () => {
		const firstAssistant = createAssistantMessage("first", {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 4,
			total_tokens: 10,
		});
		const secondAssistant = createAssistantMessage("second", {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 4,
			total_tokens: 10,
		});
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex !== 1) return;
			state.messages.push(firstAssistant, secondAssistant);
			emit({ type: "message_end", message: firstAssistant });
			emit({ type: "message_end", message: secondAssistant });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-identical-turns",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		createAgentSessionMock.mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-identical-turn-usage" });
		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
		expect(result.tokens).toBe(10);
		expect(result.usage).toMatchObject({
			input: 6,
			output: 4,
			cacheRead: 2,
			cacheWrite: 8,
			totalTokens: 20,
		});
	});

	test("accumulates cache usage breakdown from canonical alias variants", async () => {
		const assistantCamelAliases = createAssistantMessage("camel aliases", {
			inputTokens: 10,
			outputTokens: 8,
			cacheReadInputTokens: 4_000,
			cacheCreationInputTokens: 2_000,
			total_tokens: 6_018,
		});
		const assistantSnakeAliases = createAssistantMessage("snake aliases", {
			input_tokens: 4,
			output_tokens: 3,
			cache_read_input_tokens: 7,
			cache_creation_input_tokens: 5,
			total_tokens: 19,
		});
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex !== 1) return;
			state.messages.push(assistantCamelAliases, assistantSnakeAliases);
			emit({ type: "message_end", message: assistantCamelAliases });
			emit({ type: "message_end", message: assistantSnakeAliases });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-submit-aliases",
				toolName: "submit_result",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		createAgentSessionMock.mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runSubprocess({ ...baseOptions, id: "subagent-cache-aliases" });
		expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
		expect(result.exitCode).toBe(0);
		expect(result.tokens).toBe(19);
		expect(result.usage).toMatchObject({
			input: 14,
			output: 11,
			cacheRead: 4_007,
			cacheWrite: 2_005,
			totalTokens: 6_037,
		});
	});
});

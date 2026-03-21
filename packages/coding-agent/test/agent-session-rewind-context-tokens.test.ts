import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel, type ToolCall, type Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

class MockAssistantStream extends AssistantMessageEventStream {}

const HIGH_USAGE: Usage = {
	input: 8_000,
	output: 700,
	cacheRead: 200,
	cacheWrite: 100,
	totalTokens: 9_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LOW_USAGE: Usage = {
	input: 20,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage: Usage,
) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function makeToolCallMessage(
	name: string,
	id: string,
	argumentsObject: Record<string, unknown>,
	usage: Usage,
): AssistantMessage {
	const toolCall: ToolCall = { type: "toolCall", name, id, arguments: argumentsObject };
	return makeAssistantMessage([toolCall], "toolUse", usage);
}

describe("AgentSession rewind context token fallback", () => {
	let session: AgentSession;
	let tempDir: string;
	let capturedCheckpointTokens: number | undefined;
	let streamCallCount = 0;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-rewind-token-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		streamCallCount = 0;
		capturedCheckpointTokens = undefined;

		const checkpointTool: AgentTool = {
			name: "checkpoint",
			label: "Checkpoint",
			description: "checkpoint test tool",
			parameters: Type.Object({ goal: Type.String() }),
			execute: async () => ({
				content: [{ type: "text", text: "checkpoint created" }],
				details: { startedAt: new Date().toISOString() },
			}),
		};

		const rewindTool: AgentTool = {
			name: "rewind",
			label: "Rewind",
			description: "rewind test tool",
			parameters: Type.Object({ report: Type.String() }),
			execute: async (_toolCallId, params) => {
				const report = (params as { report: string }).report;
				capturedCheckpointTokens = session.getCheckpointState()?.contextTokensAtCheckpoint;
				return {
					content: [{ type: "text", text: report }],
					details: { report, rewound: true },
				};
			},
		};

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [checkpointTool, rewindTool],
				messages: [],
			},
			streamFn: () => {
				streamCallCount += 1;
				const stream = new MockAssistantStream();

				queueMicrotask(() => {
					if (streamCallCount === 1) {
						const msg = makeToolCallMessage(
							"checkpoint",
							"call_checkpoint_1",
							{ goal: "investigate" },
							HIGH_USAGE,
						);
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
						return;
					}

					if (streamCallCount === 2) {
						const msg = makeToolCallMessage(
							"rewind",
							"call_rewind_1",
							{ report: "checkpoint report" },
							LOW_USAGE,
						);
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
						return;
					}

					if (streamCallCount === 3) {
						const msg = makeAssistantMessage(
							[{ type: "text", text: "intermediate response" }],
							"aborted",
							LOW_USAGE,
						);
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
						return;
					}

					const msg = makeAssistantMessage([{ type: "text", text: "response after rewind" }], "stop", LOW_USAGE);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});

				return stream;
			},
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stores checkpoint tokens and reuses them after rewind when no post-rewind assistant usage exists", async () => {
		await session.prompt("run checkpoint and rewind");

		expect(capturedCheckpointTokens).toBeGreaterThan(0);
		const contextUsage = session.getContextUsage();
		expect(contextUsage?.tokens).toBe(capturedCheckpointTokens);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && (message as { customType?: string }).customType === "rewind-report",
			),
		).toBe(true);
	});

	it("clears checkpoint fallback tokens after a post-rewind assistant response", async () => {
		await session.prompt("run checkpoint and rewind");
		const checkpointTokens = capturedCheckpointTokens;
		expect(checkpointTokens).toBeGreaterThan(0);

		await session.prompt("reply after rewind");
		session.getContextUsage();

		session.agent.appendMessage({
			role: "custom",
			customType: "rewind-report",
			content: "manual barrier",
			display: false,
			details: {},
			attribution: "agent",
			timestamp: Date.now(),
		});

		const contextUsageAfterManualBarrier = session.getContextUsage();
		expect(contextUsageAfterManualBarrier?.tokens).toBeLessThan(checkpointTokens as number);
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager, type AsyncJob } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const TEST_MODEL = getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17");
if (!TEST_MODEL) {
	throw new Error("Expected bundled Gemini test model to be available");
}

const TEST_MODEL_REGISTRY = {
	getApiKey: async () => "test-key",
} as never;

const tempDirs = new Set<string>();


class MockAssistantStream extends AssistantMessageEventStream {}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createStreamAgent(responses: string[]) {
	let callCount = 0;
	const agent = new Agent({
		initialState: {
			model: TEST_MODEL,
			systemPrompt: "Test",
			messages: [],
			tools: [],
		},
		streamFn: () => {
			const stream = new MockAssistantStream();
			const text = responses[callCount] ?? `response-${callCount + 1}`;
			callCount += 1;
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage(text) });
			});
			return stream;
		},
	});
	return { agent, getCallCount: () => callCount };
}

function createTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.add(dir);
	return dir;
}

async function waitForValue<T>(readValue: () => T | undefined, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = readValue();
		if (value !== undefined) {
			return value;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function startAsyncBashJob(session: AgentSession, command = "printf 'async result'"): Promise<void> {
	const bashTool = session.agent.state.tools.find(tool => tool.name === "bash");
	if (!bashTool) {
		throw new Error("Expected bash tool to be available");
	}
	await bashTool.execute(
		"call-bash",
		{ command, async: true },
		undefined,
		undefined,
		undefined,
	);
}

describe("background job revival prevention", () => {
	afterEach(() => {
		vi.useRealTimers();
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.clear();
	});

	test("drains completed jobs into follow-up turns before going idle", async () => {
		const { agent, getCallCount } = createStreamAgent(["initial response", "follow-up response"]);
		let session: AgentSession | undefined;
		try {
			const manager = new AsyncJobManager({
				onJobComplete: async (jobId, result) => {
					await session?.sendCustomMessage(
						{
							customType: "async-result",
							content: `job ${jobId}: ${result}`,

							display: true,

							attribution: "agent",

							details: { jobId },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			});
			session = new AgentSession({
				agent,

				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": false }),
				modelRegistry: TEST_MODEL_REGISTRY,
				asyncJobManager: manager,
			});


			const jobId = manager.register(
				"task",
				"delayed",
				async () => {
					await Bun.sleep(25);
					return "completed during drain";
				},
				{ id: "delayed" },
			);


			await session.prompt("start");


			expect(getCallCount()).toBe(2);
			const asyncMessages = session.agent.state.messages.filter(
				(
					message,
				): message is Extract<AgentMessage, { role: "custom" }> =>
					message.role === "custom" && message.customType === "async-result",
			);
			expect(asyncMessages).toHaveLength(1);
			expect(asyncMessages[0]?.content).toBe(`job ${jobId}: completed during drain`);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant" });
			expect(manager.hasPendingDeliveries()).toBe(false);
		} finally {
			await session?.dispose();
		}
	});

	test("acknowledges pending, running, and late completions after drain limits are reached", async () => {
		const { agent } = createStreamAgent(["unused"]);
		const ackCalls: string[][] = [];
		const waitForAllCalls: boolean[] = [];
		const drainCalls: Array<{ timeoutMs?: number }> = [];
		let pendingJobIds = ["job-pending"];
		let runningJobs: AsyncJob[] = [
			{
				id: "job-running",
				type: "task",
				status: "running",
				startTime: Date.now(),
				label: "still running",
				abortController: new AbortController(),
				promise: new Promise<void>(() => {}),
			},
		];
		const fakeManager = {
			getRunningJobs: () => runningJobs,
			hasPendingDeliveries: () => pendingJobIds.length > 0,
			waitForAll: async () => {
				waitForAllCalls.push(true);
				await new Promise<void>(() => {});
			},
			drainDeliveries: async (options?: { timeoutMs?: number }) => {
				drainCalls.push(options ?? {});
				return await new Promise<boolean>(resolve => {
					setTimeout(() => resolve(false), 2_000);
				});
			},
			getDeliveryState: () => ({
				queued: pendingJobIds.length,
				delivering: false,
				pendingJobIds: [...pendingJobIds],
			}),
			acknowledgeDeliveries: (jobIds: string[]) => {
				ackCalls.push(jobIds);
				if (jobIds.includes("job-running")) {
					runningJobs = [];
					pendingJobIds = ["job-pending", "job-finished-between-snapshots"];
				} else {
					pendingJobIds = pendingJobIds.filter(jobId => !jobIds.includes(jobId));
				}
				return jobIds.length;
			},
			dispose: async () => true,
		} as unknown as AsyncJobManager;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": false }),
			modelRegistry: TEST_MODEL_REGISTRY,
			asyncJobManager: fakeManager,
		});


		try {
			const beforeIdlePromise = agent.beforeIdle?.();
			await beforeIdlePromise;


			expect(waitForAllCalls).toHaveLength(1);
			expect(drainCalls).toEqual([{ timeoutMs: 2_000 }]);
			expect(ackCalls).toEqual([["job-running"], ["job-pending", "job-finished-between-snapshots"]]);
			expect(pendingJobIds).toEqual([]);
			expect(runningJobs).toEqual([]);
		} finally {
			await session.dispose();
		}
	}, { timeout: 10_000 });

	test("stops waiting for before-idle drain when the turn is aborted", async () => {
		const { agent } = createStreamAgent(["unused"]);
		const waitForAllCalls: boolean[] = [];
		const drainCalls: Array<{ timeoutMs?: number }> = [];
		const fakeManager = {
			getRunningJobs: (): AsyncJob[] => [
				{
					id: "job-running",
					type: "task",
					status: "running",
					startTime: Date.now(),
					label: "still running",
					abortController: new AbortController(),
					promise: new Promise<void>(() => {}),
				},
			],
			hasPendingDeliveries: () => true,
			waitForAll: async () => {
				waitForAllCalls.push(true);
				await new Promise<void>(() => {});
			},
			drainDeliveries: async (options?: { timeoutMs?: number }) => {
				drainCalls.push(options ?? {});
				await new Promise<void>(() => {});
				return false;
			},
			getDeliveryState: () => ({ queued: 1, delivering: false, pendingJobIds: ["job-pending"] }),
			acknowledgeDeliveries: () => 0,
			dispose: async () => true,
		} as unknown as AsyncJobManager;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": false }),
			modelRegistry: TEST_MODEL_REGISTRY,
			asyncJobManager: fakeManager,
		});


		try {
			const abortController = new AbortController();
			const beforeIdlePromise = agent.beforeIdle?.(abortController.signal);
			abortController.abort();


			const result = await Promise.race([
				beforeIdlePromise?.then(() => "completed"),
				Bun.sleep(100).then(() => "timed-out"),
			]);


			expect(result).toBe("completed");
			expect(waitForAllCalls).toHaveLength(1);
			expect(drainCalls).toHaveLength(0);
		} finally {
			await session.dispose();
		}
	});


	test("queues async completions for the next turn when the session is idle", async () => {
		const tempDir = createTempDir("pi-async-idle-");
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "async.enabled": true }),
				disableExtensionDiscovery: true,
			});
			session = result.session;
			const sendCustomMessageCalls: Array<[unknown, unknown]> = [];
			session.sendCustomMessage = (async (...args) => {
				sendCustomMessageCalls.push(args as [unknown, unknown]);
			}) as typeof session.sendCustomMessage;


			await startAsyncBashJob(session);
			const [, deliveryOptions] = await waitForValue(() => sendCustomMessageCalls[0], 5_000);


			expect(sendCustomMessageCalls).toHaveLength(1);
			expect(deliveryOptions).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
		} finally {
			await session?.dispose();
		}
	});

	test("preserves follow-up delivery for async completions while draining before idle", async () => {
		const tempDir = createTempDir("pi-async-before-idle-");
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "async.enabled": true }),
				disableExtensionDiscovery: true,
			});
			session = result.session;
			const sendCustomMessageCalls: Array<[unknown, unknown]> = [];
			session.sendCustomMessage = (async (...args) => {
				sendCustomMessageCalls.push(args as [unknown, unknown]);
			}) as typeof session.sendCustomMessage;


			await startAsyncBashJob(session, "sleep 0.1; printf 'async result'");
			const beforeIdlePromise = session.agent.beforeIdle?.();
			const [, deliveryOptions] = await waitForValue(() => sendCustomMessageCalls[0], 5_000);
			await beforeIdlePromise;


			expect(sendCustomMessageCalls).toHaveLength(1);
			expect(deliveryOptions).toEqual({ deliverAs: "followUp", triggerTurn: true });
		} finally {
			await session?.dispose();
		}
	});


	test("preserves follow-up delivery for async completions while streaming", async () => {
		const tempDir = createTempDir("pi-async-streaming-");
		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "async.enabled": true }),
				disableExtensionDiscovery: true,
			});
			session = result.session;
			const sendCustomMessageCalls: Array<[unknown, unknown]> = [];
			session.sendCustomMessage = (async (...args) => {
				sendCustomMessageCalls.push(args as [unknown, unknown]);
			}) as typeof session.sendCustomMessage;
			session.agent.state.isStreaming = true;


			await startAsyncBashJob(session);
			const [, deliveryOptions] = await waitForValue(() => sendCustomMessageCalls[0], 5_000);


			expect(sendCustomMessageCalls).toHaveLength(1);
			expect(deliveryOptions).toEqual({ deliverAs: "followUp", triggerTurn: true });
		} finally {
			await session?.dispose();
		}
	});
});

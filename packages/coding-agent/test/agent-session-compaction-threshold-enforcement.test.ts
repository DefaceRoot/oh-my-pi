import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession compaction threshold enforcement", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-threshold-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "handoff",
				"compaction.autoContinue": false,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});

		session.subscribe(event => {
			events.push(event);
		});

		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	function setContextWindow(contextWindow: number): void {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		session.agent.setModel({ ...model, contextWindow });
	}

	function seedLargeUserContext(charCount: number): void {
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "x".repeat(charCount) }],
			attribution: "user",
			timestamp: Date.now() - 10,
		});
	}

	function seedErrorAssistant(model: NonNullable<AgentSession["model"]>): void {
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "error turn" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "temporary provider failure",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		session.agent.appendMessage(errorAssistant);
	}

	it("enforces threshold before send on first turn with no prior assistant message", async () => {
		session.settings.set("compaction.thresholdPercent", 50);
		setContextWindow(4_000);
		seedLargeUserContext(20_000);

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });
		await session.prompt("trigger first-turn pre-send check");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledWith(expect.stringContaining("Threshold-triggered maintenance"), {
			autoTriggered: true,
			signal: expect.any(AbortSignal),
		});
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
	});

	it("enforces threshold from accumulated multi-turn history, not only the latest assistant usage", async () => {
		session.settings.set("compaction.thresholdPercent", 50);
		setContextWindow(4_000);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const baseTimestamp = Date.now() - 10_000;
		for (let turn = 0; turn < 8; turn++) {
			session.agent.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn-${turn} ${"x".repeat(5_000)}` }],
				attribution: "user",
				timestamp: baseTimestamp + turn * 2,
			});
			const assistantTurn: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `ack-${turn}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 80,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: baseTimestamp + turn * 2 + 1,
			};
			session.agent.appendMessage(assistantTurn);
		}

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });
		await session.prompt("trigger accumulated-history pre-send check");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
	});

	it("enforces threshold before send after an error turn", async () => {
		session.settings.set("compaction.thresholdPercent", 50);
		setContextWindow(4_000);
		seedLargeUserContext(20_000);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		seedErrorAssistant(model);

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });
		await session.prompt("trigger error-turn pre-send check");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
	});

	it("applies thresholdPercent relative to the active model context window", async () => {
		session.settings.set("compaction.thresholdPercent", 50);
		seedLargeUserContext(12_000);

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });

		setContextWindow(10_000);
		await session.prompt("no compaction expected");
		expect(handoffSpy).toHaveBeenCalledTimes(0);

		setContextWindow(4_000);
		await session.prompt("compaction expected");
		expect(handoffSpy).toHaveBeenCalledTimes(1);
	});

	it("uses fallback context window when model metadata is missing", async () => {
		session.settings.set("compaction.thresholdPercent", 1);
		setContextWindow(0);
		seedLargeUserContext(80_000);

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });
		await session.prompt("trigger missing-context-window fallback");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
	});

	it("marks threshold no-op maintenance distinctly from failure", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 50);
		setContextWindow(4_000);
		seedLargeUserContext(9_000);

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue(undefined);
		await session.prompt("trigger threshold no-op");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: expect.any(String),
		});
	});
	it("interrupts tool-driven turns when context crosses the threshold mid-turn", async () => {
		session.settings.set("compaction.thresholdPercent", 10);
		setContextWindow(4_000);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const abortSpy = vi.spyOn(session.agent, "abort").mockImplementation(() => {});
		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff doc" });
		const promptImpl = async (messages: unknown): Promise<void> => {
			const promptMessages = Array.isArray(messages) ? [...messages] : [];
			const toolResult = {
				role: "toolResult" as const,
				toolName: "read",
				toolCallId: "test-call-id",
				content: [{ type: "text" as const, text: "x".repeat(500_000) }],
				isError: false,
				timestamp: Date.now(),
			};
			session.agent.replaceMessages(promptMessages);
			session.agent.appendMessage(toolResult);
			session.agent.emitExternalEvent({ type: "message_end", message: toolResult });
			await Promise.resolve();
		};
		session.agent.prompt = promptImpl as typeof session.agent.prompt;

		await session.prompt("trigger tool-loop threshold maintenance");
		await Bun.sleep(50);

		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "interrupted for compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "aborted",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() + 1,
		};
		session.agent.appendMessage(abortedAssistant);
		session.agent.emitExternalEvent({ type: "message_end", message: abortedAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [abortedAssistant] });
		await compactionDone;

		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual(expect.objectContaining({ type: "auto_compaction_start", reason: "threshold" }));
	});
});

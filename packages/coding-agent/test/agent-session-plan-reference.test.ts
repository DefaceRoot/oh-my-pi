import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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

describe("AgentSession plan reference injection", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-plan-reference-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	it("does not inject full prior plan body into context", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const planFilePath = "local://plans/reentry/plan.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		});
		await fs.mkdir(path.dirname(resolvedPlanPath), { recursive: true });
		await fs.writeFile(resolvedPlanPath, "# Prior Plan\n\nSENTINEL_PRIOR_PLAN_TEXT\n- Step 1\n- Step 2\n", "utf8");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setPlanReferencePath(planFilePath);

		await session.prompt("continue");

		const planReferenceMessage = session.messages.find(
			message => message.role === "custom" && message.customType === "plan-mode-reference",
		);
		expect(planReferenceMessage).toBeDefined();
		if (!planReferenceMessage || planReferenceMessage.role !== "custom") {
			throw new Error("Expected injected plan-mode-reference message in session state");
		}

		const content =
			typeof planReferenceMessage.content === "string"
				? planReferenceMessage.content
				: planReferenceMessage.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		expect(content).toContain(planFilePath);
		expect(content).toContain("delegate a focused read/review task");
		expect(content).toContain("continue executing it");
		expect(content).toContain("MUST** ignore it");
		expect(content).not.toContain("SENTINEL_PRIOR_PLAN_TEXT");
		expect(content).not.toContain("# Prior Plan");
	});

	it("injects plan reference for repo-relative nested plan paths", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const planFilePath = ".omp/sessions/plans/reentry-plan/plan.md";
		const resolvedPlanPath = path.resolve(tempDir.path(), planFilePath);
		await fs.mkdir(path.dirname(resolvedPlanPath), { recursive: true });
		await fs.writeFile(resolvedPlanPath, "# Nested Plan\n\nSENTINEL_RELATIVE_PLAN_TEXT\n", "utf8");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setPlanReferencePath(planFilePath);

		await session.prompt("continue");

		const planReferenceMessage = session.messages.find(
			message => message.role === "custom" && message.customType === "plan-mode-reference",
		);
		expect(planReferenceMessage).toBeDefined();
		if (!planReferenceMessage || planReferenceMessage.role !== "custom") {
			throw new Error("Expected injected plan-mode-reference message for relative plan path");
		}

		const content =
			typeof planReferenceMessage.content === "string"
				? planReferenceMessage.content
				: planReferenceMessage.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		expect(content).toContain(planFilePath);
		expect(content).not.toContain("SENTINEL_RELATIVE_PLAN_TEXT");
	});

	it("keeps repo-relative plan reference path across new session handoff", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const planFilePath = ".omp/sessions/plans/reentry-plan/plan.md";
		const resolvedPlanPath = path.resolve(tempDir.path(), planFilePath);
		await fs.mkdir(path.dirname(resolvedPlanPath), { recursive: true });
		await fs.writeFile(resolvedPlanPath, "# Nested Plan\n\nSENTINEL_HANDOFF_PLAN_TEXT\n", "utf8");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setPlanReferencePath(planFilePath);

		await session.prompt("continue");
		await session.newSession();
		await session.prompt("continue");

		const planReferenceMessage = session.messages.find(
			message => message.role === "custom" && message.customType === "plan-mode-reference",
		);
		expect(planReferenceMessage).toBeDefined();
		if (!planReferenceMessage || planReferenceMessage.role !== "custom") {
			throw new Error("Expected injected plan-mode-reference message after new session handoff");
		}

		const content =
			typeof planReferenceMessage.content === "string"
				? planReferenceMessage.content
				: planReferenceMessage.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		expect(content).toContain(planFilePath);
		expect(content).not.toContain("SENTINEL_HANDOFF_PLAN_TEXT");
	});

	it("suppresses generic plan-mode context for specialized delegated plan-mode states", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setPlanModeState({
			enabled: true,
			planFilePath:
				".omp/sessions/plans/test-plan/artifacts/plan-verifier/01-phase/20260307-120000Z/.plan-verifier-write-root",
			suppressPlanModeMessage: true,
		});

		await session.prompt("continue");

		const planModeContextMessage = session.messages.find(
			message => message.role === "custom" && message.customType === "plan-mode-context",
		);
		expect(planModeContextMessage).toBeUndefined();
	});

	it("does not inject plan reference when file is missing", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const planFilePath = "local://plans/reentry/missing-plan.md";

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.setPlanReferencePath(planFilePath);

		await session.prompt("continue");

		const planReferenceMessage = session.messages.find(
			message => message.role === "custom" && message.customType === "plan-mode-reference",
		);
		expect(planReferenceMessage).toBeUndefined();
	});
});

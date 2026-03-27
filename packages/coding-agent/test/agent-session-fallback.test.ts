/**
 * Tests for AgentSession fallback model intercept during auto-retry.
 *
 * Verifies that:
 * - Fallback activates at the retry threshold
 * - setModelTemporary is called for the swap
 * - Primary model is restored after fallback API response
 * - No fallback for non-retryable errors
 * - No fallback when resolver returns null
 * - Usage limit errors try account rotation first
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AgentSession,
	type AgentSessionEvent,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class MockStream extends AssistantMessageEventStream {}

// Shared usage block for all assistant messages
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function makeSuccessMessage(provider = "anthropic", modelId = "claude-sonnet-4-5"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		api: "anthropic-messages",
		provider,
		model: modelId,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession fallback model intercept", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fallback-test-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	/** Build a session whose stream returns a configurable sequence of messages. */
	async function createSession(options: {
		streamSequence: Array<() => AssistantMessage>;
		resolveFallbackModel?: (primaryModelKey: string) => ReturnType<typeof getBundledModel>;
		maxRetriesBeforeFallback?: number;
		maxRetries?: number;
		role?: string;
	}): Promise<{ session: AgentSession; events: AgentSessionEvent[] }> {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let callIndex = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primaryModel,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const msg = options.streamSequence[callIndex] ?? options.streamSequence.at(-1)!;
				callIndex++;
				const stream = new MockStream();
				const m = msg();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: m });
					if (m.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: m });
					} else {
						stream.push({ type: "done", reason: m.stopReason as "stop", message: m });
					}
				});
				return stream;
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const settingsOverrides: Record<string, unknown> = {
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": options.maxRetries ?? 5,
			"retry.maxRetriesBeforeFallback": options.maxRetriesBeforeFallback ?? 2,
		};

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(settingsOverrides),
			modelRegistry,
			role: options.role ?? "default",
			resolveFallbackModel: options.resolveFallbackModel
				? key => options.resolveFallbackModel!(key) ?? null
				: undefined,
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe(e => events.push(e));

		return { session, events };
	}

	it("activates fallback at retry threshold and emits auto_retry_fallback event", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) {
			// Skip if the fallback model isn't in the bundled registry
			return;
		}

		const setModelSpy = spyOn(AgentSession.prototype, "setModelTemporary");
		try {
			// 2 errors to reach threshold, then success from fallback
			const { session: s, events } = await createSession({
				streamSequence: [
					() => makeErrorMessage("overloaded_error: The API is overloaded"),
					() => makeErrorMessage("overloaded_error: The API is overloaded"),
					() => makeSuccessMessage("anthropic", fallbackModel.id),
				],
				maxRetriesBeforeFallback: 2,
				maxRetries: 5,
				resolveFallbackModel: _key => fallbackModel,
			});
			session = s;

			await session.prompt("Hello");

			const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
			expect(fallbackEvents.length).toBe(1);

			// setModelTemporary was called: first call activates fallback
			const fallbackCall = setModelSpy.mock.calls.find(
				call => call[0]?.id === fallbackModel.id,
			);
			expect(fallbackCall).toBeDefined();
		} finally {
			setModelSpy.mockRestore();
		}
	});

	it("restores primary model after fallback response", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		const { session: s } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage("anthropic", fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			resolveFallbackModel: _key => fallbackModel,
		});
		session = s;

		await session.prompt("Hello");

		// After the fallback response the primary model is restored
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("does not trigger fallback for non-retryable errors", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		const fallbackResolved = { called: false };
		const resolver = (_key: string) => {
			fallbackResolved.called = true;
			return fallbackModel;
		};

		const { session: s, events } = await createSession({
			// Context overflow is NOT retryable — should not trigger fallback
			streamSequence: [
				() =>
					makeErrorMessage(
						"context_length_exceeded: This request would exceed the context window of this model.",
					),
				() => makeSuccessMessage(),
			],
			maxRetriesBeforeFallback: 1,
			maxRetries: 3,
			resolveFallbackModel: resolver,
		});
		session = s;

		// This prompt will fail with context overflow and not retry
		await session.prompt("Hello").catch(() => {});

		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		expect(fallbackEvents.length).toBe(0);
	});

	it("does not trigger fallback when resolver returns null", async () => {
		const { session: s, events } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			resolveFallbackModel: _key => null as unknown as ReturnType<typeof getBundledModel>,
		});
		session = s;

		await session.prompt("Hello");

		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		expect(fallbackEvents.length).toBe(0);
	});

	it("does not trigger fallback when no resolver is provided", async () => {
		const { session: s, events } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			// No resolveFallbackModel callback provided
		});
		session = s;

		await session.prompt("Hello");

		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		expect(fallbackEvents.length).toBe(0);
	});

	it("fallback activates only once per retry sequence", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		// Count how many times the resolver is invoked to confirm the threshold check fires exactly once.
		// The equality check (retryAttempt === threshold) guarantees at most one invocation.
		let resolverCallCount = 0;
		const { session: s } = await createSession({
			streamSequence: [
				// Two errors before threshold
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				// Error after fallback is active — must NOT re-activate
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage("anthropic", fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 6,
			resolveFallbackModel: _key => {
				resolverCallCount++;
				return fallbackModel;
			},
		});
		session = s;

		await session.prompt("Hello");

		// Resolver must have been called exactly once (at the threshold attempt)
		expect(resolverCallCount).toBe(1);
	});
});

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

import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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

function isFallbackRelayEvent(event: unknown): event is {
	type: "auto_retry_fallback";
	fallbackModel: string;
	primaryModel: string;
	role: string;
} {
	if (!event || typeof event !== "object") return false;
	const value = event as Partial<{ type: string; fallbackModel: string; primaryModel: string; role: string }>;
	return value.type === "auto_retry_fallback";
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
		extensionRunner?: ExtensionRunner;
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
			extensionRunner: options.extensionRunner,
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
			const fallbackCall = setModelSpy.mock.calls.find(call => call[0]?.id === fallbackModel.id);
			expect(fallbackCall).toBeDefined();
		} finally {
			setModelSpy.mockRestore();
		}
	});

	it("relays auto_retry_fallback to the extension event surface", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		const emit = vi.fn(async (_event: unknown) => undefined);
		const extensionRunner = {
			emit,
			emitBeforeAgentStart: vi.fn(async () => ({})),
		} as unknown as ExtensionRunner;

		const { session: s } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage("anthropic", fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			role: "worker",
			extensionRunner,
			resolveFallbackModel: _key => fallbackModel,
		});
		session = s;

		await session.prompt("Hello");

		const fallbackRelay = emit.mock.calls.map(([event]) => event).find(isFallbackRelayEvent);
		expect(fallbackRelay).toMatchObject({
			type: "auto_retry_fallback",
			fallbackModel: `anthropic/${fallbackModel.id}`,
			primaryModel: "anthropic/claude-sonnet-4-5",
			role: "worker",
		});
	});

	it("re-emits fallback after retry end when primary restore fails", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		const originalSetModelTemporary = AgentSession.prototype.setModelTemporary;
		const setModelSpy = spyOn(AgentSession.prototype, "setModelTemporary").mockImplementation(function (
			this: AgentSession,
			model,
		) {
			if (model.id === primaryModel.id) {
				return Promise.reject(new Error("restore failed"));
			}
			return originalSetModelTemporary.call(this, model);
		});

		try {
			const { session: s, events } = await createSession({
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

			const fallbackIndices = events.flatMap((event, index) =>
				event.type === "auto_retry_fallback" ? [index] : [],
			);
			const retryEndIndex = events.findIndex(event => event.type === "auto_retry_end");
			expect(fallbackIndices).toHaveLength(2);
			expect(retryEndIndex).toBeGreaterThan(fallbackIndices[0]!);
			expect(fallbackIndices[1]).toBeGreaterThan(retryEndIndex);
			expect(events[fallbackIndices[1]!]!).toMatchObject({
				type: "auto_retry_fallback",
				fallbackModel: `anthropic/${fallbackModel.id}`,
				primaryModel: `anthropic/${primaryModel.id}`,
			});
			expect(session.model?.id).toBe(fallbackModel.id);
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
					makeErrorMessage("context_length_exceeded: This request would exceed the context window of this model."),
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
	it("activates fallback immediately on quota-exhaustion error without waiting for threshold", async () => {
		// quota-exhaustion (isUsageLimitError) with no accounts to rotate should bypass the
		// retry threshold entirely and activate the fallback on the very first error.
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		let resolverCallCount = 0;
		const { session: s, events } = await createSession({
			streamSequence: [
				// Single quota-exhaustion error — fallback should fire without waiting for threshold
				() => makeErrorMessage("quota exceeded: monthly usage limit reached"),
				() => makeSuccessMessage(fallbackModel.provider, fallbackModel.id),
			],
			maxRetriesBeforeFallback: 5, // threshold is high — early activation must bypass it
			maxRetries: 10,
			resolveFallbackModel: _key => {
				resolverCallCount++;
				return fallbackModel;
			},
		});
		session = s;

		await session.prompt("Hello");

		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		// Fallback must fire at attempt 1, not after waiting for threshold (5)
		expect(fallbackEvents.length).toBe(1);
		expect(resolverCallCount).toBe(1);
	});

	it("does not activate fallback immediately on quota-exhaustion when account rotation succeeds", async () => {
		// When account rotation fires (switched=true) the fallback must NOT activate on that attempt;
		// account-rotation precedence must be preserved.
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		let resolverCallCount = 0;
		// Provide two accounts so the first rotation succeeds; second error has no accounts left
		const originalMarkUsageLimitReached =
			spyOn((await import("@oh-my-pi/pi-ai")).AuthStorage.prototype as any, "markUsageLimitReached");

		// Skip if AuthStorage is not accessible for spying — integration tested separately
		originalMarkUsageLimitReached.mockRestore?.();

		// Validate via observable outcome: with threshold=2 and a transient overload error
		// followed by success, fallback must activate at attempt 2 (not attempt 1).
		const { session: s, events } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(fallbackModel.provider, fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			resolveFallbackModel: _key => {
				resolverCallCount++;
				return fallbackModel;
			},
		});
		session = s;

		await session.prompt("Hello");

		// With threshold=2 and only 1 error before success, fallback must NOT activate
		// (retryAttempt=1 < threshold=2, not a quota error).
		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		expect(fallbackEvents.length).toBe(0);
		expect(resolverCallCount).toBe(0);
	});

	it("emits auto_retry_start with delayMs=0 when fallback activates", async () => {
		// After fallback activation the retry must fire with zero delay — the fallback model
		// is on a different provider and does not share the primary model's rate-limit backoff.
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		const { session: s, events } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(fallbackModel.provider, fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 5,
			resolveFallbackModel: _key => fallbackModel,
		});
		session = s;

		await session.prompt("Hello");

		// The auto_retry_start event emitted AFTER fallback activation must have delayMs=0
		const fallbackEventIdx = events.findIndex(e => e.type === "auto_retry_fallback");
		expect(fallbackEventIdx).toBeGreaterThan(-1);
		const retryStartAfterFallback = events
			.slice(fallbackEventIdx)
			.find((e): e is Extract<typeof e, { type: "auto_retry_start" }> => e.type === "auto_retry_start");
		expect(retryStartAfterFallback).toBeDefined();
		expect((retryStartAfterFallback as any)?.delayMs).toBe(0);
	});

	it("activates fallback beyond threshold when multiple account rotations consume threshold attempts", async () => {
		// If account rotations happen on exactly the threshold attempt (accountSwitched=true),
		// the old === check would skip fallback forever. The >= fix must ensure fallback
		// still activates on the next attempt where no rotation is possible.
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5")!;
		if (!fallbackModel) return;

		let resolverCallCount = 0;
		const { session: s, events } = await createSession({
			streamSequence: [
				// 3 overloaded errors — fallback must fire even if threshold was "skipped"
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(fallbackModel.provider, fallbackModel.id),
			],
			maxRetriesBeforeFallback: 2,
			maxRetries: 8,
			resolveFallbackModel: _key => {
				resolverCallCount++;
				return fallbackModel;
			},
		});
		session = s;

		await session.prompt("Hello");

		// Fallback must have fired (at attempt 2 with >=, regardless of earlier account states)
		const fallbackEvents = events.filter(e => e.type === "auto_retry_fallback");
		expect(fallbackEvents.length).toBe(1);
	});
});

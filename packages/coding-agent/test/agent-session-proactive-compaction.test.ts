import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const runtimeSignalStoreKey = "__ompProactiveCompactionSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

async function waitForAsyncHandler(condition: () => boolean, message: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let remaining = 20;

	const check = () => {
		if (condition()) {
			resolve();
			return;
		}
		if (remaining-- === 0) {
			reject(new Error(message));
			return;
		}
		queueMicrotask(check);
	};

	queueMicrotask(check);
	await promise;
}

function createHighUsageToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 190000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("AgentSession proactive compaction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	async function createSession(settings: Partial<Record<SettingPath, unknown>>): Promise<void> {
		tempDir = TempDir.createSync("@pi-proactive-compaction-");
		vi.useFakeTimers();

		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "proactive-compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "proactively compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(settings),
			modelRegistry,
			extensionRunner,
		});
	}

	beforeEach(() => {
		getRuntimeSignals().length = 0;
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("aborts and auto-continues after threshold compaction at turn_end", async () => {
		await createSession({
			"compaction.proactiveEnabled": true,
			"compaction.autoContinue": true,
		});

		const abortSpy = vi.spyOn(session.agent, "abort");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = createHighUsageToolCallMessage();

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "turn_end", message: assistantMsg, toolResults: [] });

		await waitForAsyncHandler(() => abortSpy.mock.calls.length === 1, "Proactive abort timed out");

		await withTimeout(compactionDone, 1000, "Proactive compaction timed out");
		await Promise.resolve();
		vi.advanceTimersByTime(200);
		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals).toContain("compaction:end:ok");
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("does not proactively compact at turn_end when disabled by default", async () => {
		await createSession({});

		const abortSpy = vi.spyOn(session.agent, "abort");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const assistantMsg = createHighUsageToolCallMessage();

		let turnEndHandled = false;
		session.subscribe(event => {
			if (event.type === "turn_end") turnEndHandled = true;
		});

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "turn_end", message: assistantMsg, toolResults: [] });

		await waitForAsyncHandler(() => turnEndHandled, "Proactive disabled turn_end handler did not flush");
		await Promise.resolve();

		expect(abortSpy).not.toHaveBeenCalled();
		expect(getRuntimeSignals()).not.toContain("compaction:start:threshold");
		expect(promptSpy).not.toHaveBeenCalled();
	});
});

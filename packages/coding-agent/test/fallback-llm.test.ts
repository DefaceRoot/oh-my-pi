import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveFallbackModel } from "../src/config/model-resolver";
import { RolesConfig } from "../src/config/roles-config";
import { Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import {
	createConfigModal,
	focusModelTab,
	getModelKey,
	initConfigModalTheme,
} from "./increment2-config-modal-test-utils";

class MockStream extends AssistantMessageEventStream {}

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

describe("fallback model runtime integration", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeAll(() => {
		initConfigModalTheme();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fallback-modal-runtime-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
		session = undefined;
		authStorage = undefined;
	});

	async function createSession(options: {
		streamSequence: Array<() => AssistantMessage>;
		settings: Settings;
		resolveFallbackModel: (
			primaryModelKey: string,
			modelRegistry: ModelRegistry,
			settings: Settings,
		) => ReturnType<typeof getBundledModel> | null;
	}): Promise<{ session: AgentSession; events: AgentSessionEvent[] }> {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled primary fallback test model");
		}

		let callIndex = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primaryModel,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const messageFactory = options.streamSequence[callIndex] ?? options.streamSequence.at(-1);
				if (!messageFactory) {
					throw new Error("Expected fallback stream message");
				}
				callIndex++;
				const stream = new MockStream();
				const message = messageFactory();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: message.stopReason as "stop", message });
					}
				});
				return stream;
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: options.settings,
			modelRegistry,
			role: "default",
			resolveFallbackModel: primaryModelKey =>
				options.resolveFallbackModel(primaryModelKey, modelRegistry, options.settings) ?? null,
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		return { session, events };
	}

	test("uses a modal-persisted fallback override during retry switching", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled fallback test models");
		}

		const rolesPath = path.join(tempDir.path(), "roles.yml");
		await fs.writeFile(
			rolesPath,
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);

		const rolesConfig = new RolesConfig(rolesPath);
		const sessionSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 5,
			"retry.maxRetriesBeforeFallback": 2,
			"model.defaultFallback": "openai/gpt-4o",
		});
		const modal = createConfigModal(rolesConfig, {
			modelRoles: { default: getModelKey(primaryModel) },
			values: { "model.defaultFallback": sessionSettings.get("model.defaultFallback") },
		});

		focusModelTab(modal);
		modal.handleInput("j");
		modal.handleInput(" ");

		expect(rolesConfig.getFallbackForRole("default")).toBe(getModelKey(fallbackModel));

		const { session: createdSession, events } = await createSession({
			streamSequence: [
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeErrorMessage("overloaded_error: overloaded"),
				() => makeSuccessMessage(fallbackModel.provider, fallbackModel.id),
			],
			settings: sessionSettings,
			resolveFallbackModel: (primaryModelKey, modelRegistry, settings) =>
				resolveFallbackModel("default", "default", false, rolesConfig, settings, modelRegistry, primaryModelKey),
		});
		session = createdSession;

		await session.prompt("Hello");

		const fallbackEvents = events.filter(event => event.type === "auto_retry_fallback");
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0]).toMatchObject({
			type: "auto_retry_fallback",
			fallbackModel: getModelKey(fallbackModel),
			primaryModel: getModelKey(primaryModel),
			role: "default",
		});
	});
});

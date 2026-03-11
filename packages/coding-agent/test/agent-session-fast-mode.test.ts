import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type ServiceTier } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession fast mode restrictions", () => {
	let tempDir: TempDir;
	let session: AgentSession;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fast-mode-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	function getModelOrThrow(provider: Parameters<typeof getBundledModel>[0], id: string) {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected model ${provider}/${id} to exist`);
		return model;
	}

	async function createSession(options: {
		provider: string;
		modelId: string;
		serviceTier?: ServiceTier;
	}): Promise<void> {
		const model = getModelOrThrow(options.provider, options.modelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});
		agent.serviceTier = options.serviceTier;
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	}

	it("clears priority service tier immediately for openai-codex sessions", async () => {
		await createSession({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			serviceTier: "priority",
		});

		expect(session.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("keeps fast mode disabled when explicitly requested on openai-codex", async () => {
		await createSession({
			provider: "openai-codex",
			modelId: "gpt-5.4",
		});

		session.setFastMode(true);

		expect(session.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("turns off priority when switching from another provider into openai-codex", async () => {
		await createSession({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		const codexModel = getModelOrThrow("openai-codex", "gpt-5.4");

		session.setFastMode(true);
		expect(session.isFastModeEnabled()).toBe(true);
		await session.setModel(codexModel);

		expect(session.model?.provider).toBe("openai-codex");
		expect(session.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);
	});
});

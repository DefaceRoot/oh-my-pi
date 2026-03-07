import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession role model thinking behavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionSettings: Settings;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-role-thinking-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(options: {
		initialModelId: string;
		initialThinkingLevel: Effort;
		modelRoles: Record<string, string>;
	}) {
		const model = getAnthropicModelOrThrow(options.initialModelId);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: options.initialThinkingLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		sessionSettings = Settings.isolated();
		for (const [role, modelRoleValue] of Object.entries(options.modelRoles)) {
			sessionSettings.setModelRole(role, modelRoleValue);
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	}

	it("re-applies explicit role thinking each time that role is selected", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const orchestratorModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				orchestrator: `${orchestratorModel.provider}/${orchestratorModel.id}:off`,
			},
		});

		const firstSwitch = await session.cycleRoleModels(["default", "orchestrator"]);
		expect(firstSwitch?.role).toBe("orchestrator");
		expect(firstSwitch?.model.id).toBe(orchestratorModel.id);
		expect(firstSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");

		session.setThinkingLevel(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		const secondSwitch = await session.cycleRoleModels(["default", "orchestrator"]);
		expect(secondSwitch?.role).toBe("default");
		expect(secondSwitch?.model.id).toBe(defaultModel.id);
		expect(session.thinkingLevel).toBe(Effort.High);

		const thirdSwitch = await session.cycleRoleModels(["default", "orchestrator"]);
		expect(thirdSwitch?.role).toBe("orchestrator");
		expect(thirdSwitch?.model.id).toBe(orchestratorModel.id);
		expect(thirdSwitch?.thinkingLevel).toBe("off");
		expect(session.thinkingLevel).toBe("off");
	});

	it("preserves current thinking when switching into default/no-suffix role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const orchestratorModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Low,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				orchestrator: `${orchestratorModel.provider}/${orchestratorModel.id}:high`,
			},
		});

		const toOrchestrator = await session.cycleRoleModels(["default", "orchestrator"]);
		expect(toOrchestrator?.role).toBe("orchestrator");
		expect(toOrchestrator?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);

		session.setThinkingLevel(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);

		const toDefault = await session.cycleRoleModels(["default", "orchestrator"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe(defaultModel.id);
		expect(toDefault?.thinkingLevel).toBe(Effort.Minimal);
		expect(session.thinkingLevel).toBe(Effort.Minimal);
	});

	it("applies orchestrator role thinking even when plan shares the same model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const exploreModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const orchestratorPlanModel = getAnthropicModelOrThrow("claude-opus-4-5");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.Medium,
			modelRoles: {
				default: `${defaultModel.provider}/${defaultModel.id}`,
				explore: `${exploreModel.provider}/${exploreModel.id}:low`,
				orchestrator: `${orchestratorPlanModel.provider}/${orchestratorPlanModel.id}:high`,
				plan: `${orchestratorPlanModel.provider}/${orchestratorPlanModel.id}:off`,
			},
		});

		const toExplore = await session.cycleRoleModels(["orchestrator", "default", "explore"]);
		expect(toExplore?.role).toBe("explore");
		expect(toExplore?.thinkingLevel).toBe(Effort.Low);
		expect(session.thinkingLevel).toBe(Effort.Low);

		const toOrchestrator = await session.cycleRoleModels(["orchestrator", "default", "explore"]);
		expect(toOrchestrator?.role).toBe("orchestrator");
		expect(toOrchestrator?.model.id).toBe(orchestratorPlanModel.id);
		expect(toOrchestrator?.thinkingLevel).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves explicit role thinking when updating default model despite unresolved previous model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const updatedModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		await createSession({
			initialModelId: defaultModel.id,
			initialThinkingLevel: Effort.High,
			modelRoles: {
				default: "anthropic/nonexistent-model:off",
			},
		});

		await session.setModel(updatedModel);

		expect(sessionSettings.getModelRole("default")).toBe(`${updatedModel.provider}/${updatedModel.id}:off`);
	});

	it("clamps unsupported selections from model metadata", async () => {
		const model = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth-non-xhigh.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-non-xhigh.yml"));

		sessionSettings = Settings.isolated();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getAvailableThinkingLevels()).not.toContain("xhigh");
	});
});

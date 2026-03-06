import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { DEFAULT_APP_KEYBINDINGS } from "../../config/keybindings";
import { _resetSettingsForTest, Settings } from "../../config/settings";
import { initTheme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { InputController } from "./input-controller";

type MainAgentRole = "default" | "ask" | "orchestrator" | "plan";

type AgentModeFixture = {
	controller: InputController;
	getLastRole: () => MainAgentRole | "custom";
	getCurrentModel: () => Model;
	invalidateSpy: ReturnType<typeof vi.fn>;
	showStatusSpy: ReturnType<typeof vi.fn>;
	showWarningSpy: ReturnType<typeof vi.fn>;
	showErrorSpy: ReturnType<typeof vi.fn>;
	setModelTemporarySpy: ReturnType<typeof vi.fn>;
	updateEditorBorderColorSpy: ReturnType<typeof vi.fn>;
};

function createModel(id: string, name: string): Model {
	return {
		provider: "anthropic",
		id,
		name,
		reasoning: true,
	} as unknown as Model;
}

function createAgentModeFixture(initialRole: MainAgentRole): AgentModeFixture {
	const models: Record<MainAgentRole, Model> = {
		default: createModel("default-model", "Default Model"),
		ask: createModel("ask-model", "Ask Model"),
		orchestrator: createModel("orchestrator-model", "Orchestrator Model"),
		plan: createModel("plan-model", "Plan Model"),
	};
	let lastRole: MainAgentRole | "custom" = initialRole;
	let currentModel = models[initialRole];
	const invalidateSpy = vi.fn();
	const showStatusSpy = vi.fn();
	const showWarningSpy = vi.fn();
	const showErrorSpy = vi.fn();
	const updateEditorBorderColorSpy = vi.fn();
	const setModelTemporarySpy = vi.fn(async (model: Model) => {
		currentModel = model;
		session.model = model;
	});
	const session = {
		isStreaming: false,
		model: currentModel,
		resolveRoleModel: (role: string) => {
			if (role === "default" || role === "ask" || role === "orchestrator" || role === "plan") {
				return models[role];
			}
			return undefined;
		},
		setModelTemporary: setModelTemporarySpy,
	} as unknown as InteractiveModeContext["session"];
	const sessionManager = {
		getLastModelChangeRole: () => lastRole,
		appendModelChange: (_modelRef: string, role: string) => {
			if (role === "default" || role === "ask" || role === "orchestrator" || role === "plan" || role === "custom") {
				lastRole = role;
			}
		},
	} as unknown as InteractiveModeContext["sessionManager"];
	const ctx = {
		session,
		sessionManager,
		statusLine: { invalidate: invalidateSpy },
		updateEditorBorderColor: updateEditorBorderColorSpy,
		showStatus: showStatusSpy,
		showWarning: showWarningSpy,
		showError: showErrorSpy,
	} as unknown as InteractiveModeContext;

	return {
		controller: new InputController(ctx),
		getLastRole: () => lastRole,
		getCurrentModel: () => currentModel,
		invalidateSpy,
		showStatusSpy,
		showWarningSpy,
		showErrorSpy,
		setModelTemporarySpy,
		updateEditorBorderColorSpy,
	};
}

describe("InputController agent mode cycling", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		_resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("binds Alt+A to main-agent cycling instead of ask-only toggle by default", () => {
		expect(DEFAULT_APP_KEYBINDINGS.cycleAgentMode).toBe("alt+a");
		expect(DEFAULT_APP_KEYBINDINGS.toggleAskMode).toEqual([]);
	});

	it("cycles default -> orchestrator -> plan -> ask -> default and updates session role state", async () => {
		const fixture = createAgentModeFixture("default");
		await Settings.init({
			inMemory: true,
			overrides: {
				modelRoles: {
					default: "anthropic/default-model",
					ask: "anthropic/ask-model",
					orchestrator: "anthropic/orchestrator-model",
					plan: "anthropic/plan-model",
				},
			},
		});

		await fixture.controller.cycleAgentMode();
		expect(fixture.getLastRole()).toBe("orchestrator");
		expect(fixture.getCurrentModel().id).toBe("orchestrator-model");

		await fixture.controller.cycleAgentMode();
		expect(fixture.getLastRole()).toBe("plan");
		expect(fixture.getCurrentModel().id).toBe("plan-model");

		await fixture.controller.cycleAgentMode();
		expect(fixture.getLastRole()).toBe("ask");
		expect(fixture.getCurrentModel().id).toBe("ask-model");

		await fixture.controller.cycleAgentMode();
		expect(fixture.getLastRole()).toBe("default");
		expect(fixture.getCurrentModel().id).toBe("default-model");
		expect(fixture.setModelTemporarySpy).toHaveBeenCalledTimes(4);
		expect(fixture.invalidateSpy).toHaveBeenCalledTimes(4);
		expect(fixture.updateEditorBorderColorSpy).toHaveBeenCalledTimes(4);
		expect(fixture.showWarningSpy).not.toHaveBeenCalled();
		expect(fixture.showErrorSpy).not.toHaveBeenCalled();
		expect(fixture.showStatusSpy).toHaveBeenCalledTimes(4);
	});
});

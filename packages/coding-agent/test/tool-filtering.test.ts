import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

type MainRole = "default" | "orchestrator" | "plan" | "ask";

const MANAGED_TOOL_NAMES = new Set([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)]);

const TEST_MODELS: Record<MainRole, string> = {
	default: "anthropic/claude-sonnet-4-5",
	orchestrator: "anthropic/claude-sonnet-4-5",
	plan: "anthropic/claude-sonnet-4-5",
	ask: "anthropic/claude-sonnet-4-5",
};

function normalizeManagedToolName(name: string): string {
	if (name === "puppeteer") return "browser";
	return name;
}

function expectedRoleManagedTools(role: MainRole): string[] {
	const expected = [...DEFAULT_ROLES_CONFIG.roles[role].tools];
	if (!expected.includes("ast_edit")) {
		const idx = expected.indexOf("resolve");
		if (idx >= 0) expected.splice(idx, 1);
	}
	const exitPlanModeIndex = expected.indexOf("exit_plan_mode");
	if (exitPlanModeIndex >= 0) expected.splice(exitPlanModeIndex, 1);
	const submitResultIndex = expected.indexOf("submit_result");
	if (submitResultIndex >= 0) expected.splice(submitResultIndex, 1);
	return expected.sort();
}

function toManagedToolSet(names: string[]): string[] {
	return names
		.map(normalizeManagedToolName)
		.filter(name => MANAGED_TOOL_NAMES.has(name))
		.sort();
}

function createModel(id: string, name: string): Model {
	return {
		provider: "anthropic",
		id,
		name,
		reasoning: true,
	} as unknown as Model;
}

describe("tool filtering (Phase 2 RED)", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		_resetSettingsForTest();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	async function createSessionForRole(
		role: MainRole,
		overrides: {
			settings?: Settings;
			requireSubmitResultTool?: boolean;
		} = {},
	): Promise<AgentSession> {
		const tempDir = path.join(os.tmpdir(), `pi-tool-filtering-red-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(TEST_MODELS[role], role);

		const settings = overrides.settings ?? Settings.isolated({ "async.enabled": true });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings,
			hasUI: true,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			requireSubmitResultTool: overrides.requireSubmitResultTool,
		});
		sessions.push(session);
		return session;
	}

	for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
		it(`starts ${role} mode with role-specific managed tool allowlist`, async () => {
			const session = await createSessionForRole(role);
			const expected = expectedRoleManagedTools(role);
			const actual = toManagedToolSet(session.getActiveToolNames());

			expect(actual).toEqual(expected);
		});
	}

	it("allows explicit settings override to add tool outside role default", async () => {
		const baseline = await createSessionForRole("ask");
		expect(toManagedToolSet(baseline.getActiveToolNames())).not.toContain("calc");

		const settingsWithOverride = Settings.isolated({ "async.enabled": true });
		settingsWithOverride.set("calc.enabled", true);
		const withOverride = await createSessionForRole("ask", { settings: settingsWithOverride });
		expect(toManagedToolSet(withOverride.getActiveToolNames())).toContain("calc");
	});

	it("allows settings override to remove tool from role default", async () => {
		const baseline = await createSessionForRole("default");
		expect(toManagedToolSet(baseline.getActiveToolNames())).toContain("find");

		const settingsWithOverride = Settings.isolated({ "find.enabled": false });
		const withOverride = await createSessionForRole("default", { settings: settingsWithOverride });
		expect(toManagedToolSet(withOverride.getActiveToolNames())).not.toContain("find");
	});

	it("keeps hidden tools available even when role defaults exclude them", async () => {
		const session = await createSessionForRole("ask", { requireSubmitResultTool: true });
		expect(toManagedToolSet(session.getActiveToolNames())).toContain("submit_result");
	});

	it("expands managed tools when switching from ask to default role", async () => {
		const session = await createSessionForRole("ask");
		expect(toManagedToolSet(session.getActiveToolNames())).not.toContain("write");

		if (!session.model) {
			throw new Error("Expected session model to be available");
		}
		await session.setModelTemporary(session.model, "default");

		expect(toManagedToolSet(session.getActiveToolNames())).toContain("write");
	});

	it("rebuilds active tool allowlist when mode switches", async () => {
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

		const models: Record<MainRole, Model> = {
			default: createModel("default-model", "Default Model"),
			ask: createModel("ask-model", "Ask Model"),
			orchestrator: createModel("orchestrator-model", "Orchestrator Model"),
			plan: createModel("plan-model", "Plan Model"),
		};

		let lastRole: MainRole | "custom" = "default";
		const setActiveToolsByNameSpy = vi.fn(async (_toolNames: string[]) => {});

		const session = {
			isStreaming: false,
			model: models.default,
			resolveRoleModel: (role: string) => {
				if (role === "default" || role === "ask" || role === "orchestrator" || role === "plan") {
					return models[role];
				}
				return undefined;
			},
			setModelTemporary: vi.fn(async (model: Model, role?: string) => {
				(session as { model: Model }).model = model;
				if (role === "default" || role === "ask" || role === "orchestrator" || role === "plan") {
					await setActiveToolsByNameSpy(expectedRoleManagedTools(role));
				}
			}),
			getActiveToolNames: () => [...DEFAULT_ROLES_CONFIG.roles.default.tools],
			setActiveToolsByName: setActiveToolsByNameSpy,
		} as unknown as InteractiveModeContext["session"];

		const sessionManager = {
			getLastModelChangeRole: () => lastRole,
			appendModelChange: (_modelRef: string, role: string) => {
				if (
					role === "default" ||
					role === "ask" ||
					role === "orchestrator" ||
					role === "plan" ||
					role === "custom"
				) {
					lastRole = role;
				}
			},
		} as unknown as InteractiveModeContext["sessionManager"];

		const controller = new InputController({
			session,
			sessionManager,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		await controller.cycleAgentMode();
		expect(session.setModelTemporary).toHaveBeenCalledWith(models.orchestrator, "orchestrator");
		expect(setActiveToolsByNameSpy).toHaveBeenCalled();
		const roleToolNames = setActiveToolsByNameSpy.mock.calls.at(-1)?.[0] as string[];
		expect([...roleToolNames].sort()).toEqual(expectedRoleManagedTools("orchestrator"));
	});
});

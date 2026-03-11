import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool, LoadedCustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { measureStartupTokenBudgets } from "../../../scripts/measure-startup-tokens";

type MainRole = "default" | "orchestrator" | "plan" | "ask";

const ROLE_TOOL_COUNT_TARGETS: Record<MainRole, number> = {
	default: 22,
	orchestrator: 6,
	plan: 20,
	ask: 7,
};

const ROLE_TOKEN_BUDGET_TARGETS: Record<MainRole, number> = {
	default: 15_000,
	orchestrator: 12_000,
	plan: 14_000,
	ask: 8_000,
};

const HYBRID_MANAGED_STARTUP_BASELINE_TARGETS: Record<"default" | "plan", number> = {
	default: 15_000,
	plan: 14_000,
};

type StartupBudgetRow = Awaited<ReturnType<typeof measureStartupTokenBudgets>>[number];

async function measureManagedStartupRowsForHybridBudget(): Promise<Map<MainRole, StartupBudgetRow>> {
	const previousNodeEnv = process.env.NODE_ENV;
	const previousBunEnv = process.env.BUN_ENV;
	process.env.NODE_ENV = "test";
	process.env.BUN_ENV = "test";
	try {
		const rows = await measureStartupTokenBudgets({ cwd: os.tmpdir() });
		return new Map(rows.map(row => [row.mode, row]));
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
		if (previousBunEnv === undefined) delete process.env.BUN_ENV;
		else process.env.BUN_ENV = previousBunEnv;
	}
}

const TEST_SKILLS: Skill[] = [
	{
		name: "brainstorming",
		description: "Planning skill",
		filePath: "/tmp/skills/brainstorming/SKILL.md",
		baseDir: "/tmp/skills/brainstorming",
		source: "test",
	},
	{
		name: "commit-hygiene",
		description: "Workflow skill",
		filePath: "/tmp/skills/commit-hygiene/SKILL.md",
		baseDir: "/tmp/skills/commit-hygiene",
		source: "test",
	},
	{
		name: "agent-browser",
		description: "Infra skill",
		filePath: "/tmp/skills/agent-browser/SKILL.md",
		baseDir: "/tmp/skills/agent-browser",
		source: "test",
	},
	{
		name: "simplify",
		description: "Implementation skill",
		filePath: "/tmp/skills/simplify/SKILL.md",
		baseDir: "/tmp/skills/simplify",
		source: "test",
	},
];

const MANAGED_TOOL_NAMES = new Set([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)]);
const mockedLoadedTools: LoadedCustomTool[] = [];

const mockedMcpManager = {
	setNotificationsEnabled: () => {},
	setOnToolsChanged: () => {},
	setOnPromptsChanged: () => {},
	setOnResourcesChanged: () => {},
	getServerInstructions: () => new Map<string, string>(),
	getTools: () => mockedLoadedTools.map(tool => tool.tool),
};

mock.module("@oh-my-pi/pi-coding-agent/mcp", () => ({
	discoverAndLoadMCPTools: async () => ({
		manager: mockedMcpManager,
		tools: mockedLoadedTools,
		errors: [],
		connectedServers: ["augment", "grafana", "chrome-devtools"],
		exaApiKeys: [],
	}),
}));

const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");

function createMockMcpTool(name: string, serverName: string): LoadedCustomTool {
	return {
		path: `mcp:${serverName}`,
		resolvedPath: `mcp:${name}`,
		tool: {
			name,
			label: name,
			description: `${serverName} test tool`,
			parameters: Type.Object({}),
			renderCall: () => "",
			renderResult: () => "",
			execute: async () => ({
				content: [{ type: "text" as const, text: `${name} ok` }],
			}),
			mcpServerName: serverName,
			mcpToolName: name,
		} as any,
	};
}

function createMockCustomTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: `${name} custom tool`,
		parameters: Type.Object({}),
		renderCall: () => null as any,
		renderResult: () => null as any,
		execute: async () => ({
			content: [{ type: "text" as const, text: `${name} ok` }],
		}),
	} as any;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function normalizeManagedToolName(name: string): string {
	if (name === "puppeteer") return "browser";
	return name;
}

function toManagedToolSet(names: string[]): string[] {
	return names.map(normalizeManagedToolName).filter(name => MANAGED_TOOL_NAMES.has(name));
}

function expectedStartupManagedToolCount(role: MainRole): number {
	const expected = [...DEFAULT_ROLES_CONFIG.roles[role].tools];
	if (!expected.includes("ast_edit")) {
		const resolveIndex = expected.indexOf("resolve");
		if (resolveIndex >= 0) expected.splice(resolveIndex, 1);
	}
	const exitPlanModeIndex = expected.indexOf("exit_plan_mode");
	if (exitPlanModeIndex >= 0) expected.splice(exitPlanModeIndex, 1);
	const submitResultIndex = expected.indexOf("submit_result");
	if (submitResultIndex >= 0) expected.splice(submitResultIndex, 1);
	return expected.length;
}

function createRoleTools(role: MainRole): Map<string, { label: string; description: string }> {
	return new Map(
		DEFAULT_ROLES_CONFIG.roles[role].tools.map(name => [name, { label: name, description: `${name} test tool` }]),
	);
}

function assertToolGuidanceExclusions(prompt: string, role: MainRole): void {
	const available = new Set(DEFAULT_ROLES_CONFIG.roles[role].tools);
	if (!available.has("edit")) {
		expect(prompt).not.toContain("**Edit tool**");
	}
	if (!available.has("lsp")) {
		expect(prompt).not.toContain("### LSP knows; grep guesses");
	}
	if (!available.has("ssh")) {
		expect(prompt).not.toContain("### SSH: match commands to host shell");
	}
	if (!available.has("task")) {
		expect(prompt).not.toContain("parallelizable via Task tool");
	}
	if (!available.has("ast_grep") && !available.has("ast_edit")) {
		expect(prompt).not.toContain("### AST tools for structural code work");
	}
}

async function renderPromptForRole(role: MainRole): Promise<string> {
	return await buildSystemPrompt({
		mode: role,
		cwd: os.tmpdir(),
		tools: createRoleTools(role),
		skills: TEST_SKILLS,
		rules: [],
	});
}

function getActiveMcpServerNames(activeToolNames: string[]): string[] {
	const serverNames = new Set<string>();
	for (const toolName of activeToolNames) {
		if (!toolName.startsWith("mcp_")) continue;
		if (toolName.startsWith("mcp_augment_")) serverNames.add("augment");
		if (toolName.startsWith("mcp_grafana_")) serverNames.add("grafana");
		if (toolName.startsWith("mcp_chrome_devtools_")) serverNames.add("chrome-devtools");
	}
	return [...serverNames].sort();
}

describe("Phase 6 RED: per-mode startup integration contracts", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		_resetSettingsForTest();
		mockedLoadedTools.splice(0);
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionForRole(
		role: MainRole,
		options: {
			customTools?: CustomTool[];
		} = {},
	): Promise<AgentSession> {
		const tempDir = path.join(os.tmpdir(), `pi-token-budget-phase6-red-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", role);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: true,
			enableMCP: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			customTools: options.customTools,
		});
		sessions.push(session);
		return session;
	}

	it("keeps planned per-mode tool-count defaults in roles config", () => {
		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			expect(DEFAULT_ROLES_CONFIG.roles[role].tools).toHaveLength(ROLE_TOOL_COUNT_TARGETS[role]);
		}
	});

	it("starts each mode with the expected role-filtered managed tool count", async () => {
		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			const session = await createSessionForRole(role);
			const managedCount = toManagedToolSet(session.getActiveToolNames()).length;
			expect(managedCount).toBe(expectedStartupManagedToolCount(role));
		}
	});

	it("filters startup MCP tools to each role's allowlist", async () => {
		mockedLoadedTools.push(
			createMockMcpTool("mcp_augment_codebase_retrieval", "augment"),
			createMockMcpTool("mcp_grafana_list_datasources", "grafana"),
			createMockMcpTool("mcp_chrome_devtools_click", "chrome-devtools"),
		);

		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			const session = await createSessionForRole(role);
			const activeServers = getActiveMcpServerNames(session.getActiveToolNames());
			expect(activeServers).toEqual(DEFAULT_ROLES_CONFIG.roles[role].mcp);
		}
	});

	it("rebuilds switched-role prompts for the selected role instead of default fallback", async () => {
		const session = await createSessionForRole("default");
		expect(session.systemPrompt).toContain("# Design Integrity");

		if (!session.model) {
			throw new Error("Expected session model to be available");
		}
		await session.setModelTemporary(session.model, "ask");

		expect(session.systemPrompt).not.toContain("# Design Integrity");
		expect(session.systemPrompt).not.toContain("## 2. Before You Edit");
	});

	it("reapplies role filtering to the full active set when switching modes", async () => {
		const outOfRoleTool = "custom_extra_role_switch";
		const session = await createSessionForRole("default", {
			customTools: [createMockCustomTool(outOfRoleTool)],
		});
		expect(session.getActiveToolNames()).toContain(outOfRoleTool);

		const defaultOnlyActiveTool = session
			.getActiveToolNames()
			.find(
				name =>
					DEFAULT_ROLES_CONFIG.roles.default.tools.includes(name) &&
					!DEFAULT_ROLES_CONFIG.roles.ask.tools.includes(name),
			);
		expect(defaultOnlyActiveTool).toBeDefined();

		if (!session.model) {
			throw new Error("Expected session model to be available");
		}
		await session.setModelTemporary(session.model, "ask");

		expect(session.getActiveToolNames()).not.toContain(outOfRoleTool);
		if (!defaultOnlyActiveTool) {
			throw new Error("Expected at least one default-only active tool before switch");
		}
		expect(session.getActiveToolNames()).not.toContain(defaultOnlyActiveTool);
	});

	it("omits excluded tool guidance and excluded skills from each rendered mode prompt", async () => {
		const prompts = {
			default: await renderPromptForRole("default"),
			orchestrator: await renderPromptForRole("orchestrator"),
			plan: await renderPromptForRole("plan"),
			ask: await renderPromptForRole("ask"),
		};

		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			assertToolGuidanceExclusions(prompts[role], role);
		}

		expect(prompts.default.includes("## brainstorming")).toBe(true);
		expect(prompts.default.includes("## commit-hygiene")).toBe(true);
		expect(prompts.default.includes("## agent-browser")).toBe(true);
		expect(prompts.default.includes("## simplify")).toBe(true);

		expect(prompts.orchestrator.includes("## commit-hygiene")).toBe(true);
		expect(prompts.orchestrator.includes("## agent-browser")).toBe(true);
		expect(prompts.orchestrator.includes("## brainstorming")).toBe(false);
		expect(prompts.orchestrator.includes("## simplify")).toBe(false);

		expect(prompts.plan.includes("## brainstorming")).toBe(true);
		expect(prompts.plan.includes("## commit-hygiene")).toBe(true);
		expect(prompts.plan.includes("## agent-browser")).toBe(false);
		expect(prompts.plan.includes("## simplify")).toBe(false);

		expect(prompts.ask.includes("## brainstorming")).toBe(false);
		expect(prompts.ask.includes("## commit-hygiene")).toBe(false);
		expect(prompts.ask.includes("## agent-browser")).toBe(false);
		expect(prompts.ask.includes("## simplify")).toBe(false);
	});
});

describe("Phase 6 RED: startup token benchmark script contract", () => {
	it("measures startup prompt tokens against the real active startup payload", async () => {
		const rows = await measureStartupTokenBudgets({ cwd: os.tmpdir() });
		const rowsByMode = new Map(rows.map(row => [row.mode, row]));

		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			const tempDir = path.join(os.tmpdir(), `pi-token-budget-runtime-red-${Snowflake.next()}`);
			await fs.mkdir(tempDir, { recursive: true });
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", role);

			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager,
				settings: Settings.isolated({ "async.enabled": true }),
				hasUI: true,
				enableMCP: false,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skipPythonPreflight: true,
			});

			try {
				const measuredRow = rowsByMode.get(role);
				expect(measuredRow).toBeDefined();
				if (!measuredRow) {
					throw new Error(`Missing measurement row for ${role}`);
				}

				const runtimePromptTokens = estimateTextTokens(session.systemPrompt);
				expect(measuredRow.promptTokens).toBeGreaterThanOrEqual(Math.floor(runtimePromptTokens * 0.9));
				expect(measuredRow.promptTokens).toBeLessThanOrEqual(Math.ceil(runtimePromptTokens * 1.1));
			} finally {
				await session.dispose();
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("requires a startup token measurement script that reports per-mode totals and budget targets", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const scriptRelativePath = "scripts/measure-startup-tokens.ts";
		const scriptPath = path.join(repoRoot, scriptRelativePath);

		expect(await Bun.file(scriptPath).exists()).toBe(true);
		if (!(await Bun.file(scriptPath).exists())) {
			return;
		}

		const run = Bun.spawnSync(["bun", "run", scriptRelativePath], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...Bun.env,
				BUN_ENV: "test",
			},
		});
		const output = `${Buffer.from(run.stdout).toString("utf8")}\n${Buffer.from(run.stderr).toString("utf8")}`;
		expect(run.exitCode).toBe(0);
		expect(output.toLowerCase()).toContain("mode");
		expect(output.toLowerCase()).toContain("total");
		expect(output.toLowerCase()).toContain("target");

		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			expect(output.toLowerCase()).toContain(role);
			expect(output).toContain(String(ROLE_TOKEN_BUDGET_TARGETS[role]));
		}
	});
});


describe("Phase 6 RED: hybrid managed startup baseline budgets", () => {
	it("keeps default managed startup payload within the intended baseline target", async () => {
		const rowsByMode = await measureManagedStartupRowsForHybridBudget();
		const defaultRow = rowsByMode.get("default");
		expect(defaultRow).toBeDefined();
		if (!defaultRow) throw new Error("Missing managed startup measurement row for default");
		expect(defaultRow.totalTokens).toBeLessThanOrEqual(HYBRID_MANAGED_STARTUP_BASELINE_TARGETS.default);
	});

	it("keeps plan managed startup payload within the intended baseline target", async () => {
		const rowsByMode = await measureManagedStartupRowsForHybridBudget();
		const planRow = rowsByMode.get("plan");
		expect(planRow).toBeDefined();
		if (!planRow) throw new Error("Missing managed startup measurement row for plan");
		expect(planRow.totalTokens).toBeLessThanOrEqual(HYBRID_MANAGED_STARTUP_BASELINE_TARGETS.plan);
	});
});

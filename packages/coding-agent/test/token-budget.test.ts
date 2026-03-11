import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import {
	formatStartupTokenBudgetReport,
	measureStartupTokenBudgets,
	STARTUP_TOKEN_BUDGET_TARGETS,
} from "../../../scripts/measure-startup-tokens";

type MainRole = "default" | "orchestrator" | "plan" | "ask";

const ROLE_TOOL_COUNT_TARGETS: Record<MainRole, number> = {
	default: 22,
	orchestrator: 6,
	plan: 20,
	ask: 7,
};

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
		contextFiles: [],
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

describe("token budget startup integration", () => {
	const sessions: Array<{ dispose: () => Promise<void> }> = [];
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
	): Promise<{ getActiveToolNames: () => string[]; dispose: () => Promise<void> }> {
		const tempDir = path.join(os.tmpdir(), `pi-token-budget-green-${Snowflake.next()}`);
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
		});
		sessions.push(session);
		return session as any;
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

describe("token budget benchmark reporting", () => {
	it("measures per-mode totals against startup targets", async () => {
		const rows = await measureStartupTokenBudgets();
		expect(rows.map(row => row.mode).sort()).toEqual(["ask", "default", "orchestrator", "plan"]);

		for (const row of rows) {
			expect(row.targetTokens).toBe(STARTUP_TOKEN_BUDGET_TARGETS[row.mode]);
			expect(row.promptTokens).toBeGreaterThan(0);
			expect(row.toolSchemaTokens).toBeGreaterThan(0);
			expect(row.totalTokens).toBe(row.promptTokens + row.toolSchemaTokens);
			expect(typeof row.withinBudget).toBe("boolean");
		}
	});

	it("formats report with mode, total, and target columns", async () => {
		const report = formatStartupTokenBudgetReport(await measureStartupTokenBudgets());
		expect(report.toLowerCase()).toContain("mode");
		expect(report.toLowerCase()).toContain("total");
		expect(report.toLowerCase()).toContain("target");
		for (const mode of ["default", "orchestrator", "plan", "ask"] as const) {
			expect(report.toLowerCase()).toContain(mode);
			expect(report).toContain(String(STARTUP_TOKEN_BUDGET_TARGETS[mode]));
		}
	});
});

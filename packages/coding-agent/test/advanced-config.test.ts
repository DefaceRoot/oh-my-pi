import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { RolesConfig } from "../src/config/roles-config";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import type { SingleResult } from "../src/task/types";
import { createConfigModal, initConfigModalTheme, openAdvancedTab } from "./increment2-config-modal-test-utils";

const capturedCalls: Array<{ agent: string; advancedConfig: unknown }> = [];

const stubResult: SingleResult = {
	index: 0,
	id: "Task",
	agent: "explore",
	agentSource: "bundled",
	task: "stub",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 1,
};

mock.module("../src/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
	runSubprocess: async (opts: Record<string, unknown>) => {
		const agent = opts.agent as { name?: string };
		capturedCalls.push({
			agent: agent.name ?? "unknown",
			advancedConfig: opts.advancedConfig,
		});
		return { ...stubResult, agent: agent.name ?? "unknown" };
	},
}));

mock.module("../src/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{
				name: "explore",
				description: "explore",
				source: "bundled",
				model: "default",
				systemPrompt: "",
				tools: ["read"],
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("../src/task");

describe("advanced configuration integration", () => {
	let tempDir: string;

	beforeAll(() => {
		initConfigModalTheme();
	});

	beforeEach(() => {
		capturedCalls.length = 0;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-advanced-config-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function createTaskSession(overrides: Record<string, unknown> = {}) {
		const settingsValues: Record<string, unknown> = {
			"task.isolation.mode": "none",
			"task.maxConcurrency": 2,
			"task.disabledAgents": [],
			"task.agentModelOverrides": {},
		};

		return {
			cwd: tempDir,
			hasUI: false,
			settings: {
				get: (key: string) => settingsValues[key],
				getAgentDir: () => tempDir,
				getModelRole: () => undefined,
			},
			getSessionFile: () => "/tmp/test-session.jsonl",
			getSessionSpawns: () => "*",
			taskDepth: 0,
			mcpManager: {
				getTools: () => [],
				getServerInstructions: () => new Map(),
				waitForConnection: async () => ({ name: "mock" }),
			},
			...overrides,
		} as unknown as Parameters<typeof TaskTool.create>[0];
	}

	test("applies a role override persisted through the advanced tab when creating a session", async () => {
		const rolesPath = path.join(tempDir, "roles.yml");
		await fs.promises.writeFile(
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
		const modal = createConfigModal(rolesConfig, {
			values: {
				defaultThinkingLevel: "high",
				"task.maxRecursionDepth": 2,
				"compaction.strategy": "context-full",
				temperature: 0.7,
			},
		});

		openAdvancedTab(modal);
		modal.handleInput(" ");
		modal.handleInput("j");
		modal.handleInput("\n");
		modal.handleInput("5");
		modal.handleInput("\n");

		expect(rolesConfig.getAdvancedForRole("default")).toEqual({
			thinkingLevel: "off",
			maxRecursionDepth: 5,
		});

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "default",
		});

		expect(session.thinkingLevel).toBe("off" as ThinkingLevel);
		expect(session.settings.get("task.maxRecursionDepth")).toBe(5);
	});

	test("forwards modal-persisted subagent advanced overrides through task dispatch", async () => {
		const rolesPath = path.join(tempDir, "roles.yml");
		await fs.promises.writeFile(
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
  explore:
    mcp:
      - augment
    advanced:
      thinkingLevel: low
      temperature: 0.7
`,
			"utf8",
		);

		const rolesConfig = new RolesConfig(rolesPath);
		const modal = createConfigModal(rolesConfig, {
			values: {
				defaultThinkingLevel: "high",
				"task.maxRecursionDepth": 2,
				"compaction.strategy": "context-full",
				temperature: -1,
			},
		});

		for (let i = 0; i < 8; i++) {
			modal.handleInput("j");
		}
		openAdvancedTab(modal);
		modal.handleInput(" ");
		modal.handleInput("j");
		modal.handleInput("\n");
		modal.handleInput("4");
		modal.handleInput("\n");

		expect(rolesConfig.getAdvancedForSubagent("explore")).toEqual({
			thinkingLevel: "medium",
			maxRecursionDepth: 4,
			temperature: 0.7,
		});

		const tool = await TaskTool.create(createTaskSession());
		await tool.execute("call-explore-advanced", {
			agent: "explore",
			tasks: [{ id: "ExploreAdvanced", description: "explore", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]).toEqual({
			agent: "explore",
			advancedConfig: {
				thinkingLevel: "medium",
				maxRecursionDepth: 4,
				temperature: 0.7,
			},
		});
	});
});

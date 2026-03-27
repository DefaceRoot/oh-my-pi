import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RolesConfig } from "../src/config/roles-config";
import { PLAN_MODE_SUBAGENT_TOOLS } from "../src/task/plan-mode-tools";
import type { SingleResult } from "../src/task/types";
import { createConfigModal, initConfigModalTheme, openToolsTab } from "./increment2-config-modal-test-utils";

const capturedCalls: Array<{ agentName: string; agentTools: string[] | undefined }> = [];

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
		const agent = opts.agent as { name?: string; tools?: string[] };
		capturedCalls.push({
			agentName: agent.name ?? "unknown",
			agentTools: agent.tools,
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
				tools: ["bash", "read"],
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("../src/task");

describe("tools configuration integration", () => {
	let agentDir: string;

	beforeAll(() => {
		initConfigModalTheme();
	});

	beforeEach(() => {
		capturedCalls.length = 0;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tools-config-"));
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	function createSession(overrides: Record<string, unknown> = {}) {
		const settingsValues: Record<string, unknown> = {
			"task.isolation.mode": "none",
			"task.maxConcurrency": 2,
			"task.disabledAgents": [],
			"task.agentModelOverrides": {},
		};

		return {
			cwd: "/tmp/test-cwd",
			hasUI: false,
			settings: {
				get: (key: string) => settingsValues[key],
				getAgentDir: () => agentDir,
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

	async function writeRoles(): Promise<RolesConfig> {
		const rolesPath = path.join(agentDir, "roles.yml");
		await fs.promises.writeFile(
			rolesPath,
			`roles:
  default:
    tools:
      - read
      - write
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
`,
			"utf8",
		);
		return new RolesConfig(rolesPath);
	}

	test("dispatches a subagent tool list persisted through the modal", async () => {
		const rolesConfig = await writeRoles();
		const modal = createConfigModal(rolesConfig, {
			subagentDefaultTools: { explore: ["read", "grep"] },
			knownTools: ["grep"],
		});

		for (let i = 0; i < 8; i++) {
			modal.handleInput("j");
		}
		openToolsTab(modal);
		modal.handleInput("j");
		modal.handleInput(" ");

		expect(rolesConfig.getFullConfig().subagents.explore?.tools).toEqual(["grep"]);

		const tool = await TaskTool.create(createSession());
		await tool.execute("call-explore-tools", {
			agent: "explore",
			tasks: [{ id: "ExploreTools", description: "explore", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]).toEqual({ agentName: "explore", agentTools: ["grep"] });
	});

	test("plan mode still overrides a modal-persisted subagent tool list", async () => {
		const rolesConfig = await writeRoles();
		const modal = createConfigModal(rolesConfig, {
			subagentDefaultTools: { explore: ["read", "grep"] },
			knownTools: ["grep"],
		});

		for (let i = 0; i < 8; i++) {
			modal.handleInput("j");
		}
		openToolsTab(modal);
		modal.handleInput("j");
		modal.handleInput(" ");

		expect(rolesConfig.getFullConfig().subagents.explore?.tools).toEqual(["grep"]);

		const tool = await TaskTool.create(createSession({ getPlanModeState: () => ({ enabled: true }) }));
		await tool.execute("call-explore-tools-plan", {
			agent: "explore",
			tasks: [{ id: "ExploreToolsPlan", description: "explore", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agentTools).toEqual([...PLAN_MODE_SUBAGENT_TOOLS]);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { PLAN_MODE_PLAN_VERIFIER_TOOLS, PLAN_MODE_SUBAGENT_TOOLS } from "../../src/task/plan-mode-tools";

type CapturedCall = { agentName: string; agentTools: string[] | undefined };

const capturedCalls: CapturedCall[] = [];

const stubResult: SingleResult = {
	index: 0,
	id: "Task",
	agent: "worker",
	agentSource: "bundled",
	task: "stub",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 1,
};

// Per-test override: maps agent name → tools returned by getToolsForSubagent (null = no config)
const toolsReturnValues = new Map<string, string[] | null>();

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
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

const discoveredAgents = [
	{ name: "worker", description: "worker agent", source: "bundled", model: "default", systemPrompt: "", tools: ["bash", "read"] },
	{ name: "plan-verifier", description: "plan verifier", source: "bundled", model: "default", systemPrompt: "", tools: ["read"] },
];

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({ agents: discoveredAgents, projectAgentsDir: null }),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(a => a.name === name) ?? null,
}));

mock.module("@oh-my-pi/pi-coding-agent/config/roles-config", () => ({
	RolesConfig: class {
		constructor(_path: string) {}

		getToolsForSubagent(agent: string): string[] | null {
			return toolsReturnValues.has(agent) ? (toolsReturnValues.get(agent) ?? null) : null;
		}
		getMcpForSubagent(_agent: string): string[] {
			return [];
		}
		getSkillConfigForSubagent(_agent: string): undefined {
			return undefined;
		}
	},
	// model-registry.ts re-exports these; the mock must export them to satisfy static checks
	RolesConfigFile: { relocate: () => ({}) },
	DEFAULT_ROLES_CONFIG: { roles: {}, subagents: {} },
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createSession(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 2,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
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

describe("tools config wiring into subagent dispatch", () => {
	beforeEach(() => {
		capturedCalls.length = 0;
		toolsReturnValues.clear();
	});

	test("subagent receives resolved tool list from roles.yml in non-plan mode", async () => {
		toolsReturnValues.set("worker", ["read", "grep", "ast_grep"]);
		const tool = await TaskTool.create(createSession());
		await tool.execute("call-worker", {
			agent: "worker",
			tasks: [{ id: "WorkerTask", description: "worker", assignment: "noop" }],
		});
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agentTools).toEqual(["read", "grep", "ast_grep"]);
	});

	test("falls back to agent.tools when roles.yml returns null for the subagent", async () => {
		// No entry in toolsReturnValues → getToolsForSubagent returns null → use agent.tools
		const tool = await TaskTool.create(createSession());
		await tool.execute("call-worker-fallback", {
			agent: "worker",
			tasks: [{ id: "WorkerFallback", description: "worker", assignment: "noop" }],
		});
		expect(capturedCalls).toHaveLength(1);
		// agent.tools from the discovered agent definition is ["bash", "read"]
		expect(capturedCalls[0]?.agentTools).toEqual(["bash", "read"]);
	});

	test("empty tool list from roles.yml is used as-is (intentionally empty, not treated as null)", async () => {
		toolsReturnValues.set("worker", []);
		const tool = await TaskTool.create(createSession());
		await tool.execute("call-worker-empty", {
			agent: "worker",
			tasks: [{ id: "WorkerEmpty", description: "worker", assignment: "noop" }],
		});
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agentTools).toEqual([]);
	});

	test("plan mode overrides roles.yml: subagent gets PLAN_MODE_SUBAGENT_TOOLS", async () => {
		// roles.yml would normally provide rich tools
		toolsReturnValues.set("worker", ["bash", "edit", "write"]);
		const tool = await TaskTool.create(
			createSession({ getPlanModeState: () => ({ enabled: true }) }),
		);
		await tool.execute("call-worker-plan", {
			agent: "worker",
			tasks: [{ id: "WorkerPlan", description: "worker", assignment: "noop" }],
		});
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agentTools).toEqual([...PLAN_MODE_SUBAGENT_TOOLS]);
	});

	test("plan-verifier gets PLAN_MODE_PLAN_VERIFIER_TOOLS regardless of roles.yml config", async () => {
		// roles.yml would normally provide rich tools for plan-verifier
		toolsReturnValues.set("plan-verifier", ["bash", "edit", "write"]);
		const tool = await TaskTool.create(
			createSession({ getPlanModeState: () => ({ enabled: true }) }),
		);
		await tool.execute("call-verifier", {
			agent: "plan-verifier",
			tasks: [{ id: "VerifierTask", description: "plan-verifier", assignment: "noop" }],
		});
		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agentTools).toEqual([...PLAN_MODE_PLAN_VERIFIER_TOOLS]);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const capturedCalls: Array<{ agent: string; mcpManager: unknown }> = [];

const stubResult: SingleResult = {
	index: 0,
	id: "Task",
	agent: "designer",
	agentSource: "bundled",
	task: "stub",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 1,
};

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (opts: Record<string, unknown>) => {
		const agent = opts.agent as { name?: string };
		capturedCalls.push({ agent: agent.name ?? "unknown", mcpManager: opts.mcpManager });
		return { ...stubResult, agent: agent.name ?? "unknown" };
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{ name: "designer", description: "designer", source: "bundled", model: "default", systemPrompt: "" },
			{ name: "grafana", description: "grafana", source: "bundled", model: "default", systemPrompt: "" },
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createFakeMcpTool(name: string, serverName: string) {
	return {
		name,
		label: name,
		description: `${serverName} tool`,
		parameters: Type.Object({}),
		renderCall: () => "",
		renderResult: () => "",
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		mcpServerName: serverName,
		mcpToolName: name,
	};
}

const parentMcpManager = {
	getTools: () => [
		createFakeMcpTool("mcp_augment_codebase_retrieval", "augment"),
		createFakeMcpTool("mcp_chrome_devtools_click", "chrome-devtools"),
		createFakeMcpTool("mcp_grafana_list_datasources", "grafana"),
	],
	waitForConnection: async () => ({ name: "mock-connection" }),
};

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
		mcpManager: parentMcpManager,
		...overrides,
	} as Parameters<typeof TaskTool.create>[0];
}

function managerToolNames(value: unknown): string[] {
	const manager = value as { getTools?: () => Array<{ name: string }> };
	if (!manager?.getTools) return [];
	return manager.getTools().map(tool => tool.name).sort();
}

describe("Phase 3 RED: subagent MCP filtering", () => {
	beforeEach(() => {
		capturedCalls.length = 0;
	});

	test("passes augment + chrome-devtools MCP tools to designer subagent", async () => {
		const tool = await TaskTool.create(createSession());

		await tool.execute("call-designer", {
			agent: "designer",
			tasks: [{ id: "DesignerTask", description: "designer", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(managerToolNames(capturedCalls[0]?.mcpManager)).toEqual([
			"mcp_augment_codebase_retrieval",
			"mcp_chrome_devtools_click",
		]);
	});

	test("passes augment + grafana MCP tools to grafana subagent", async () => {
		const tool = await TaskTool.create(createSession());

		await tool.execute("call-grafana", {
			agent: "grafana",
			tasks: [{ id: "GrafanaTask", description: "grafana", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(managerToolNames(capturedCalls[0]?.mcpManager)).toEqual([
			"mcp_augment_codebase_retrieval",
			"mcp_grafana_list_datasources",
		]);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Type } from "@sinclair/typebox";

const capturedCalls: Array<{ agent: string; mcpManager: unknown }> = [];

mock.module("../../src/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
	runSubprocess: async (opts: Record<string, unknown>) => {
		const agent = opts.agent as { name?: string };
		capturedCalls.push({ agent: agent.name ?? "unknown", mcpManager: opts.mcpManager });
		return {
			index: 0,
			id: "Task",
			agent: agent.name ?? "unknown",
			agentSource: "bundled",
			task: "stub",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
		};
	},
}));

mock.module("../../src/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [{ name: "designer", description: "designer", source: "bundled", model: "default", systemPrompt: "" }],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("../../src/task");
const { Settings } = await import("../../src/config/settings");

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
		createFakeMcpTool("mcp_chrome_devtools_list_pages", "chrome-devtools"),
	],
	getServerInstructions: (allowedServerNames?: readonly string[]) => {
		const instructions = new Map([
			["augment", "Use augment for semantic code retrieval."],
			["chrome-devtools", "Verify visible browser outcomes after each interaction."],
		]);
		if (!allowedServerNames) return instructions;
		const allowed = new Set(allowedServerNames);
		return new Map(Array.from(instructions.entries()).filter(([name]) => allowed.has(name)));
	},
	waitForConnection: async () => ({ name: "mock-connection" }),
};

function createSession(agentDir: string) {
	const settings = Settings.isolated({
		"task.isolation.mode": "none",
		"task.maxConcurrency": 2,
		"task.disabledAgents": [],
		"async.enabled": false,
	});
	settings.getAgentDir = () => agentDir;
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings,
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		taskDepth: 0,
		mcpManager: parentMcpManager,
	} as unknown as Parameters<typeof TaskTool.create>[0];
}

function managerToolNames(value: unknown): string[] {
	const manager = value as { getTools?: () => Array<{ name: string }> };
	if (!manager?.getTools) return [];
	return manager
		.getTools()
		.map(tool => tool.name)
		.sort();
}

function managerInstructionNames(value: unknown): string[] {
	const manager = value as { getServerInstructions?: () => Map<string, string> };
	if (!manager?.getServerInstructions) return [];
	return Array.from(manager.getServerInstructions().keys()).sort();
}

describe("subagent MCP per-tool disables", () => {
	beforeEach(() => {
		capturedCalls.length = 0;
	});

	test("keeps the server enabled while removing individually disabled tools", async () => {
		const tempHome = await Bun.$`mktemp -d`.text();
		const agentDir = tempHome.trim();
		await Bun.write(
			`${agentDir}/roles.yml`,
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
  designer:
    mcp:
      - augment
      - chrome-devtools
    disabledTools:
      - mcp_chrome_devtools_click
`,
		);
		const tool = await TaskTool.create(createSession(agentDir));
		await tool.execute("call-designer", {
			agent: "designer",
			tasks: [{ id: "DesignerTask", description: "designer", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(managerToolNames(capturedCalls[0]?.mcpManager)).toEqual([
			"mcp_augment_codebase_retrieval",
			"mcp_chrome_devtools_list_pages",
		]);
		expect(managerInstructionNames(capturedCalls[0]?.mcpManager)).toEqual(["augment", "chrome-devtools"]);
	});
});

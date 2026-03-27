import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { SingleResult } from "../../src/task/types";

const capturedCalls: Array<{ agent: string; advancedConfig: unknown }> = [];

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

mock.module("../../src/task/executor", () => ({
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

mock.module("../../src/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [{ name: "designer", description: "designer", source: "bundled", model: "default", systemPrompt: "" }],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("../../src/task");

function createSession(agentDir: string, overrides: Record<string, unknown> = {}) {
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
			getTools: () => [
				{
					name: "mcp_augment_codebase_retrieval",
					label: "mcp_augment_codebase_retrieval",
					description: "augment tool",
					parameters: Type.Object({}),
					renderCall: () => "",
					renderResult: () => "",
					execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
					mcpServerName: "augment",
					mcpToolName: "mcp_augment_codebase_retrieval",
				},
			],
			getServerInstructions: () => new Map([["augment", "Use augment for semantic code retrieval."]]),
			waitForConnection: async () => ({ name: "mock-connection" }),
		},
		...overrides,
	} as unknown as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool advanced subagent transport", () => {
	let originalHome: string | undefined;
	let tempHome: string;

	beforeEach(() => {
		capturedCalls.length = 0;
		originalHome = process.env.HOME;
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-task-advanced-home-"));
		process.env.HOME = tempHome;
		const agentDir = path.join(tempHome, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "roles.yml"),
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
    advanced:
      thinkingLevel: low
      maxRecursionDepth: 5
      compactionStrategy: handoff
      temperature: 0.3
`,
			"utf8",
		);
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	test("passes subagent advanced config through to runSubprocess", async () => {
		const agentDir = path.join(tempHome, ".omp", "agent");
		const tool = await TaskTool.create(createSession(agentDir));
		await tool.execute("call-designer-advanced", {
			agent: "designer",
			tasks: [{ id: "DesignerAdvanced", description: "designer", assignment: "noop" }],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0]?.agent).toBe("designer");
		expect(capturedCalls[0]?.advancedConfig).toEqual({
			thinkingLevel: "low",
			maxRecursionDepth: 5,
			compactionStrategy: "handoff",
			temperature: 0.3,
		});
	});
});

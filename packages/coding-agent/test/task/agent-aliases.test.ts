import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const runSubprocessAgents: string[] = [];
const stubResult: SingleResult = {
	index: 0,
	id: "TaskAlias",
	agent: "implement",
	agentSource: "bundled",
	task: "stub",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 1,
};

const availableAgents = [
	{
		name: "implement",
		description: "implement test agent",
		source: "bundled" as const,
		model: "default",
		systemPrompt: "You are implement.",
	},
];

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
	runSubprocess: async (opts: Record<string, unknown>) => {
		const agent = opts.agent as { name: string };
		runSubprocessAgents.push(agent.name);
		return { ...stubResult, agent: agent.name };
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: availableAgents,
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) =>
		agents.find(agent => agent.name === name) ??
		(name === "task" ? (agents.find(agent => agent.name === "implement") ?? null) : null),
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createSession(disabledAgents: string[] = []) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": disabledAgents,
			"async.enabled": false,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		taskDepth: 0,
	} as Parameters<typeof TaskTool.create>[0];
}

function collectText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

describe("TaskTool historical agent aliases", () => {
	beforeEach(() => {
		runSubprocessAgents.length = 0;
	});

	test("applies disabled-agent policy to the task alias", async () => {
		const tool = await TaskTool.create(createSession(["implement"]));
		const result = await tool.execute("call-task-disabled", {
			agent: "task",
			tasks: [{ id: "TaskAlias", description: "task alias", assignment: "noop" }],
		});

		expect(collectText(result)).toContain('Agent "implement" is disabled in settings');
		expect(runSubprocessAgents).toHaveLength(0);
	});
});

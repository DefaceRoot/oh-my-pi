import { describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const abortedResult: SingleResult = {
	index: 0,
	id: "StoppedWorker",
	agent: "explore",
	agentSource: "bundled",
	task: "Investigate duplicate workstream",
	description: "stop me",
	exitCode: 1,
	output: "",
	stderr: "",
	truncated: false,
	durationMs: 10,
	tokens: 0,
	aborted: true,
	abortReason: "User stopped: duplicate workstream",
};

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async () => abortedResult,
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{
				name: "explore",
				description: "test agent",
				source: "bundled" as const,
				model: "default",
				systemPrompt: "You are a test agent.",
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createSession() {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		taskDepth: 0,
	} as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool aborted-result summary", () => {
	test("includes the abort reason in parent-facing summary text", async () => {
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("call-aborted", {
			agent: "explore",
			tasks: [{ id: "StoppedWorker", description: "stop me", assignment: "noop" }],
		});

		expect(result.details?.results[0]).toMatchObject({
			aborted: true,
			abortReason: "User stopped: duplicate workstream",
		});
		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summaryText).toContain("<abort-reason>User stopped: duplicate workstream</abort-reason>");
		expect(summaryText).toContain("(no output)");
	});
});

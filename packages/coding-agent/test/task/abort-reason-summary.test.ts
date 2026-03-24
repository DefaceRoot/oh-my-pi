import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

function buildResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: overrides.id ?? "Worker",
		agent: overrides.agent ?? "explore",
		agentSource: overrides.agentSource ?? "bundled",
		task: overrides.task ?? "Investigate duplicate workstream",
		description: overrides.description,
		exitCode: overrides.exitCode ?? 0,
		output: overrides.output ?? "ok",
		stderr: overrides.stderr ?? "",
		truncated: overrides.truncated ?? false,
		durationMs: overrides.durationMs ?? 10,
		tokens: overrides.tokens ?? 250,
		hasSubmitResult: overrides.hasSubmitResult ?? true,
		error: overrides.error,
		aborted: overrides.aborted,
		abortReason: overrides.abortReason,
	};
}

let runResult: SingleResult = buildResult();

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
	runSubprocess: async () => runResult,
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

async function runSingleTask(taskId: string, description: string) {
	const tool = await TaskTool.create(createSession());
	return tool.execute(`call-${taskId}`, {
		agent: "explore",
		tasks: [{ id: taskId, description, assignment: "noop" }],
	});
}

describe("TaskTool result health summary", () => {
	beforeEach(() => {
		runResult = buildResult({
			id: "StoppedWorker",
			description: "stop me",
			exitCode: 1,
			output: "",
			stderr: "",
			tokens: 0,
			hasSubmitResult: false,
			aborted: true,
			abortReason: "User stopped: duplicate workstream",
		});
	});

	test("includes the abort reason in parent-facing summary text", async () => {
		const result = await runSingleTask("StoppedWorker", "stop me");

		expect(result.details?.results[0]).toMatchObject({
			aborted: true,
			abortReason: "User stopped: duplicate workstream",
		});
		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summaryText).toContain("<abort-reason>User stopped: duplicate workstream</abort-reason>");
		expect(summaryText).toContain("(no output)");
		expect(summaryText).toContain("<health>Health: tokens=0, submit_result=no, elapsed=10ms</health>");
	});

	test("marks zero-token sessions without submit_result as failed", async () => {
		runResult = buildResult({
			id: "SilentWorker",
			description: "silent failure",
			exitCode: 0,
			output: "",
			stderr: "",
			tokens: 0,
			durationMs: 12,
			hasSubmitResult: false,
		});

		const result = await runSingleTask("SilentWorker", "silent failure");
		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summaryText).toContain("<header>0/1 succeeded [");
		expect(summaryText).toContain("<status>failed</status>");
		expect(summaryText).toContain(
			"<status-detail>Session produced no output (0 tokens, no submit_result). The subagent may have failed to initialize.</status-detail>",
		);
		expect(summaryText).toContain("<health>Health: tokens=0, submit_result=no, elapsed=12ms</health>");
	});

	test("warns when low-token sessions skip submit_result", async () => {
		runResult = buildResult({
			id: "LowTokenWorker",
			description: "low token warning",
			exitCode: 0,
			output: "partial completion",
			tokens: 42,
			durationMs: 19,
			hasSubmitResult: false,
		});

		const result = await runSingleTask("LowTokenWorker", "low token warning");
		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		expect(summaryText).toContain("<status>completed</status>");
		expect(summaryText).toContain(
			"<status-detail>Warning: Session used only 42 tokens without calling submit_result.</status-detail>",
		);
		expect(summaryText).toContain("<health>Health: tokens=42, submit_result=no, elapsed=19ms</health>");
	});
});
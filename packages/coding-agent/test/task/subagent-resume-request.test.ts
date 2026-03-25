import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_RESUME_REQUEST_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const resultResolvers = new Map<string, (result: SingleResult) => void>();
const startedTaskIds = new Set<string>();
const runSubprocessCalls: Record<string, unknown>[] = [];
const cancelledSubagents = new Map<
	string,
	{
		id: string;
		sessionFile: string;
		sessionId?: string;
		options: Record<string, unknown>;
		storedAt: number;
		abortReason?: string;
	}
>();

function createDeferredResult(id: string): Promise<SingleResult> {
	const { promise, resolve } = Promise.withResolvers<SingleResult>();
	resultResolvers.set(id, resolve);
	return promise;
}

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	cancelledSubagents,
	runSubprocess: (opts: Record<string, unknown>) => {
		runSubprocessCalls.push(opts);
		const id = String(opts.id);
		startedTaskIds.add(id);
		return createDeferredResult(id);
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{
				name: "explore",
				description: "test agent",
				source: "bundled",
				model: "default",
				systemPrompt: "You are a test agent.",
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(a => a.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createMinimalSession(overrides: Record<string, unknown> = {}) {
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
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		...overrides,
	} as Parameters<typeof TaskTool.create>[0];
}

function resolveTask(id: string): void {
	resultResolvers.get(id)?.({
		index: 0,
		id,
		agent: "explore",
		agentSource: "bundled",
		task: `task ${id}`,
		description: id,
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	});
}

describe("TaskTool targeted subagent resume requests", () => {
	beforeEach(() => {
		resultResolvers.clear();
		startedTaskIds.clear();
		runSubprocessCalls.length = 0;
		cancelledSubagents.clear();
	});

	test("starts a stored subagent resume with the continuation message", async () => {
		const bus = new EventBus();
		await TaskTool.create(createMinimalSession({ eventBus: bus }));
		cancelledSubagents.set("ResumeMe", {
			id: "ResumeMe",
			sessionFile: "/tmp/ResumeMe.jsonl",
			sessionId: "omp-session-1497",
			options: { id: "ResumeMe", index: 0, agent: "explore", assignment: "one" },
			storedAt: Date.now(),
			abortReason: "Resume requested",
		});

		const response = Promise.withResolvers<boolean>();
		bus.emit(TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, {
			id: "ResumeMe",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/ResumeMe.jsonl",
			continueMessage: "Continue from the saved session",
			respond: (handled: boolean) => response.resolve(handled),
		});

		await expect(response.promise).resolves.toBe(true);
		while (!startedTaskIds.has("ResumeMe")) {
			await Bun.sleep(1);
		}
		expect(runSubprocessCalls).toHaveLength(1);
		expect(runSubprocessCalls[0]).toMatchObject({
			id: "ResumeMe",
			task: "Continue from the saved session",
			resumeFromSessionFile: "/tmp/ResumeMe.jsonl",
		});

		resolveTask("ResumeMe");
	});

	test("responds false when no stored resume metadata exists", async () => {
		const bus = new EventBus();
		await TaskTool.create(createMinimalSession({ eventBus: bus }));

		const response = Promise.withResolvers<boolean>();
		bus.emit(TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, {
			id: "ResumeFail",
			sessionId: "omp-session-1498",
			sessionPath: "/tmp/ResumeFail.jsonl",
			continueMessage: "Try again",
			respond: (handled: boolean) => response.resolve(handled),
		});

		await expect(response.promise).resolves.toBe(false);
		expect(runSubprocessCalls).toHaveLength(0);
	});
});

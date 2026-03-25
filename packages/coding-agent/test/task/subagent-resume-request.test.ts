import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_RESUME_REQUEST_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const resultResolvers = new Map<string, (result: SingleResult) => void>();
const startedTaskIds = new Set<string>();
const resumeCalls: Array<{ lookup: Record<string, unknown>; continueMessage: string | undefined }> = [];
let resumeImpl: (lookup: Record<string, unknown>, continueMessage: string | undefined) => Promise<boolean> = async () => false;

function createDeferredResult(id: string): Promise<SingleResult> {
	const { promise, resolve } = Promise.withResolvers<SingleResult>();
	resultResolvers.set(id, resolve);
	return promise;
}

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: (opts: Record<string, unknown>) => {
		const id = String(opts.id);
		startedTaskIds.add(id);
		return createDeferredResult(id);
	},
	resumeSubagent: async (lookup: Record<string, unknown>, continueMessage?: string) => {
		resumeCalls.push({ lookup, continueMessage });
		return await resumeImpl(lookup, continueMessage);
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
		resumeCalls.length = 0;
		resumeImpl = async () => false;
	});

	test("passes the continuation message to resumeSubagent and reports success asynchronously", async () => {
		resumeImpl = async () => {
			await Promise.resolve();
			return true;
		};

		const bus = new EventBus();
		const tool = await TaskTool.create(createMinimalSession({ eventBus: bus }));
		const executePromise = tool.execute("call-resume", {
			agent: "explore",
			tasks: [{ id: "ResumeMe", description: "resume me", assignment: "one" }],
		});

		while (!startedTaskIds.has("ResumeMe")) {
			await Bun.sleep(1);
		}

		const response = Promise.withResolvers<boolean>();
		bus.emit(TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, {
			id: "ResumeMe",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/ResumeMe.jsonl",
			continueMessage: "Continue from the saved session",
			respond: (handled: boolean) => response.resolve(handled),
		});

		await expect(response.promise).resolves.toBe(true);
		expect(resumeCalls).toEqual([
			{
				lookup: {
					id: "ResumeMe",
					sessionId: "omp-session-1497",
					sessionPath: "/tmp/ResumeMe.jsonl",
				},
				continueMessage: "Continue from the saved session",
			},
		]);

		resolveTask("ResumeMe");
		await executePromise;
	});

	test("always responds false when resumeSubagent fails", async () => {
		resumeImpl = async () => {
			await Promise.resolve();
			throw new Error("resume failed");
		};

		const bus = new EventBus();
		const tool = await TaskTool.create(createMinimalSession({ eventBus: bus }));
		const executePromise = tool.execute("call-resume-fail", {
			agent: "explore",
			tasks: [{ id: "ResumeFail", description: "resume fail", assignment: "one" }],
		});

		while (!startedTaskIds.has("ResumeFail")) {
			await Bun.sleep(1);
		}

		const response = Promise.withResolvers<boolean>();
		bus.emit(TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, {
			id: "ResumeFail",
			sessionId: "omp-session-1498",
			sessionPath: "/tmp/ResumeFail.jsonl",
			continueMessage: "Try again",
			respond: (handled: boolean) => response.resolve(handled),
		});

		await expect(response.promise).resolves.toBe(false);
		expect(resumeCalls[0]).toMatchObject({
			lookup: {
				id: "ResumeFail",
				sessionId: "omp-session-1498",
				sessionPath: "/tmp/ResumeFail.jsonl",
			},
			continueMessage: "Try again",
		});

		resolveTask("ResumeFail");
		await executePromise;
	});
});

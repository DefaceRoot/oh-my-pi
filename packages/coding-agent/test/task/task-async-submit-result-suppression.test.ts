import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const runSubprocessCalls: Array<Record<string, unknown>> = [];

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (opts: Record<string, unknown>) => {
		runSubprocessCalls.push(opts);
		return {
			index: 0,
			id: "0-SubmitTask",
			agent: "explore",
			agentSource: "bundled",
			task: "submit via submit_result",
			description: "submit_result suppression task",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 100,
			tokens: 1,
			hasSubmitResult: true,
		} as SingleResult;
	},
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{
				name: "explore",
				description: "test agent",
				source: "bundled",
				model: "anthropic/claude-sonnet-4-20250514",
				systemPrompt: "You are a test agent.",
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(a => a.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

class FakeAsyncJobManager {
	readonly #jobs: Promise<unknown>[] = [];
	readonly acknowledgeDeliveriesCalls: string[][] = [];

	register(
		_type: "bash" | "task",
		_label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
		}) => Promise<string>,
		options?: { id?: string; onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void> },
	): string {
		const jobId = options?.id ?? `job-${this.#jobs.length + 1}`;
		const controller = new AbortController();
		const job = run({
			jobId,
			signal: controller.signal,
			reportProgress: async (text, details) => {
				await options?.onProgress?.(text, details);
			},
		}).catch(() => undefined);
		this.#jobs.push(job);
		return jobId;
	}

	updateProgress(): void {}

	acknowledgeDeliveries(jobIds: string[]): number {
		this.acknowledgeDeliveriesCalls.push(jobIds);
		return jobIds.length;
	}

	async drain(): Promise<void> {
		await Promise.all(this.#jobs);
	}
}

function createSession(asyncJobManager: FakeAsyncJobManager) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": true,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		asyncJobManager,
		agentOutputManager: {
			allocateBatch: async (ids: string[]) => ids.map((id, index) => `${index}-${id}`),
		},
	} as unknown as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool async submit_result suppression", () => {
	beforeEach(() => {
		runSubprocessCalls.length = 0;
	});

	test("calls acknowledgeDeliveries when subagent reported via submit_result", async () => {
		const asyncJobManager = new FakeAsyncJobManager();
		const tool = await TaskTool.create(createSession(asyncJobManager));

		await tool.execute(
			"call-1",
			{
				agent: "explore",
				tasks: [
					{
						id: "SubmitTask",
						description: "submit_result suppression task",
						assignment: "submit via submit_result",
					},
				],
			},
			undefined,
			undefined,
		);
		await asyncJobManager.drain();

		expect(runSubprocessCalls).toHaveLength(1);
		expect(asyncJobManager.acknowledgeDeliveriesCalls).toHaveLength(1);
		expect(asyncJobManager.acknowledgeDeliveriesCalls[0]).toEqual(["0-SubmitTask"]);
	});
});

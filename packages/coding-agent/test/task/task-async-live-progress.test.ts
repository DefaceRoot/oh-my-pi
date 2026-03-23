import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

const runSubprocessCalls: Array<Record<string, unknown>> = [];
const liveProgressTimestamp = 1_739_603_401_234;

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	runSubprocess: async (opts: Record<string, unknown>) => {
		runSubprocessCalls.push(opts);
		const onProgress = opts.onProgress as ((progress: Record<string, unknown>) => void | Promise<void>) | undefined;
		await onProgress?.({
			index: 0,
			id: "0-LiveTask",
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: "Investigate live progress",
			description: "Live progress task",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 321,
			durationMs: 2_500,
			startedAt: liveProgressTimestamp - 2_500,
			lastUpdatedMs: liveProgressTimestamp,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		} satisfies Record<string, unknown>);

		return {
			index: 0,
			id: "0-LiveTask",
			agent: "explore",
			agentSource: "bundled",
			task: "Investigate live progress",
			description: "Live progress task",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 3_000,
			tokens: 654,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			startedAt: liveProgressTimestamp - 3_000,
			lastUpdatedMs: liveProgressTimestamp + 500,
		} as SingleResult;
	},
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
	readonly progressSnapshots: Array<{ text: string; details?: Record<string, unknown> }> = [];

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
				this.progressSnapshots.push({ text, details });
				await options?.onProgress?.(text, details);
			},
		}).catch(() => undefined);
		this.#jobs.push(job);
		return jobId;
	}

	updateProgress(): void {}

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
	} as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool async live progress", () => {
	beforeEach(() => {
		runSubprocessCalls.length = 0;
	});

	test("forwards live tokens, model, provider, and last-activity timestamps into async progress updates", async () => {
		const asyncJobManager = new FakeAsyncJobManager();
		const tool = await TaskTool.create(createSession(asyncJobManager));
		const updates: TaskToolDetails[] = [];

		await tool.execute(
			"call-1",
			{
				agent: "explore",
				tasks: [{ id: "LiveTask", description: "Live progress task", assignment: "Investigate live progress" }],
			},
			undefined,
			update => {
				if (update.details) {
					updates.push(update.details);
				}
			},
		);
		await asyncJobManager.drain();

		expect(runSubprocessCalls).toHaveLength(1);
		const liveDetail = updates.find(
			detail =>
				Array.isArray(detail.progress) &&
				detail.progress.some(progress => (progress as Record<string, unknown>).tokens === 321),
		);
		expect(liveDetail).toBeDefined();
		expect((liveDetail?.progress?.[0] as Record<string, unknown>) ?? {}).toMatchObject({
			id: "0-LiveTask",
			status: "running",
			tokens: 321,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			lastUpdatedMs: liveProgressTimestamp,
		});

		const completedDetail = updates.find(
			detail =>
				Array.isArray(detail.progress) &&
				detail.progress.some(progress => (progress as Record<string, unknown>).tokens === 654),
		);
		expect(completedDetail).toBeDefined();
		expect((completedDetail?.progress?.[0] as Record<string, unknown>) ?? {}).toMatchObject({
			status: "completed",
			tokens: 654,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});
	});
});

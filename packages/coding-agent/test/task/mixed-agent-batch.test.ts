import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const runSubprocessCalls: Array<Record<string, unknown>> = [];
const runSubprocessAgents: string[] = [];

const availableAgents = [
	{
		name: "designer",
		description: "designer test agent",
		source: "bundled" as const,
		model: "default",
		systemPrompt: "You are designer.",
	},
	{
		name: "research",
		description: "research test agent",
		source: "bundled" as const,
		model: "default",
		systemPrompt: "You are research.",
	},
];

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	resumeCancelledSubagent: async () => null,
	cancelledSubagents: new Map(),
	runSubprocess: async (opts: Record<string, unknown>) => {
		runSubprocessCalls.push(opts);
		const agent = opts.agent as { name: string };
		const index = (opts.index as number | undefined) ?? 0;
		const id = (opts.id as string | undefined) ?? `Task-${index}`;
		runSubprocessAgents.push(agent.name);
		return {
			index,
			id,
			agent: agent.name,
			agentSource: "bundled",
			task: String(opts.task ?? "noop"),
			description: String(opts.description ?? id),
			exitCode: 0,
			output: `${agent.name} ok`,
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
		} as SingleResult;
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/worktree", () => ({
	getRepoRoot: async () => "/tmp/test-repo",
	captureBaseline: async () => ({
		root: { repoRoot: "/tmp/test-repo", headCommit: "abc", staged: "", unstaged: "", untracked: [] },
		nested: [],
	}),
	ensureWorktree: async (_root: string, id: string) => `/tmp/test-wt/${id}`,
	applyBaseline: async () => {},
	cleanupWorktree: async () => {},
	commitToBranch: async () => null,
	mergeTaskBranches: async () => ({ merged: [], failed: [], conflict: null }),
	cleanupTaskBranches: async () => {},
	captureDeltaPatch: async () => ({ rootPatch: "", nestedPatches: [] }),
	applyNestedPatches: async () => {},
	ensureFuseOverlay: async () => "",
	cleanupFuseOverlay: async () => {},
	ensureProjfsOverlay: async () => "",
	cleanupProjfsOverlay: async () => {},
	isProjfsUnavailableError: () => false,
	getGitNoIndexNullPath: () => "/dev/null",
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: availableAgents,
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string | undefined) =>
		typeof name === "string" ? (agents.find(agent => agent.name === name) ?? null) : null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

class FakeAsyncJobManager {
	readonly #jobs: Promise<unknown>[] = [];

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

	acknowledgeDeliveries(): number {
		return 0;
	}

	async drain(): Promise<void> {
		await Promise.all(this.#jobs);
	}
}

function createSession(options: {
	asyncEnabled: boolean;
	asyncJobManager?: FakeAsyncJobManager;
	isolationMode?: string;
}) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.isolation.merge": "branch",
			"task.isolation.commits": "generic",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": options.asyncEnabled,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		taskDepth: 0,
		asyncJobManager: options.asyncJobManager,
		agentOutputManager: {
			allocateBatch: async (ids: string[]) => ids,
		},
	} as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool mixed-agent batches", () => {
	beforeEach(() => {
		runSubprocessCalls.length = 0;
		runSubprocessAgents.length = 0;
	});

	test("dispatches different delegate roles within one synchronous batch", async () => {
		const tool = await TaskTool.create(createSession({ asyncEnabled: false }));

		const result = await tool.execute("call-mixed-sync", {
			tasks: [
				{
					id: "DesignNav",
					agent: "designer",
					description: "Design navigation",
					assignment: "Review navigation layout.",
				},
				{
					id: "ResearchDom",
					agent: "research",
					description: "Research DOM contract",
					assignment: "Inspect sidebar DOM expectations.",
				},
			],
		} as any);

		expect(runSubprocessAgents).toEqual(["designer", "research"]);
		expect(result.details?.results.map(item => item.agent)).toEqual(["designer", "research"]);
	});

	test("starts different delegate roles in one asynchronous batch", async () => {
		const asyncJobManager = new FakeAsyncJobManager();
		const tool = await TaskTool.create(createSession({ asyncEnabled: true, asyncJobManager }));

		const result = await tool.execute("call-mixed-async", {
			tasks: [
				{
					id: "DesignNav",
					agent: "designer",
					description: "Design navigation",
					assignment: "Review navigation layout.",
				},
				{
					id: "ResearchDom",
					agent: "research",
					description: "Research DOM contract",
					assignment: "Inspect sidebar DOM expectations.",
				},
			],
		} as any);
		await asyncJobManager.drain();

		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.progress?.map(item => item.agent)).toEqual(["designer", "research"]);
		expect(runSubprocessAgents).toEqual(["designer", "research"]);
	});

	test("isolated tasks with different agent roles use sync path even when async is enabled", async () => {
		const asyncJobManager = new FakeAsyncJobManager();
		const tool = await TaskTool.create(
			createSession({ asyncEnabled: true, asyncJobManager, isolationMode: "worktree" }),
		);

		const result = await tool.execute("call-isolated-mixed", {
			isolated: true,
			tasks: [
				{
					id: "DesignNav",
					agent: "designer",
					description: "Design navigation",
					assignment: "Review navigation layout.",
				},
				{
					id: "ResearchDom",
					agent: "research",
					description: "Research DOM contract",
					assignment: "Inspect sidebar DOM expectations.",
				},
			],
		} as any);

		// Sync path taken: result is fully resolved (not background-running).
		expect(result.details?.async).toBeUndefined();
		// Both per-task agents were dispatched correctly.
		expect(runSubprocessAgents).toContain("designer");
		expect(runSubprocessAgents).toContain("research");
		expect(runSubprocessAgents).toHaveLength(2);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

let mergeScenario: "conflict" | "success" = "conflict";
const capturedRunSubprocessImages: Array<ImageContent[] | undefined> = [];

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (params: {
		index: number;
		id: string;
		task: string;
		images?: ImageContent[];
	}): Promise<SingleResult> => {
		capturedRunSubprocessImages.push(params.images);
		return {
			index: params.index,
			id: params.id,
			agent: "explore",
			agentSource: "bundled",
			task: params.task,
			description: undefined,
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
		};
	},
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

mock.module("@oh-my-pi/pi-coding-agent/task/worktree", () => ({
	getRepoRoot: async () => "/tmp/repo",
	captureBaseline: async () => ({ repoRoot: "/tmp/repo" }),
	ensureWorktree: async (_repoRoot: string, taskId: string) => `/tmp/worktree-${taskId}`,
	applyBaseline: async () => {},
	cleanupWorktree: async () => {},
	commitToBranch: async (_isolationDir: string, _baseline: unknown, taskId: string) => ({
		branchName: `omp/task/${taskId}`,
		nestedPatches: [],
	}),
	captureDeltaPatch: async () => ({ rootPatch: "", nestedPatches: [] }),
	cleanupTaskBranches: async () => {},
	applyNestedPatches: async () => {},
	ensureFuseOverlay: async () => {
		throw new Error("Unexpected fuse-overlay usage in test");
	},
	cleanupFuseOverlay: async () => {},
	ensureProjfsOverlay: async () => {
		throw new Error("Unexpected fuse-projfs usage in test");
	},
	cleanupProjfsOverlay: async () => {},
	isProjfsUnavailableError: () => false,
	mergeTaskBranches: async (
		_repoRoot: string,
		branches: Array<{ branchName: string; taskId: string; description?: string }>,
	) => {
		if (mergeScenario === "success") {
			return { merged: branches.map(branch => branch.branchName), failed: [] };
		}

		const failedBranch = branches[0]?.branchName ?? "omp/task/unknown";
		return {
			merged: [],
			failed: [failedBranch],
			conflict: `${failedBranch}: cherry-pick conflict`,
			conflictingBranch: failedBranch,
		};
	},
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createSession(options?: { images?: ImageContent[] }) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "worktree",
			"task.isolation.merge": "branch",
			"task.maxConcurrency": 1,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getLastUserImages: () => options?.images,
		taskDepth: 0,
	} as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool branch merge summaries", () => {
	beforeEach(() => {
		mergeScenario = "conflict";
		capturedRunSubprocessImages.length = 0;
	});

	test("includes merge-agent guidance and branch details on merge conflict", async () => {
		const images: ImageContent[] = [{ type: "image", data: "Z2xvYmFs", mimeType: "image/png" }];
		const tool = await TaskTool.create(createSession({ images }));
		const taskId = "ConflictedTask";
		const result = await tool.execute("call-merge-conflict", {
			agent: "explore",
			tasks: [{ id: taskId, description: "conflict case", assignment: "noop" }],
			isolated: true,
		} as any);

		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		const branchName = result.details?.results[0]?.branchName;
		const branchNameText = branchName ?? "";
		const resultTaskId = result.details?.results[0]?.id ?? "";
		expect(branchNameText).toBe(`omp/task/${resultTaskId}`);
		expect(summaryText).toContain("Branch merge conflict detected.");
		expect(summaryText).toContain("To resolve, spawn a `merge` agent with context:");
		expect(summaryText).toContain(`- Conflicting branches: ${branchNameText}`);
		expect(summaryText).toContain(`- ${branchNameText} (task: ${resultTaskId}): No description`);
		expect(summaryText).not.toContain("Merged:");
		expect(result.details?.mergeAgentContext).toEqual({
			conflictingBranches: [branchNameText],
			mergedBranches: [],
			conflict: `${branchNameText}: cherry-pick conflict`,
			branchSummaries: [{ branch: branchNameText, taskId: resultTaskId, description: "No description" }],
		});
		expect(capturedRunSubprocessImages).toHaveLength(1);
		expect(capturedRunSubprocessImages[0]).toEqual(images);
	});

	test("keeps successful merge summary path unchanged", async () => {
		mergeScenario = "success";
		const tool = await TaskTool.create(createSession());
		const taskId = "MergedTask";
		const result = await tool.execute("call-merge-success", {
			agent: "explore",
			tasks: [{ id: taskId, description: "success case", assignment: "noop" }],
			isolated: true,
		} as any);

		const summaryText = result.content.find(part => part.type === "text")?.text ?? "";
		const mergedBranch = result.details?.results[0]?.branchName;
		expect(summaryText).toContain(`Merged 1 branch: ${mergedBranch}`);
		expect(summaryText).not.toContain("Branch merge conflict detected.");
		expect(result.details?.mergeAgentContext).toBeUndefined();
	});
});

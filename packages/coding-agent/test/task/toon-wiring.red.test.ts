import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

type BuildCall = {
	delegate: string;
	compactContext: string;
};

type RunSubprocessCall = {
	task?: string;
	description?: string;
	[key: string]: unknown;
};

const buildToonCalls: BuildCall[] = [];
const runSubprocessCalls: RunSubprocessCall[] = [];
let builderMode: "success" | "throw" = "success";

const delegatedToon = [
	"delegation:",
	'  contract_version: "omp-delegation/v1"',
	"  envelope:",
	'    id: "del_sync_001"',
	'    parent_envelope_id: "parent-hop-2"',
	'    created_at: "2026-03-19T00:00:00.000Z"',
	"  task:",
	'    id: "sync-task"',
	'    title: "Sync delegation"',
].join("\n");

mock.module("@oh-my-pi/pi-coding-agent/task/toon-delegation-builder", () => ({
	buildToonDelegation: async (input: any) => {
		buildToonCalls.push({
			delegate: input.delegate,
			compactContext: input.session.getCompactContext?.(),
		});
		if (builderMode === "throw") {
			throw new Error("builder generation failed");
		}
		return {
			toon: delegatedToon,
			metadata: {
				contract_version: "omp-delegation/v1",
				envelope: {
					id: "del_sync_001",
					parent_envelope_id: "parent-hop-2",
					created_at: "2026-03-19T00:00:00.000Z",
				},
				input_policy: { mode: "detailed" },
				context: { repo_root: input.session.cwd, workflow_mode: "implement" },
				roles: { delegator: "implement", delegate: input.delegate },
				task: {
					id: "sync-task",
					title: "Sync delegation",
					description: "Delegate through TOON",
					constraints: [],
					acceptance_criteria: [],
				},
			},
		};
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (opts: Record<string, unknown>) => {
		runSubprocessCalls.push(opts as RunSubprocessCall);
		return {
			index: 0,
			id: "0-Sync",
			agent: "explore",
			agentSource: "bundled",
			task: "ok",
			description: "ok",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
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
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(agent => agent.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");

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

	async drain(): Promise<void> {
		await Promise.all(this.#jobs);
	}
}

function makeInheritedContext(parentEnvelopeId = "parent-hop-2"): string {
	return [
		"<delegation_context>",
		`repository_cwd: ${JSON.stringify("/inherited/workspace")}`,
		`workflow_mode: ${JSON.stringify("plan_linked")}`,
		`repo_root: ${JSON.stringify("/inherited/repo")}`,
		`branch_name: ${JSON.stringify("feature/inherited")}`,
		`base_branch: ${JSON.stringify("origin/main")}`,
		`parent_envelope_id: ${JSON.stringify(parentEnvelopeId)}`,
		`envelope_id: ${JSON.stringify("ancestor-hop-1")}`,
		"</delegation_context>",
	].join("\n");
}

async function withTempDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toon-wiring-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function createSession(
	cwd: string,
	options: {
		asyncEnabled: boolean;
		compactContext?: string;
		asyncJobManager?: FakeAsyncJobManager;
	},
): Parameters<typeof TaskTool.create>[0] {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 2,
			"task.disabledAgents": [],
			"task.agentModelOverrides": {},
			"async.enabled": options.asyncEnabled,
		}),
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getCompactContext: () => options.compactContext ?? "",
		getRuntimeRole: () => "implement",
		getSessionEntries: () => [],
		getPlanModeState: () => undefined,
		agentOutputManager: {
			allocateBatch: async (ids: string[]) => ids.map((id, index) => `${index}-${id}`),
		},
		asyncJobManager: options.asyncJobManager,
	} as unknown as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool TOON wiring", () => {
	beforeEach(() => {
		buildToonCalls.length = 0;
		runSubprocessCalls.length = 0;
		builderMode = "success";
	});

	test("sync execution uses builder TOON and carries inherited parent envelope id", async () => {
		await withTempDir(async cwd => {
			const inheritedContext = makeInheritedContext();
			const tool = await TaskTool.create(
				createSession(cwd, {
					asyncEnabled: false,
					compactContext: inheritedContext,
				}),
			);

			await tool.execute("sync-call", {
				agent: "explore",
				context: "Legacy background that should be replaced by the builder payload.",
				tasks: [
					{
						id: "SyncTask",
						description: "Sync path should receive TOON output",
						assignment:
							"Target: render TOON payload.\nChange: pass builder output through.\nEdge Cases: inherited parent envelope.\nAcceptance: subprocess sees the TOON payload.",
					},
				],
			});

			expect(buildToonCalls).toHaveLength(1);
			expect(buildToonCalls[0]?.compactContext).toBe(inheritedContext);
			expect(buildToonCalls[0]?.delegate).toBe("explore");
			expect(runSubprocessCalls).toHaveLength(1);
			expect(runSubprocessCalls[0]?.task).toBe(delegatedToon);
		});
	});

	test("async execution uses builder TOON instead of legacy task shaping", async () => {
		await withTempDir(async cwd => {
			const asyncJobManager = new FakeAsyncJobManager();
			const tool = await TaskTool.create(
				createSession(cwd, {
					asyncEnabled: true,
					asyncJobManager,
				}),
			);

			await tool.execute(
				"async-call",
				{
					agent: "explore",
					context: "Legacy background that should not be rewrapped.",
					tasks: [
						{
							id: "AsyncTask",
							description: "Async path should receive TOON output",
							assignment:
								"Target: render TOON payload.\nChange: pass builder output through.\nEdge Cases: async scheduling.\nAcceptance: subprocess sees the TOON payload.",
						},
					],
				},
				undefined,
				() => {},
			);

			await asyncJobManager.drain();

			expect(buildToonCalls).toHaveLength(1);
			expect(runSubprocessCalls).toHaveLength(1);
			expect(runSubprocessCalls[0]?.task).toBe(delegatedToon);
		});
	});

	test("builder failure falls back to minimal TOON instead of XML wrappers", async () => {
		builderMode = "throw";

		await withTempDir(async cwd => {
			const tool = await TaskTool.create(
				createSession(cwd, {
					asyncEnabled: false,
				}),
			);

			await tool.execute("fallback-call", {
				agent: "explore",
				context: "Legacy background that should be replaced by fallback TOON.",
				tasks: [
					{
						id: "FallbackTask",
						description: "Fallback path should stay TOON-shaped",
						assignment:
							"Target: degrade to minimal TOON.\nChange: avoid XML wrappers.\nEdge Cases: builder failure.\nAcceptance: subprocess sees delegation root text.",
					},
				],
			});

			expect(runSubprocessCalls).toHaveLength(1);
			expect(runSubprocessCalls[0]?.task).toContain("delegation:");
			expect(runSubprocessCalls[0]?.task).not.toContain("<context>");
			expect(runSubprocessCalls[0]?.task).not.toContain("<goal>");
		});
	});
});

describe("delegation sidecar writing", () => {
	beforeEach(() => {
		// Reset shared state that may have been mutated by prior tests in other describe blocks
		builderMode = "success";
		buildToonCalls.length = 0;
		runSubprocessCalls.length = 0;
	});

	test("writes delegation-meta sidecar when getArtifactsDir is available", async () => {
		await withTempDir(async cwd => {
			const artifactsDir = path.join(cwd, "artifacts");
			const tool = await TaskTool.create(
				{
					...createSession(cwd, { asyncEnabled: false }),
					getArtifactsDir: () => artifactsDir,
				} as any,
			);

			await tool.execute("sidecar-call", {
				agent: "explore",
				tasks: [
					{
						id: "SidecarTask",
						description: "Test sidecar write",
						assignment:
							"Target: verify sidecar.\nChange: confirm file written.\nEdge Cases: none.\nAcceptance: sidecar file exists.",
					},
				],
			});

			// Allow fire-and-forget promise to settle
			await new Promise(r => setTimeout(r, 50));

			const sidecarFiles = fs.readdirSync(artifactsDir).filter(f => f.endsWith("-delegation-meta.json"));
			expect(sidecarFiles.length).toBeGreaterThanOrEqual(1);

			const sidecarContent = JSON.parse(
				fs.readFileSync(path.join(artifactsDir, sidecarFiles[0]!), "utf-8"),
			);
			expect(sidecarContent.contract_version).toBe("omp-delegation/v1");
			expect(sidecarContent.envelope?.id).toBeTruthy();
			expect(sidecarContent.task?.title).toBeTruthy();
		});
	});

	test("sidecar write failure does not fail delegation", async () => {
		await withTempDir(async cwd => {
			// Return a path that cannot be written to (a file, not a dir)
			const blockingFile = path.join(cwd, "blocked");
			fs.writeFileSync(blockingFile, "x");
			const tool = await TaskTool.create(
				{
					...createSession(cwd, { asyncEnabled: false }),
					// Return path to a file instead of a dir so mkdir fails
					getArtifactsDir: () => blockingFile,
				} as any,
			);

			// Delegation should still succeed despite sidecar write failure
			const result = await tool.execute("sidecar-fail-call", {
				agent: "explore",
				tasks: [
					{
						id: "SidecarFailTask",
						description: "Test non-fatal sidecar failure",
						assignment: "Target: confirm delegation proceeds.\nAcceptance: result returned.",
					},
				],
			});
			expect(result).toBeDefined();
			expect(result.content[0]?.type).toBe("text");
		});
	});
});

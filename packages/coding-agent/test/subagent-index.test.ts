import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentIndex } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-index";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { logger } from "@oh-my-pi/pi-utils";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function buildTaskResult(overrides: Partial<SingleResult> & Pick<SingleResult, "id">): SingleResult {
	return {
		index: 0,
		id: overrides.id,
		agent: overrides.agent ?? "implement",
		agentSource: overrides.agentSource ?? "bundled",
		task: overrides.task ?? "Investigate issue",
		description: overrides.description,
		lastIntent: overrides.lastIntent,
		exitCode: overrides.exitCode ?? 0,
		output: overrides.output ?? "",
		stderr: overrides.stderr ?? "",
		truncated: overrides.truncated ?? false,
		durationMs: overrides.durationMs ?? 120,
		tokens: overrides.tokens ?? 42,
		modelOverride: overrides.modelOverride,
		error: overrides.error,
		aborted: overrides.aborted,
		abortReason: overrides.abortReason,
		usage: overrides.usage,
		outputPath: overrides.outputPath,
		patchPath: overrides.patchPath,
		branchName: overrides.branchName,
		nestedPatches: overrides.nestedPatches,
		extractedToolData: overrides.extractedToolData,
		outputMeta: overrides.outputMeta,
	};
}

async function seedTranscript(root: string, relativePath: string, mtime: Date): Promise<string> {
	const fullPath = path.join(root, relativePath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, '{"type":"session_init","task":"demo"}\n', "utf8");
	await utimes(fullPath, mtime, mtime);
	return fullPath;
}

describe("SubagentIndex", () => {
	let tempDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-index-"));
		artifactsDir = path.join(tempDir, "artifacts");
		await mkdir(artifactsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	test("returns empty snapshot when artifacts root is missing", async () => {
		const index = new SubagentIndex({ artifactsDir: path.join(tempDir, "missing-artifacts") });

		const snapshot = await index.reconcile();

		expect(snapshot.refs).toEqual([]);
		expect(snapshot.groups).toEqual([]);
	});

	test("bootstrap reconcile discovers nested transcript artifacts", async () => {
		const baseTime = new Date("2025-01-01T00:00:00.000Z");
		await seedTranscript(artifactsDir, "0-Root.jsonl", baseTime);
		await seedTranscript(artifactsDir, "0-Root/0-Root.0-Scout.jsonl", baseTime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();
		const ids = snapshot.refs.map(ref => ref.id);

		expect(ids).toContain("0-Root");
		expect(ids).toContain("0-Root.0-Scout");
		expect(snapshot.refs.every(ref => ref.status === "completed")).toBe(true);
	});

	test("bootstrap reconcile recovers agent and model metadata when session_init is not the first transcript entry", async () => {
		const baseTime = new Date("2025-01-01T00:00:00.000Z");
		const sessionPath = path.join(artifactsDir, "0-Root/0-Root.1-Reviewer.jsonl");
		await mkdir(path.dirname(sessionPath), { recursive: true });
		const oversizedPrompt = "x".repeat(20_000);
		await writeFile(
			sessionPath,
			`${[
				JSON.stringify({ type: "model_change", model: "openai-codex/gpt-5.2-codex", role: "code-reviewer" }),
				JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
				JSON.stringify({
					type: "session_init",
					agentName: "code-reviewer",
					systemPrompt: oversizedPrompt,
					task: "Review delegated patch",
				}),
			].join("\n")}\n`,
			"utf8",
		);
		await utimes(sessionPath, baseTime, baseTime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();
		const ref = snapshot.refs.find(candidate => candidate.id === "0-Root.1-Reviewer");

		expect(ref).toMatchObject({
			id: "0-Root.1-Reviewer",
			agent: "code-reviewer",
			model: "openai-codex/gpt-5.2-codex",
			status: "completed",
		});
	});

	test("ingestTaskResults updates metadata synchronously without filesystem refresh", () => {
		const index = new SubagentIndex({ artifactsDir });
		const outputPath = path.join(artifactsDir, "2-Implement.md");
		const task = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "line 9"].join(
			"\n",
		);
		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "2-Implement", outputPath, task, durationMs: 321, tokens: 77 }),
				thinkingLevel: "medium",
				tokenCapacity: 128_000,
				startedAt: 1_739_603_401_000,
				sessionId: "sess-1234",
				parentAgentName: "orchestrator",
			} as SingleResult,
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]).toMatchObject({
			id: "2-Implement",
			status: "completed",
			thinkingLevel: "medium",
			tokenCapacity: 128_000,
			elapsedMs: 321,
			sessionId: "sess-1234",
			parentAgentName: "orchestrator",
		});
		expect(snapshot.refs[0]?.assignmentPreview?.split("\n")).toHaveLength(8);
	});

	test("ingestTaskResults keeps session routing metadata from live updates", () => {
		const index = new SubagentIndex({ artifactsDir });
		const outputPath = path.join(artifactsDir, "2-Implement.md");

		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "2-Implement", outputPath }),
				sessionId: "sess-child-1234567890",
				parentSessionId: "sess-parent-abcdef",
				mcpServers: ["augment", "github"],
				tools: ["read", "grep", "submit_result"],
				abortReason: "User stopped from flight deck: duplicate workstream",
			} as SingleResult,
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({
			id: "2-Implement",
			sessionId: "sess-child-1234567890",
			mcpServers: ["augment", "github"],
			toolNames: ["read", "grep", "submit_result"],
			abortReason: "User stopped from flight deck: duplicate workstream",
		});
	});

	test("ingestTaskResults derives outcome from submit_result data payload", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "2-LintOutcome",
				extractedToolData: {
					submit_result: [{ data: { passed: true, summary: "No lint violations" } }],
				},
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]?.outcome).toEqual({
			status: "pass",
			label: "lint",
			summary: "No lint violations",
		});
	});

	test("ingestTaskResults prefers explicit submit_result outcome over derived data", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "2-ExplicitOutcome",
				extractedToolData: {
					submit_result: [
						{
							outcome: { status: "go", label: "review", summary: "Explicit approval" },
							data: { verdict: "no_go", summary: "Derived block" },
						},
					],
				},
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]?.outcome).toEqual({
			status: "go",
			label: "review",
			summary: "Explicit approval",
		});
	});


	test("ingestTaskResults skips template boilerplate when deriving context preview", () => {
		const index = new SubagentIndex({ artifactsDir });
		const task = [
			"═══════════Background═══════════",
			"<context>",
			"## Goal",
			"Shared orchestrator context",
			"</context>",
			"",
			"═══════════Task═══════════",
			"Your assignment is below. Your work begins now.",
			"<goal>",
			"## Target",
			"- Fix subagent title derivation fallback",
			"</goal>",
		].join("\n");

		index.ingestTaskResults([buildTaskResult({ id: "3-TitleFallback", task, description: undefined })]);
		const snapshot = index.getSnapshot();

		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]?.contextPreview).toBe("Fix subagent title derivation fallback");
		expect(snapshot.refs[0]?.contextPreview).not.toContain("Background");
	});

	test("ingestTaskResults includes cache usage in derived token totals", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "4-CacheAware",
				tokens: Number.NaN,
				usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 } as SingleResult["usage"],
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({ id: "4-CacheAware", tokens: 180 });
	});

	test("ingestTaskResults prefers explicit task tokens over usage totals", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "5-TotalTokens",
				tokens: 999,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 100,
					cacheWrite: 100,
					total_tokens: 42,
				} as unknown as SingleResult["usage"],
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({ id: "5-TotalTokens", tokens: 999 });
	});

	test("ingestTaskResults keeps provider totals when cache breakdown fields also exist", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "5-TotalWithCache",
				tokens: Number.NaN,
				usage: {
					cacheRead: 10,
					cacheWrite: 5,
					total_tokens: 80,
				} as unknown as SingleResult["usage"],
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({ id: "5-TotalWithCache", tokens: 80 });
	});

	test("ingestTaskResults derives totals from alternate provider field names", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "5-AltUsageFields",
				tokens: Number.NaN,
				usage: {
					inputTokens: 10,
					outputTokens: 8,
					cacheReadInputTokens: 4_000,
					cacheCreationInputTokens: 2_000,
				} as unknown as SingleResult["usage"],
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({ id: "5-AltUsageFields", tokens: 6_018 });
	});

	test("ingestTaskResults keeps provider, model, and last-activity metadata from live updates", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "5-LiveMetadata", tokens: 321, durationMs: 2_500 }),
				status: "running",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				lastUpdatedMs: 1_739_603_401_234,
			} as SingleResult,
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({
			id: "5-LiveMetadata",
			status: "running",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			lastUpdatedMs: 1_739_603_401_234,
		});
	});

	test("ingestTaskResults marks user-stopped aborts distinctly from generic cancellation", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			buildTaskResult({
				id: "6-UserStopped",
				aborted: true,
				abortReason: "User stopped: waiting on product decision",
			}),
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs[0]).toMatchObject({
			id: "6-UserStopped",
			status: "user_stopped",
			abortReason: "User stopped: waiting on product decision",
		});
	});

	test("live activity updates do not reshuffle running subagents that already have startedAt order", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "z-older", tokens: 11, durationMs: 10 }),
				status: "running",
				startedAt: 1_000,
				lastUpdatedMs: 1_100,
			} as SingleResult,
			{
				...buildTaskResult({ id: "a-newer", tokens: 22, durationMs: 20 }),
				status: "running",
				startedAt: 2_000,
				lastUpdatedMs: 2_100,
			} as SingleResult,
		]);

		expect(index.getSnapshot().refs.map(ref => ref.id)).toEqual(["a-newer", "z-older"]);
		expect(index.getSnapshot().groups.map(group => group.rootId)).toEqual(["a-newer", "z-older"]);

		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "z-older", tokens: 33, durationMs: 30 }),
				status: "running",
				startedAt: 1_000,
				lastUpdatedMs: 9_999,
			} as SingleResult,
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs.map(ref => ref.id)).toEqual(["a-newer", "z-older"]);
		expect(snapshot.groups.map(group => group.rootId)).toEqual(["a-newer", "z-older"]);
		expect(snapshot.refs.find(ref => ref.id === "z-older")).toMatchObject({
			lastUpdatedMs: 9_999,
			tokens: 33,
		});
	});

	test("ingesting live and final updates for same id keeps a single grouped ref", () => {
		const index = new SubagentIndex({ artifactsDir });

		index.ingestTaskResults([
			{ ...buildTaskResult({ id: "3-Implement", tokens: 11, durationMs: 12 }), status: "running" } as SingleResult,
		]);
		index.ingestTaskResults([
			{
				...buildTaskResult({ id: "3-Implement", tokens: 77, durationMs: 120 }),
				status: "completed",
			} as SingleResult,
		]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.groups).toHaveLength(1);
		expect(snapshot.groups[0]?.refs.map(ref => ref.id)).toEqual(["3-Implement"]);
		expect(snapshot.refs[0]).toMatchObject({
			id: "3-Implement",
			status: "completed",
			tokens: 77,
		});
	});

	test("ignores invalid task-result shapes without throwing", () => {
		const index = new SubagentIndex({ artifactsDir });

		expect(() =>
			index.ingestTaskResults([null, undefined, {}, { id: 99 }, { id: "", outputPath: 10 }]),
		).not.toThrow();
		expect(index.getSnapshot().refs).toEqual([]);
	});

	test("orders refs deterministically by recency then id", async () => {
		const older = new Date("2025-01-01T00:00:00.000Z");
		const newer = new Date("2025-01-02T00:00:00.000Z");
		await seedTranscript(artifactsDir, "b.jsonl", older);
		await seedTranscript(artifactsDir, "a.jsonl", older);
		await seedTranscript(artifactsDir, "z.jsonl", newer);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs.map(ref => ref.id)).toEqual(["z", "a", "b"]);
	});

	test("handles duplicate transcript ids with deterministic collision winner and warning", async () => {
		const tieTime = new Date("2025-01-01T00:00:00.000Z");
		const winnerPath = await seedTranscript(artifactsDir, "a/dup.jsonl", tieTime);
		await seedTranscript(artifactsDir, "b/dup.jsonl", tieTime);
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs.map(ref => ref.id)).toEqual(["dup"]);
		expect(snapshot.refs[0]?.sessionPath).toBe(winnerPath);
		expect(warnSpy).toHaveBeenCalled();
	});

	test("resolveSafePaths rejects out-of-root transcript paths", async () => {
		const outsideOutputPath = path.join(tempDir, "escape.md");
		await writeFile(outsideOutputPath, "escape", "utf8");

		const index = new SubagentIndex({ artifactsDir });
		index.ingestTaskResults([buildTaskResult({ id: "escape", outputPath: outsideOutputPath })]);

		const resolved = await index.resolveSafePaths("escape");

		expect(resolved.outputPath).toBeUndefined();
		expect(resolved.sessionPath).toBeUndefined();
	});

	test("task ingestion does not clobber discovered filesystem transcript paths", async () => {
		const now = new Date("2025-01-03T00:00:00.000Z");
		const safeSessionPath = await seedTranscript(artifactsDir, "safe.jsonl", now);
		const safeOutputPath = `${safeSessionPath.slice(0, -6)}.md`;
		await writeFile(safeOutputPath, "safe output", "utf8");

		const index = new SubagentIndex({ artifactsDir });
		await index.reconcile();

		const outsideOutputPath = path.join(tempDir, "outside.md");
		await writeFile(outsideOutputPath, "outside", "utf8");
		index.ingestTaskResults([buildTaskResult({ id: "safe", outputPath: outsideOutputPath })]);

		const resolved = await index.resolveSafePaths("safe");

		expect(resolved.sessionPath).toBe(safeSessionPath);
		expect(resolved.outputPath).toBe(safeOutputPath);
	});

	test("resolveSafePaths accepts contained paths with symlinked artifacts roots", async () => {
		const realArtifactsDir = path.join(tempDir, "real-artifacts");
		const linkedArtifactsDir = path.join(tempDir, "linked-artifacts");
		await mkdir(realArtifactsDir, { recursive: true });
		await symlink(realArtifactsDir, linkedArtifactsDir);

		const now = new Date("2025-01-04T00:00:00.000Z");
		const safeSessionPath = await seedTranscript(realArtifactsDir, "linked-safe.jsonl", now);
		const safeOutputPath = `${safeSessionPath.slice(0, -6)}.md`;
		await writeFile(safeOutputPath, "linked safe output", "utf8");

		const index = new SubagentIndex({ artifactsDir: linkedArtifactsDir });
		await index.reconcile();

		const resolved = await index.resolveSafePaths("linked-safe");

		expect(resolved.sessionPath).toBe(safeSessionPath);
		expect(resolved.outputPath).toBe(safeOutputPath);
	});

	test("resolveSafePaths rejects in-root aliasing to another subagent id", async () => {
		const now = new Date("2025-01-05T00:00:00.000Z");
		const betaSessionPath = await seedTranscript(artifactsDir, "beta.jsonl", now);
		const betaOutputPath = `${betaSessionPath.slice(0, -6)}.md`;
		await writeFile(betaOutputPath, "beta output", "utf8");

		const index = new SubagentIndex({ artifactsDir });
		await index.reconcile();
		index.ingestTaskResults([buildTaskResult({ id: "alpha", outputPath: betaOutputPath })]);

		const resolved = await index.resolveSafePaths("alpha");

		expect(resolved.outputPath).toBeUndefined();
		expect(resolved.sessionPath).toBeUndefined();
	});

	test("overlapping reconcile calls apply last invocation wins", async () => {
		class ControlledSubagentIndex extends SubagentIndex {
			constructor(
				artifactsPath: string,
				private readonly plannedScans: Array<() => Promise<any>>,
			) {
				super({ artifactsDir: artifactsPath });
			}

			protected override async scanArtifacts(): Promise<any> {
				const nextScan = this.plannedScans.shift();
				if (!nextScan) {
					return { entries: new Map(), artifactsRoot: undefined };
				}
				return nextScan();
			}
		}

		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const oldSessionPath = path.join(artifactsDir, "old.jsonl");
		const newSessionPath = path.join(artifactsDir, "new.jsonl");
		const oldResult = {
			entries: new Map([
				[
					"old",
					{
						id: "old",
						sessionPath: oldSessionPath,
						outputPath: `${oldSessionPath.slice(0, -6)}.md`,
						mtimeMs: 1,
						lastSeenOrder: 1,
						sourcePath: oldSessionPath,
					},
				],
			]),
			artifactsRoot: artifactsDir,
		};
		const newResult = {
			entries: new Map([
				[
					"new",
					{
						id: "new",
						sessionPath: newSessionPath,
						outputPath: `${newSessionPath.slice(0, -6)}.md`,
						mtimeMs: 10,
						lastSeenOrder: 2,
						sourcePath: newSessionPath,
					},
				],
			]),
			artifactsRoot: artifactsDir,
		};

		const index = new ControlledSubagentIndex(artifactsDir, [() => first.promise, () => second.promise]);
		const firstReconcile = index.reconcile();
		await Promise.resolve();
		const secondReconcile = index.reconcile();

		second.resolve(newResult);
		await secondReconcile;
		first.resolve(oldResult);
		await firstReconcile;

		expect(index.getSnapshot().refs.map(ref => ref.id)).toEqual(["new"]);
	});
});

describe("SubagentIndex — filesystem agent hydration", () => {
	let tempDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-agent-"));
		artifactsDir = path.join(tempDir, "artifacts");
		await mkdir(artifactsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("reconcile hydrates agent from session_init agentName in JSONL", async () => {
		const now = new Date("2025-06-01T00:00:00.000Z");
		const jsonlPath = path.join(artifactsDir, "lint-001.jsonl");
		await writeFile(jsonlPath, '{"type":"session_init","task":"run lint checks","agentName":"lint"}\n', "utf8");
		await utimes(jsonlPath, now, now);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]?.agent).toBe("lint");
		expect(snapshot.refs[0]?.id).toBe("lint-001");
	});

	test("reconcile leaves agent undefined when session_init has no agentName", async () => {
		const now = new Date("2025-06-01T00:00:00.000Z");
		const jsonlPath = path.join(artifactsDir, "old-001.jsonl");
		// Old-format file without agentName field
		await writeFile(jsonlPath, '{"type":"session_init","task":"legacy task"}\n', "utf8");
		await utimes(jsonlPath, now, now);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]?.agent).toBeUndefined();
	});

	test("live task result agent takes priority over filesystem-hydrated agent", async () => {
		const now = new Date("2025-06-01T00:00:00.000Z");
		const jsonlPath = path.join(artifactsDir, "2-Commit.jsonl");
		// Filesystem has incorrect/stale agentName
		await writeFile(jsonlPath, '{"type":"session_init","task":"commit changes","agentName":"implement"}\n', "utf8");
		await utimes(jsonlPath, now, now);

		const index = new SubagentIndex({ artifactsDir });
		await index.reconcile();

		// Live task result has the correct agent
		index.ingestTaskResults([buildTaskResult({ id: "2-Commit", agent: "commit" })]);

		const snapshot = index.getSnapshot();
		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]?.agent).toBe("commit");
	});

	test("reconcile handles malformed first JSONL line without throwing", async () => {
		const now = new Date("2025-06-01T00:00:00.000Z");
		const jsonlPath = path.join(artifactsDir, "broken-001.jsonl");
		await writeFile(jsonlPath, 'not-valid-json\n{"type":"session_init"}\n', "utf8");
		await utimes(jsonlPath, now, now);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs).toHaveLength(1);
		expect(snapshot.refs[0]?.agent).toBeUndefined();
	});

	test("reconcile hydrates agents for multiple specialized children", async () => {
		const now = new Date("2025-06-01T00:00:00.000Z");
		const slugs = ["lint", "code-reviewer", "commit"];
		for (const slug of slugs) {
			const jsonlPath = path.join(artifactsDir, `1-${slug}.jsonl`);
			await writeFile(
				jsonlPath,
				`{"type":"session_init","task":"task for ${slug}","agentName":"${slug}"}\n`,
				"utf8",
			);
			await utimes(jsonlPath, now, now);
		}

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		expect(snapshot.refs).toHaveLength(3);
		const agentNames = snapshot.refs.map(r => r.agent).sort();
		expect(agentNames).toEqual(["code-reviewer", "commit", "lint"]);
	});
});

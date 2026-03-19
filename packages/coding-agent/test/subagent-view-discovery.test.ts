import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentIndex } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-index";

const ROOT_TASK_ID = "0-WorkflowWorker";
const NESTED_TASK_ID = `${ROOT_TASK_ID}.0-Scout`;

/**
 * Seeds the same nested artifact layout that the real coding agent
 * produces when a parent task spawns a child subagent:
 *
 *   <artifactsDir>/
 *     0-WorkflowWorker.jsonl
 *     0-WorkflowWorker/
 *       0-WorkflowWorker.0-Scout.jsonl
 *
 * Both files get a fixed mtime so snapshot ordering is deterministic.
 */
async function seedNestedArtifacts(artifactsDir: string): Promise<void> {
	const rootTaskSessionFile = path.join(artifactsDir, `${ROOT_TASK_ID}.jsonl`);
	const nestedArtifactsDir = rootTaskSessionFile.slice(0, -6);
	const nestedTaskSessionFile = path.join(nestedArtifactsDir, `${NESTED_TASK_ID}.jsonl`);

	await mkdir(nestedArtifactsDir, { recursive: true });
	await writeFile(rootTaskSessionFile, '{"type":"session_init","task":"Investigate the broken workflow"}\n', "utf8");
	await writeFile(nestedTaskSessionFile, '{"type":"session_init","task":"Trace the nested worker"}\n', "utf8");
	const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
	await utimes(rootTaskSessionFile, fixedMtime, fixedMtime);
	await utimes(nestedTaskSessionFile, fixedMtime, fixedMtime);
}

describe("SubagentIndex nested discovery", () => {
	let tempDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-view-"));
		artifactsDir = path.join(tempDir, "artifacts");
		await mkdir(artifactsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("reconcile discovers nested subagent transcripts in child artifact directories before task results are written", async () => {
		await seedNestedArtifacts(artifactsDir);
		const index = new SubagentIndex({ artifactsDir });

		const snapshot = await index.reconcile();
		const ids = snapshot.refs.map(ref => ref.id);

		expect(ids).toContain(ROOT_TASK_ID);
		expect(ids).toContain(NESTED_TASK_ID);
	});

	test("snapshot refs for filesystem-only discovered subagents carry correct hierarchy and sidebar-facing metadata", async () => {
		await seedNestedArtifacts(artifactsDir);
		const index = new SubagentIndex({ artifactsDir });

		const snapshot = await index.reconcile();

		const rootRef = snapshot.refs.find(ref => ref.id === ROOT_TASK_ID);
		const nestedRef = snapshot.refs.find(ref => ref.id === NESTED_TASK_ID);

		expect(rootRef).toBeDefined();
		expect(nestedRef).toBeDefined();

		// Root task: depth 0, no parent, self-rooted
		expect(rootRef).toMatchObject({
			id: ROOT_TASK_ID,
			rootId: ROOT_TASK_ID,
			parentId: undefined,
			depth: 0,
			status: "completed",
		});

		// Nested task: depth 1, parented under root
		expect(nestedRef).toMatchObject({
			id: NESTED_TASK_ID,
			rootId: ROOT_TASK_ID,
			parentId: ROOT_TASK_ID,
			depth: 1,
			status: "completed",
		});

		// Both refs must carry session paths so the sidebar can resolve transcripts
		expect(rootRef!.sessionPath).toMatch(/0-WorkflowWorker\.jsonl$/);
		expect(nestedRef!.sessionPath).toMatch(/0-WorkflowWorker\.0-Scout\.jsonl$/);
	});

	test("snapshot groups nest child refs under a single root group", async () => {
		await seedNestedArtifacts(artifactsDir);
		const index = new SubagentIndex({ artifactsDir });

		const snapshot = await index.reconcile();

		// Both refs share the same root, so exactly one group is expected
		expect(snapshot.groups).toHaveLength(1);
		const group = snapshot.groups[0]!;
		expect(group.rootId).toBe(ROOT_TASK_ID);

		const groupIds = group.refs.map(ref => ref.id);
		expect(groupIds).toContain(ROOT_TASK_ID);
		expect(groupIds).toContain(NESTED_TASK_ID);
		// Root ref must come first within its group
		expect(groupIds[0]).toBe(ROOT_TASK_ID);
	});
});

describe("SubagentIndex delegation sidecar wiring", () => {
	let tempDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-sidecar-"));
		artifactsDir = path.join(tempDir, "artifacts");
		await mkdir(artifactsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	const SIDECAR_DATA = {
		contract_version: "omp-delegation/v1",
		envelope: {
			id: "del_abc123def456",
			created_at: "2025-06-01T12:00:00.000Z",
			parent_envelope_id: "del_parent999",
		},
		input_policy: { mode: "full" },
		context: {
			repo_root: "/home/user/my-project",
			plan_path: ".omp/sessions/plans/my-plan/plan.md",
			git: { branch: "feature/my-feature", commit: "abc1234" },
			worktree: { path: "/home/user/my-project/.worktrees/my-feature" },
		},
		roles: { delegator: "orchestrator", delegate: "implement" },
		task: {
			id: "WorkflowWorker",
			title: "Implement the workflow worker",
			description: "Build the full workflow worker pipeline.",
			intent: "Ensure worker handles all edge cases.",
			constraints: [],
			acceptance_criteria: [],
		},
		retry_context: { attempt: 2 },
		quality_report: {
			warnings: ["Large context window usage"],
			errors: [],
		},
		validation_passed: true,
	};

	async function seedWithSidecar(dir: string, taskItemId: string, sidecar: object): Promise<void> {
		const transcriptPath = path.join(dir, `0-${taskItemId}.jsonl`);
		const envelopeId = (sidecar as any).envelope?.id ?? "del_unknown";
		const sidecarPath = path.join(dir, `${envelopeId}-delegation-meta.json`);
		await writeFile(transcriptPath, '{"type":"session_init","task":"test"}\n', "utf8");
		await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
		const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
		await utimes(transcriptPath, fixedMtime, fixedMtime);
	}

	test("reconcile populates delegation metadata from sidecar", async () => {
		await seedWithSidecar(artifactsDir, "WorkflowWorker", SIDECAR_DATA);
		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		const ref = snapshot.refs.find(r => r.id === "0-WorkflowWorker");
		expect(ref).toBeDefined();
		expect(ref).toMatchObject({
			taskId: "WorkflowWorker",
			taskTitle: "Implement the workflow worker",
			taskIntent: "Ensure worker handles all edge cases.",
			planPath: ".omp/sessions/plans/my-plan/plan.md",
			branch: "feature/my-feature",
			repoRoot: "/home/user/my-project",
			worktreePath: "/home/user/my-project/.worktrees/my-feature",
			delegatorRole: "orchestrator",
			delegateRole: "implement",
			inputProfile: "full",
			envelopeId: "del_abc123def456",
			parentEnvelopeId: "del_parent999",
			retryAttempt: 2,
			qualityWarnings: ["Large context window usage"],
		});
	});

	test("refs without a matching sidecar have no delegation fields", async () => {
		const transcriptPath = path.join(artifactsDir, "0-Standalone.jsonl");
		await writeFile(transcriptPath, '{"type":"session_init","task":"test"}\n', "utf8");
		const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
		await utimes(transcriptPath, fixedMtime, fixedMtime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		const ref = snapshot.refs.find(r => r.id === "0-Standalone");
		expect(ref).toBeDefined();
		expect(ref!.taskId).toBeUndefined();
		expect(ref!.envelopeId).toBeUndefined();
		expect(ref!.delegatorRole).toBeUndefined();
	});

	test("malformed sidecar JSON is silently skipped", async () => {
		const transcriptPath = path.join(artifactsDir, "0-Broken.jsonl");
		const sidecarPath = path.join(artifactsDir, "del_broken-delegation-meta.json");
		await writeFile(transcriptPath, '{"type":"session_init","task":"test"}\n', "utf8");
		await writeFile(sidecarPath, "not valid json {{{", "utf8");
		const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
		await utimes(transcriptPath, fixedMtime, fixedMtime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		const ref = snapshot.refs.find(r => r.id === "0-Broken");
		expect(ref).toBeDefined();
		expect(ref!.taskId).toBeUndefined();
	});

	test("sidecar without task.id is ignored", async () => {
		const transcriptPath = path.join(artifactsDir, "0-NoTaskId.jsonl");
		const sidecarPath = path.join(artifactsDir, "del_notask-delegation-meta.json");
		await writeFile(transcriptPath, '{"type":"session_init","task":"test"}\n', "utf8");
		await writeFile(sidecarPath, JSON.stringify({ envelope: { id: "del_notask" }, task: {} }), "utf8");
		const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
		await utimes(transcriptPath, fixedMtime, fixedMtime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		const ref = snapshot.refs.find(r => r.id === "0-NoTaskId");
		expect(ref).toBeDefined();
		expect(ref!.taskId).toBeUndefined();
	});

	test("nested subagent picks up sidecar from its directory", async () => {
		// Layout:
		//   <artifactsDir>/0-WorkflowWorker.jsonl
		//   <artifactsDir>/0-WorkflowWorker/
		//     0-WorkflowWorker.0-Scout.jsonl
		//     <envelopeId>-delegation-meta.json  (task.id = "Scout")
		const rootTranscript = path.join(artifactsDir, "0-WorkflowWorker.jsonl");
		const nestedDir = path.join(artifactsDir, "0-WorkflowWorker");
		const nestedTranscript = path.join(nestedDir, "0-WorkflowWorker.0-Scout.jsonl");
		const nestedSidecar = path.join(nestedDir, "del_nested123-delegation-meta.json");

		await mkdir(nestedDir, { recursive: true });
		await writeFile(rootTranscript, '{"type":"session_init","task":"root"}\n', "utf8");
		await writeFile(nestedTranscript, '{"type":"session_init","task":"nested"}\n', "utf8");
		await writeFile(
			nestedSidecar,
			JSON.stringify({
				envelope: { id: "del_nested123" },
				task: { id: "Scout", title: "Scout the area" },
				roles: { delegator: "implement", delegate: "explore" },
				context: { repo_root: "/repo" },
				input_policy: { mode: "lean" },
			}),
			"utf8",
		);
		const fixedMtime = new Date("2025-01-01T00:00:00.000Z");
		await utimes(rootTranscript, fixedMtime, fixedMtime);
		await utimes(nestedTranscript, fixedMtime, fixedMtime);

		const index = new SubagentIndex({ artifactsDir });
		const snapshot = await index.reconcile();

		const rootRef = snapshot.refs.find(r => r.id === "0-WorkflowWorker");
		const nestedRef = snapshot.refs.find(r => r.id === "0-WorkflowWorker.0-Scout");

		// Root has no sidecar
		expect(rootRef).toBeDefined();
		expect(rootRef!.taskId).toBeUndefined();

		// Nested picks up its directory's sidecar
		expect(nestedRef).toBeDefined();
		expect(nestedRef).toMatchObject({
			taskId: "Scout",
			taskTitle: "Scout the area",
			delegatorRole: "implement",
			delegateRole: "explore",
			repoRoot: "/repo",
			inputProfile: "lean",
			envelopeId: "del_nested123",
		});
	});
});

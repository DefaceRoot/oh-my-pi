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

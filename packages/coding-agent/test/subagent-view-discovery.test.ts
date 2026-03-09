import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

const SESSION_FILE_NAME = "parent.jsonl";
const ROOT_TASK_ID = "0-WorkflowWorker";
const NESTED_TASK_ID = `${ROOT_TASK_ID}.0-Scout`;

function createMode(tempDir: string, entries: unknown[] = []): InteractiveMode {
	const sessionFile = path.join(tempDir, SESSION_FILE_NAME);
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & {
		sessionManager: {
			getBranch: () => unknown[];
			getSessionFile: () => string;
		};
	};
	mode.sessionManager = {
		getBranch: () => entries,
		getSessionFile: () => sessionFile,
	};
	return mode;
}

async function seedNestedArtifacts(tempDir: string): Promise<void> {
	const sessionFile = path.join(tempDir, SESSION_FILE_NAME);
	const artifactsDir = sessionFile.slice(0, -6);
	const rootTaskSessionFile = path.join(artifactsDir, `${ROOT_TASK_ID}.jsonl`);
	const nestedArtifactsDir = rootTaskSessionFile.slice(0, -6);
	const nestedTaskSessionFile = path.join(nestedArtifactsDir, `${NESTED_TASK_ID}.jsonl`);

	await writeFile(sessionFile, "", "utf8");
	await mkdir(nestedArtifactsDir, { recursive: true });
	await writeFile(rootTaskSessionFile, '{"type":"session_init","task":"Investigate the broken workflow"}\n', "utf8");
	await writeFile(nestedTaskSessionFile, '{"type":"session_init","task":"Trace the nested worker"}\n', "utf8");
}

describe("InteractiveMode subagent discovery", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-view-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("collectSubagentViewRefs finds nested subagent transcripts in child artifact directories before task results are written", async () => {
		await seedNestedArtifacts(tempDir);
		const mode = createMode(tempDir);

		const refs = (mode as any).collectSubagentViewRefs();
		const ids = refs.map((ref: { id: string }) => ref.id);

		expect(ids).toContain(ROOT_TASK_ID);
		expect(ids).toContain(NESTED_TASK_ID);
	});

	test("buildSidebarSubagents includes nested delegated subagents discovered only from filesystem state", async () => {
		await seedNestedArtifacts(tempDir);
		const mode = createMode(tempDir);

		const rows = (mode as any).buildSidebarSubagents([]);

		expect(rows).toBeDefined();
		expect(
			rows.map((row: { id: string; depth: number; isRoot: boolean }) => ({
				id: row.id,
				depth: row.depth,
				isRoot: row.isRoot,
			})),
		).toEqual([
			{ id: ROOT_TASK_ID, depth: 0, isRoot: true },
			{ id: NESTED_TASK_ID, depth: 1, isRoot: false },
		]);
	});
});

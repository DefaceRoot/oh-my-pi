import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSessionsDirectory } from "./session-usage";

async function withTempDir<T>(fn: (dirPath: string) => Promise<T>): Promise<T> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-test-"));
	try {
		return await fn(tempDir);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("session-usage", () => {
	test("counts standalone task calls, embedded task calls, and model changes", async () => {
		await withTempDir(async (tempDir) => {
			const sessionsDir = path.join(tempDir, "sessions");
			const nestedDir = path.join(sessionsDir, "nested");
			const sessionFile = path.join(nestedDir, "sample.jsonl");

			await fs.promises.mkdir(nestedDir, { recursive: true });

			const fixtureLines = [
				JSON.stringify({
					type: "tool_call",
					tool: "task",
					input: { agent: "task" },
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								toolName: "task",
								input: { agent: "explore" },
							},
						],
					},
				}),
				JSON.stringify({
					type: "model_change",
					role: "orchestrator",
					model: "anthropic/claude-sonnet-4-6",
				}),
				JSON.stringify({
					type: "session",
					id: "shape-not-counted",
				}),
				"{ malformed-json-line",
			].join("\n");

			await fs.promises.writeFile(sessionFile, fixtureLines, "utf8");

			const report = await analyzeSessionsDirectory(sessionsDir);

			expect(report.files_scanned).toBe(1);
			expect(report.records_processed).toBe(4);
			expect(report.task_agents).toEqual({ implement: 1, explore: 1 });
			expect(report.model_roles).toEqual({ orchestrator: 1 });
			expect(report.model_models).toEqual({ "anthropic/claude-sonnet-4-6": 1 });
		});
	});

	test("returns empty report when sessions directory does not exist", async () => {
		await withTempDir(async (tempDir) => {
			const missingDir = path.join(tempDir, "does-not-exist");
			const report = await analyzeSessionsDirectory(missingDir);

			expect(report).toEqual({
				task_agents: {},
				model_roles: {},
				model_models: {},
				files_scanned: 0,
				records_processed: 0,
			});
		});
	});

	test("handles empty jsonl files gracefully", async () => {
		await withTempDir(async (tempDir) => {
			const sessionsDir = path.join(tempDir, "sessions");
			const emptyFile = path.join(sessionsDir, "empty.jsonl");

			await fs.promises.mkdir(sessionsDir, { recursive: true });
			await fs.promises.writeFile(emptyFile, "", "utf8");

			const report = await analyzeSessionsDirectory(sessionsDir);

			expect(report.files_scanned).toBe(1);
			expect(report.records_processed).toBe(0);
			expect(report.task_agents).toEqual({});
			expect(report.model_roles).toEqual({});
			expect(report.model_models).toEqual({});
		});
	});
});

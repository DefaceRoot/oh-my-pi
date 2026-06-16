import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listAllSessionFiles, parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-session-discovery-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

async function writeEmptySessionFile(sessionsRoot: string, encodedProject: string, fileName: string): Promise<string> {
	const filePath = path.join(sessionsRoot, encodedProject, fileName);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, "");
	return path.resolve(filePath);
}

function assistantEntry(): Record<string, unknown> {
	return {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

describe("stats session discovery", () => {
	it("returns the union of extra session roots without duplicate absolute paths", async () => {
		if (!tempDir) throw new Error("TempDir missing");
		const rootA = tempDir.join("root-a", "sessions");
		const rootB = tempDir.join("root-b", "sessions");
		const fileA = await writeEmptySessionFile(rootA, "--work--proj-a", "a.jsonl");
		const fileB = await writeEmptySessionFile(rootB, "--work--proj-b", "a.jsonl");

		const files = await listAllSessionFiles([rootA, rootB, rootA]);
		const resolvedFiles = files.map(file => path.resolve(file));

		expect(resolvedFiles).toContain(fileA);
		expect(resolvedFiles).toContain(fileB);
		expect(new Set(resolvedFiles).size).toBe(resolvedFiles.length);
	});

	it("derives decoded folders from the nearest sessions marker", async () => {
		if (!tempDir) throw new Error("TempDir missing");
		const sessionFile = path.join(tempDir.join("external", "sessions", "--work--proj"), "s.jsonl");
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await Bun.write(sessionFile, `${JSON.stringify(assistantEntry())}\n`);

		const result = await parseSessionFile(sessionFile);

		expect(result.stats).toHaveLength(1);
		expect(result.stats[0]?.folder).toBe("/work/proj");
	});
});

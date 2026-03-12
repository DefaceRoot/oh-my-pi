import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as ToolSession;
}

async function runTaskIndexDirectImportFromRepoRoot(): Promise<{
	exitCode: number;
	stderr: string;
	stdout: string;
}> {
	const process = Bun.spawn(["bun", "-e", "import('./packages/coding-agent/src/task/index.ts')"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [exitCode, stderr, stdout] = await Promise.all([
		process.exited,
		new Response(process.stderr).text(),
		new Response(process.stdout).text(),
	]);

	return { exitCode, stderr, stdout };
}

describe("task index direct import regression", () => {
	it("imports task/index.ts from repo root without circular initialization errors", async () => {
		const result = await runTaskIndexDirectImportFromRepoRoot();
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("keeps task tool factory registered and resolvable", async () => {
		const tool = await BUILTIN_TOOLS.task(createSession(repoRoot));
		expect(tool?.name).toBe("task");
	});
});

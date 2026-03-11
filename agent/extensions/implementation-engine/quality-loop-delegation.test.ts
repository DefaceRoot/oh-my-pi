import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");
const implementAgentPath = path.join(repoRoot, "agent/agents/implement.md");
const workerProtocolPath = path.join(repoRoot, "agent/rules/worker-protocol.md");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

function extractToolCallBlock(source: string): string {
	const start = source.indexOf('pi.on("tool_call", async (event, ctx) => {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("tool_result", async (event, ctx) => {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("implementation quality-loop delegation", () => {
	test("implementation worker blocks isolated quality-loop handoffs", async () => {
		const source = await readFile(implementationEnginePath);
		const toolCallBlock = extractToolCallBlock(source);

		expect(toolCallBlock).toMatch(/activeImplementationWorkerGate[\s\S]*taskInput\.isolated\s*===\s*true/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"lint"/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"code-reviewer"/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"commit"/);
		expect(toolCallBlock).toMatch(/quality-loop subagents must reuse the current workspace/i);
	});

	test("implementation agent prompt requires dedicated lint, review, and commit agents", async () => {
		const content = await readFile(implementAgentPath);

		expect(content).toContain("Use the Task tool only as delegation transport");
		expect(content).toContain("dedicated `lint`, `code-reviewer`, and `commit` agents");
		expect(content).toContain("Never substitute `implement` or `explore` for these quality gates");
		expect(content).toMatch(/never set `isolated: true` for these quality-loop delegations/i);
	});

	test("worker protocol mirrors the dedicated quality-loop requirement", async () => {
		const content = await readFile(workerProtocolPath);

		expect(content).toContain("Use the Task tool only as delegation transport");
		expect(content).toContain("dedicated `lint`, `code-reviewer`, and `commit` agents");
		expect(content).toContain("Never set `isolated: true` for these quality-loop delegations");
	});
});

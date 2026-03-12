import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

function extractToolCallBlock(source: string): string {
	const start = source.indexOf('pi.on("tool_call", async (event, ctx) => {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("tool_result", async (event, ctx) => {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractToolResultBlock(source: string): string {
	const start = source.indexOf('pi.on("tool_result", async (event, ctx) => {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("agent_end", async (_event, ctx) => {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("implementation worker scope wiring", () => {
	test("task tool calls scope verifier and code-reviewer assignments to authoritative edited files", async () => {
		const source = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(source);


		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"code-reviewer"/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"verifier"/);
		expect(toolCallBlock).toMatch(/captureImplementationWorkerOwnedFiles\(\)/);
		expect(toolCallBlock).toMatch(/applyScopedFileMetadataToTaskInput\(/);
		expect(toolCallBlock).toMatch(/scopeByUnitId:\s*implementationUnitScopeById/);
		expect(toolCallBlock).toMatch(/fallbackScope:\s*ownedFiles/);
	});


	test("task tool canonicalizes coderabbit assignments before execution", async () => {
		const source = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(source);


		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"coderabbit"/);
		expect(toolCallBlock).toMatch(/rewriteCodeRabbitTaskInput\(/);
		expect(toolCallBlock).toMatch(/baseBranch:\s*last\.baseBranch/);
		expect(toolCallBlock).toMatch(/worktreePath:\s*last\.worktreePath/);
	});


	test("review and remediation prompts require explicit coderabbit-agent handoff", async () => {
		const source = await readExtensionSource();


		expect(source).toContain("spawn exactly one Task call with `agent:");
		expect(source).toContain("Parent must hand the coderabbit subagent the exact review scope");
		expect(source).toContain("Do NOT ask the coderabbit subagent to perform manual review");
	});


	test("task results emit per-unit scope metadata for later verifier fan-out and coderrabbit context", async () => {
		const source = await readExtensionSource();
		const toolResultBlock = extractToolResultBlock(source);


		expect(toolResultBlock).toMatch(/collectTaskUnitsFromTaskInput\(taskInput\)/);
		expect(toolResultBlock).toMatch(/collectTaskUnitsFromTaskResultDetails\(event\.details\)/);
		expect(toolResultBlock).toMatch(/mergeTaskUnitsForScope\(inputUnits,\s*resultUnits\)/);
		expect(toolResultBlock).toMatch(/createImplementationTaskScopeMetadata\(/);
		expect(toolResultBlock).toMatch(/implementationTaskScopeMetadata/);
		expect(toolResultBlock).toMatch(/implementationUnitScopeById\s*=\s*new Map/);
	});
});

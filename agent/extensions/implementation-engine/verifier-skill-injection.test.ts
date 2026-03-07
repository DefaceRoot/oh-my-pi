import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

function extractToolCallBlock(source: string): string {
	const start = source.indexOf('pi.on("tool_call"');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("tool_result"', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("verifier agent skill auto-injection", () => {
	test("tool_call handler auto-injects qa-test-planner for verifier agent", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// The tool_call handler must route through taskAgent and inject verifier defaults
		expect(toolCallBlock).toMatch(/const taskAgent\s*=\s*typeof taskInput\.agent\s*===\s*"string"/);
		expect(toolCallBlock).toMatch(/if\s*\(taskAgent\s*===\s*"verifier"\)/);
		expect(toolCallBlock).toMatch(/VERIFIER_DEFAULT_SKILLS\s*=\s*\["qa-test-planner"\]/);
	});

	test("auto-injection preserves existing skills array", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// Must spread existing skills and only add missing ones
		expect(toolCallBlock).toMatch(/existingSkills\s*=\s*Array\.isArray\(taskInput\.skills\)/);
		expect(toolCallBlock).toMatch(/const missingSkills\s*=\s*VERIFIER_DEFAULT_SKILLS\.filter\([\s\S]*!existingSkills\.includes\(s\)/);
		expect(toolCallBlock).toMatch(/taskInput\.skills\s*=\s*\[\.\.\.existingSkills,\s*\.\.\.missingSkills\]/);
	});

	test("orchestrator prompts mention auto-injected verifier skills", async () => {
		const content = await readExtensionSource();

		// Canonical verifier workflow prompts must keep stable semantic anchors
		const verifierWorkflowHeadings = content.match(/Verifier Workflow \(MANDATORY\):/g) ?? [];
		expect(verifierWorkflowHeadings.length).toBeGreaterThanOrEqual(2);
		expect(content).toContain("The `qa-test-planner` skill is auto-injected for verifier agents.");
		const plannedModeSection = content.match(
			/PLANNED MODE \(phases from a plan\):[\s\S]*?AD HOC MODE \(no plan, direct requests\):/,
		);
		expect(plannedModeSection).not.toBeNull();
		expect(plannedModeSection![0]).toMatch(
			/After each phase\\?'s implementation task batch completes, spawn parallel verifiers/,
		);
		expect(plannedModeSection![0]).toContain("`qa-test-planner` skill is auto-injected");
	});
});

describe("verifier context sanitization", () => {
	test("detects full-plan marker and sanitizes context", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// Must define the marker constant and use it for detection
		expect(content).toMatch(/VERIFIER_CONTEXT_FULL_PLAN_MARKER\s*=\s*"FULL PLAN DOCUMENT \(verbatim\)"/);
		expect(toolCallBlock).toMatch(/rawCtx\.includes\(VERIFIER_CONTEXT_FULL_PLAN_MARKER\)/);
	});

	test("guards by context size threshold", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// Must define a size threshold constant and use it
		expect(content).toMatch(/VERIFIER_CONTEXT_SIZE_THRESHOLD\s*=\s*\d+/);
		expect(toolCallBlock).toMatch(/rawCtx\.length\s*>\s*VERIFIER_CONTEXT_SIZE_THRESHOLD/);
	});

	test("sanitized context references plan file path and read-directly intent", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// The replacement context must point to the plan file reference
		expect(toolCallBlock).toMatch(/Plan file:.*planRef/);
		// Must instruct verifier to read the file directly
		expect(toolCallBlock).toMatch(/Read the plan file directly/);
		// Must NOT include inline plan text
		expect(toolCallBlock).toMatch(/NOT included in this context/);
	});

	test("skips sanitization when no plan reference is available", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// Context assignment must stay guarded by planRef inside the verifier-only branch
		const verifierStart = toolCallBlock.indexOf('if (taskAgent === "verifier") {');
		expect(verifierStart).toBeGreaterThan(-1);
		const scopedMetadataStart = toolCallBlock.indexOf(
			'if (taskAgent === "code-reviewer" || taskAgent === "verifier") {',
			verifierStart + 1,
		);
		expect(scopedMetadataStart).toBeGreaterThan(verifierStart);
		const verifierBranch = toolCallBlock.slice(verifierStart, scopedMetadataStart);

		const guardedContextAssignment = verifierBranch.match(
			/if\s*\(planRef\)\s*\{[\s\S]*?taskInput\.context\s*=/,
		);
		expect(guardedContextAssignment).not.toBeNull();
		const contextAssignments = verifierBranch.match(/taskInput\.context\s*=\s*(?![=])/g) ?? [];
		expect(contextAssignments).toHaveLength(1);
	});

	test("planRef falls back to latest plan metadata when last.planFilePath is unset", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// The planRef derivation must include a metadata fallback
		expect(toolCallBlock).toMatch(/findLatestPlanMetadata\(ctx\)/);
		expect(toolCallBlock).toMatch(/resolvePlanFilePath\(meta\.planFilePath/);
		// Fallback must be exception-safe (inside try/catch)
		const fallbackBlock = toolCallBlock.match(/const planRef[\s\S]*?\}\)\(\)/);
		expect(fallbackBlock).not.toBeNull();
		expect(fallbackBlock![0]).toMatch(/try\s*\{/);
		expect(fallbackBlock![0]).toMatch(/catch/);
	});

	test("sanitization is scoped only to verifier agent tasks", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// The context sanitization code must be inside the verifier agent block
		expect(toolCallBlock).toMatch(/if\s*\(taskAgent\s*===\s*"verifier"\)[\s\S]*contextLooksLikeFullPlan/);
	});

	test("existing verifier skill injection is preserved alongside sanitization", async () => {
		const content = await readExtensionSource();
		const toolCallBlock = extractToolCallBlock(content);

		// Both features must coexist in the verifier block:
		// 1. Skill injection
		expect(toolCallBlock).toMatch(/VERIFIER_DEFAULT_SKILLS\s*=\s*\["qa-test-planner"\]/);
		expect(toolCallBlock).toMatch(/taskInput\.skills\s*=\s*\[\.\.\.existingSkills/);
		// 2. Context sanitization
		expect(toolCallBlock).toMatch(/VERIFIER_CONTEXT_FULL_PLAN_MARKER/);
		expect(toolCallBlock).toMatch(/taskInput\.context\s*=/);
	});
});
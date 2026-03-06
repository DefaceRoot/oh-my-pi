import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

describe("verifier agent skill auto-injection", () => {
	test("tool_call handler auto-injects qa-test-planner for verifier agent", async () => {
		const content = await readExtensionSource();

		// The tool_call handler must check for agent === "verifier" and inject skills
		expect(content).toMatch(/taskInput\.agent\s*===\s*"verifier"/);
		expect(content).toMatch(/VERIFIER_DEFAULT_SKILLS\s*=\s*\["qa-test-planner"\]/);
	});

	test("auto-injection preserves existing skills array", async () => {
		const content = await readExtensionSource();

		// Must spread existing skills and only add missing ones
		expect(content).toMatch(/existingSkills.*Array\.isArray.*taskInput\.skills/);
		expect(content).toMatch(/const missingSkills\s*=\s*VERIFIER_DEFAULT_SKILLS\.filter\([\s\S]*!existingSkills\.includes\(s\)/);
		expect(content).toMatch(/taskInput\.skills\s*=\s*\[\.\.\.existingSkills,\s*\.\.\.missingSkills\]/);
	});

	test("orchestrator prompts mention auto-injected verifier skills", async () => {
		const content = await readExtensionSource();

		// All verifier spawn examples should note skills are auto-injected
		const autoInjectMentions = content.match(/qa-test-planner.*skill.*auto-injected/gi) ?? [];
		expect(autoInjectMentions.length).toBeGreaterThanOrEqual(3);
	});
});

describe("verifier context sanitization", () => {
	test("detects full-plan marker and sanitizes context", async () => {
		const content = await readExtensionSource();

		// Must define the marker constant and use it for detection
		expect(content).toMatch(/VERIFIER_CONTEXT_FULL_PLAN_MARKER\s*=\s*"FULL PLAN DOCUMENT \(verbatim\)"/);
		expect(content).toMatch(/rawCtx\.includes\(VERIFIER_CONTEXT_FULL_PLAN_MARKER\)/);
	});

	test("guards by context size threshold", async () => {
		const content = await readExtensionSource();

		// Must define a size threshold constant and use it
		expect(content).toMatch(/VERIFIER_CONTEXT_SIZE_THRESHOLD\s*=\s*\d+/);
		expect(content).toMatch(/rawCtx\.length\s*>\s*VERIFIER_CONTEXT_SIZE_THRESHOLD/);
	});

	test("sanitized context references plan file path and read-directly intent", async () => {
		const content = await readExtensionSource();

		// The replacement context must point to the plan file reference
		expect(content).toMatch(/Plan file:.*planRef/);
		// Must instruct verifier to read the file directly
		expect(content).toMatch(/Read the plan file directly/);
		// Must NOT include inline plan text
		expect(content).toMatch(/NOT included in this context/);
	});

	test("skips sanitization when no plan reference is available", async () => {
		const content = await readExtensionSource();

		// Must guard with planRef check before replacing context
		expect(content).toMatch(/const planRef\s*=.*planFilePath/);
		expect(content).toMatch(/if\s*\(planRef\)/);
	});

	test("planRef falls back to latest plan metadata when last.planFilePath is unset", async () => {
		const content = await readExtensionSource();

		// The planRef derivation must include a metadata fallback
		expect(content).toMatch(/findLatestPlanMetadata\(ctx\)/);
		expect(content).toMatch(/resolvePlanFilePath\(meta\.planFilePath/);
		// Fallback must be exception-safe (inside try/catch)
		const fallbackBlock = content.match(/const planRef[\s\S]*?\}\)\(\)/);
		expect(fallbackBlock).not.toBeNull();
		expect(fallbackBlock![0]).toMatch(/try\s*\{/);
		expect(fallbackBlock![0]).toMatch(/catch/);
	});

	test("sanitization is scoped only to verifier agent tasks", async () => {
		const content = await readExtensionSource();

		// The context sanitization code must be inside the verifier agent block
		// Verify the sanitization logic appears after the verifier agent check
		const verifierBlockMatch = content.match(/taskInput\.agent\s*===\s*"verifier"[\s\S]*?contextLooksLikeFullPlan/);
		expect(verifierBlockMatch).not.toBeNull();
	});

	test("existing verifier skill injection is preserved alongside sanitization", async () => {
		const content = await readExtensionSource();

		// Both features must coexist in the verifier block:
		// 1. Skill injection
		expect(content).toMatch(/VERIFIER_DEFAULT_SKILLS\s*=\s*\["qa-test-planner"\]/);
		expect(content).toMatch(/taskInput\.skills\s*=\s*\[\.\.\.existingSkills/);
		// 2. Context sanitization
		expect(content).toMatch(/VERIFIER_CONTEXT_FULL_PLAN_MARKER/);
		expect(content).toMatch(/taskInput\.context\s*=/);
	});
});

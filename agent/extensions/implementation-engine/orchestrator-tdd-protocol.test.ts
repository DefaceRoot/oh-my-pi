import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const agentsPath = path.join(repoRoot, "agent/AGENTS.md");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

describe("orchestrator TDD protocol docs", () => {
	test("documents mandatory user-facing summary format requirements", async () => {
		const content = await Bun.file(agentsPath).text();

		expect(content).toMatch(/Summary & Handoff Format — ALL Modes/);
		expect(content).toMatch(/What was wrong \/ what was requested/);
		expect(content).toMatch(/Before vs After/);
		expect(content).toMatch(/Numbered references \(MANDATORY for any response with 2\+ distinct items\)/);
	});
});

describe("implementation-engine prompt generation", () => {
	test("injects mandatory RED\/GREEN prerequisite-task instructions", async () => {
		const content = await Bun.file(implementationEnginePath).text();

		expect(content).toMatch(/TDD Protocol \(MANDATORY\)/);
		expect(content).toMatch(/For every implementation task, you MUST first spawn a prerequisite task/);
		expect(content).toMatch(/writ(?:e|es) failing tests that encode those criteria \(RED(?: phase)?\)/i);
		expect(content).toMatch(/Only AFTER the test task completes do you spawn the implementation task/);
		expect(content).toMatch(/implementation task MUST make those tests pass \(GREEN phase\)/i);
		expect(content).toMatch(/skip the prerequisite test-task only when existing tests already cover the success criteria/i);
		expect(content).toMatch(/test-driven-development/);
	});
});

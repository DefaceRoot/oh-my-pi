import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const agentsPath = path.join(repoRoot, "agent/AGENTS.md");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

describe("orchestrator TDD protocol docs", () => {
	test("documents mandatory test-first orchestration with planned and ad-hoc flows", async () => {
		const content = await Bun.file(agentsPath).text();

		expect(content).toMatch(/TDD Orchestration Protocol \(MANDATORY\)/);
		expect(content).toMatch(/Planned work[\s\S]*(before phase implementation begins|before spawning the implementation task)/i);
		expect(content).toMatch(/Ad hoc work[\s\S]*(test-first sequence|test-first task)/i);
		expect(content).toMatch(/already cover the success criteria/i);
		expect(content).toMatch(/test-driven-development/i);
	});
});

describe("plan-worktree prompt generation", () => {
	test("injects mandatory RED\/GREEN prerequisite-task instructions", async () => {
		const content = await Bun.file(planWorktreePath).text();

		expect(content).toMatch(/TDD Protocol \(MANDATORY\)/);
		expect(content).toMatch(/For every implementation task, you MUST first spawn a prerequisite task/);
		expect(content).toMatch(/writ(?:e|es) failing tests that encode those criteria \(RED(?: phase)?\)/i);
		expect(content).toMatch(/Only AFTER the test task completes do you spawn the implementation task/);
		expect(content).toMatch(/implementation task MUST make those tests pass \(GREEN phase\)/i);
		expect(content).toMatch(/skip the prerequisite test-task only when existing tests already cover the success criteria/i);
		expect(content).toMatch(/test-driven-development/);
	});
});

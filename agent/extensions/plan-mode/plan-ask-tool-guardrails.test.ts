import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planModePath = path.join(repoRoot, "agent/extensions/plan-mode/index.ts");
const standalonePlanAgentPath = path.join(repoRoot, "agent/agents/plan.md");
const packagedPlanAgentPath = path.join(repoRoot, "packages/coding-agent/src/prompts/agents/plan.md");
const planningProtocolPath = path.join(repoRoot, "agent/rules/planning-protocol.md");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

const assertNestedPlanArtifactContract = (source: string): void => {
	expect(source).toContain("`.omp/sessions/plans/<plan-slug>/plan.md`");
	expect(source).toContain("`.omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/`");
	expect(source).toMatch(/(Only the plan agent updates|Ownership: plan agent updates) `plan\.md`/);
	expect(source).toMatch(/plan-verifier agents write artifacts only/i);
	expect(source).not.toMatch(/`\.omp\/sessions\/plans\/plan\.md`/);
	expect(source).not.toMatch(/plan-verifier agents?.*update `plan\.md`/i);
};

const assertPlanAuthoringWriteEditContract = (source: string): void => {
	expect(source).toMatch(/^tools: .*\bwrite\b.*\bedit\b/m);
	expect(source).toContain("Use `write` only");
	expect(source).toContain("Use `edit`");
	if (source.includes("markdown files under `.omp/sessions/plans/`")) {
		expect(source).toContain("markdown files under `.omp/sessions/plans/`");
	} else {
		expect(source).toContain("markdown files under `.omp/sessions/plans/` and its nested directories");
	}
};


describe("plan ask-tool guardrails", () => {
test("plan-mode prompt requires ask-tool-only questioning, inherited workspace planning, and plans-root markdown writes", async () => {
	const source = await readFile(planModePath);

	expect(source).toContain("Every user-facing planning question MUST be asked with the ask tool.");
	expect(source).toContain("NEVER place the actual question in plain assistant text when waiting for user input.");
	expect(source).toContain("If a draft reply contains a question mark for something the user needs to answer, stop and convert that into an ask tool call instead.");
	expect(source).toContain("Reuse the workspace or worktree already visible from the current CWD.");
	expect(source).toContain("MINIMUM 5 ASK TOOL QUESTIONS");
	expect(source).toContain("markdown files under `.omp/sessions/plans/`");
});

	test("standalone plan agent prompt keeps nested plan layout and avoids manual branch/worktree asks", async () => {
		const source = await readFile(standalonePlanAgentPath);

		assertNestedPlanArtifactContract(source);
		assertPlanAuthoringWriteEditContract(source);
		expect(source).not.toMatch(/base[-\s]branch/i);
		expect(source).not.toMatch(/branch\s+name/i);
		expect(source).not.toMatch(/worktree\s+setup/i);
	});

	test("packaged plan agent prompt pins nested per-plan layout, verifier artifact separation, and delegated exploration", async () => {
		const source = await readFile(packagedPlanAgentPath);

		assertNestedPlanArtifactContract(source);
		assertPlanAuthoringWriteEditContract(source);
		expect(source).toContain("Spawn subagents aggressively for read-only work");
		expect(source).toContain("Re-delegate if important gaps remain");
	});


	test("planning protocol standardizes inherited workspace planning and the nested session plan layout", async () => {
		const source = await readFile(planningProtocolPath);

		expect(source).toContain("Planning uses the workspace already attached to the session.");
		expect(source).toContain("Do NOT ask the user for branch names, base branches, or worktree setup during planning unless they explicitly request that workflow.");
		expect(source).toContain(".omp/sessions/plans/<plan-slug>/plan.md");
		expect(source).toContain(".omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/");
		expect(source).toContain("Use the ask tool again for section-by-section validation instead of typing raw questions in assistant prose");
	});
});

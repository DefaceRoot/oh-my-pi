import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const planNewCommandPath = path.join(repoRoot, "agent/commands/plan-new.md");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

describe("plan-new command contract", () => {
	test("uses the nested session plan layout, inherited workspace flow, and parallel-first execution guidance", async () => {
		const source = await readFile(planNewCommandPath);

		expect(source).toContain(".omp/sessions/plans/<plan-slug>/plan.md");
		expect(source).toContain(".omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/");
		expect(source).toContain("continue planning in the current workspace or inherited worktree");
		expect(source).toContain("Default to parallel-first decomposition");
		expect(source).toContain("Parallel safety evidence covering no shared files");
		expect(source).toContain("their `Parallel safety` proof still matches current repo state");
		expect(source).not.toContain("/docs/plans/");
		expect(source).not.toMatch(/create a worktree and start phased implementation/i);
	});
});

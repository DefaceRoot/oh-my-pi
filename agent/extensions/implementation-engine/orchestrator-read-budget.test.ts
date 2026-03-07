import { beforeEach, describe, expect, test } from "bun:test";
import { OrchestratorReadBudget } from "./orchestrator-read-budget.ts";

describe("OrchestratorReadBudget", () => {
	let budget: OrchestratorReadBudget;

	beforeEach(() => {
		budget = new OrchestratorReadBudget();
	});

	describe("pre_delegation state", () => {
		test("allows up to 5 distinct file reads", () => {
			for (let i = 0; i < 5; i++) {
				expect(budget.tryRead(`/path/file${i}.ts`)).toEqual({ allowed: true });
			}
		});

		test("blocks 6th distinct file read", () => {
			for (let i = 0; i < 5; i++) budget.tryRead(`/path/file${i}.ts`);
			const result = budget.tryRead("/path/file5.ts");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("budget");
		});

		test("repeated reads of same file do not count against budget", () => {
			budget.tryRead("/path/file0.ts");
			budget.tryRead("/path/file0.ts");
			for (let i = 1; i < 5; i++) {
				expect(budget.tryRead(`/path/file${i}.ts`)).toEqual({ allowed: true });
			}
		});

		test("protocol URLs are always free (skill://, memory://, rule://, plan://)", () => {
			for (let i = 0; i < 5; i++) budget.tryRead(`/path/file${i}.ts`);
			expect(budget.tryRead("skill://brainstorming")).toEqual({ allowed: true });
			expect(budget.tryRead("memory://root/memory_summary.md")).toEqual({ allowed: true });
			expect(budget.tryRead("rule://implementation-engine")).toEqual({ allowed: true });
			expect(budget.tryRead("plan://something")).toEqual({ allowed: true });
		});

		test("budget applies identically with or without worktree path", () => {
			const withWorktree = new OrchestratorReadBudget();
			const withoutWorktree = new OrchestratorReadBudget();
			for (let i = 0; i < 5; i++) {
				expect(withWorktree.tryRead(`/f${i}`)).toEqual(withoutWorktree.tryRead(`/f${i}`));
			}
			expect(withWorktree.tryRead("/f5").allowed).toBe(false);
			expect(withoutWorktree.tryRead("/f5").allowed).toBe(false);
		});
	});

	describe("post_task_verification state", () => {
		test("allows reads of task-modified files without limit", () => {
			budget.transitionToPostTask(new Set(["/a.ts", "/b.ts", "/c.ts"]));
			expect(budget.tryRead("/a.ts")).toEqual({ allowed: true });
			expect(budget.tryRead("/b.ts")).toEqual({ allowed: true });
			expect(budget.tryRead("/c.ts")).toEqual({ allowed: true });
		});

		test("allows 2 additional context reads beyond modified files", () => {
			budget.transitionToPostTask(new Set(["/a.ts"]));
			expect(budget.tryRead("/extra1.ts")).toEqual({ allowed: true });
			expect(budget.tryRead("/extra2.ts")).toEqual({ allowed: true });
		});

		test("blocks 3rd non-modified context read", () => {
			budget.transitionToPostTask(new Set(["/a.ts"]));
			budget.tryRead("/extra1.ts");
			budget.tryRead("/extra2.ts");
			const result = budget.tryRead("/extra3.ts");
			expect(result.allowed).toBe(false);
		});

		test("protocol URLs still free in post_task state", () => {
			budget.transitionToPostTask(new Set());
			budget.tryRead("/extra1.ts");
			budget.tryRead("/extra2.ts");
			expect(budget.tryRead("skill://something")).toEqual({ allowed: true });
		});
	});

	describe("state transitions", () => {
		test("resetForNextDelegation returns to pre_delegation", () => {
			budget.transitionToPostTask(new Set(["/a.ts"]));
			budget.resetForNextDelegation();
			for (let i = 0; i < 5; i++) {
				expect(budget.tryRead(`/path/file${i}.ts`)).toEqual({ allowed: true });
			}
		});

		test("state is pre_delegation initially", () => {
			expect(budget.state).toBe("pre_delegation");
		});

		test("transitionToPostTask changes state", () => {
			budget.transitionToPostTask(new Set());
			expect(budget.state).toBe("post_task_verification");
		});
	});
});

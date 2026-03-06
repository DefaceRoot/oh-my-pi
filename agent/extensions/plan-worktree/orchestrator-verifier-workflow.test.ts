import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readPromptSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

describe("orchestrator verifier workflow prompts", () => {
	test("planned mode includes phase-end verifier trigger", async () => {
		const content = await readPromptSource();

		expect(content).toMatch(/PLANNED MODE \(phases from a plan\)/);
		expect(content).toMatch(/After each phase\\?'s task\(s\) complete, spawn:\s*task\(agent="verifier"/);
	});

	test("ad hoc mode includes batch-end verifier trigger", async () => {
		const content = await readPromptSource();

		expect(content).toMatch(/AD HOC MODE \(no plan, direct requests\)/);
		expect(content).toMatch(/After each spawned batch completes, spawn parallel verifiers/);
	});

	test("remediation loop has bounded retries", async () => {
		const content = await readPromptSource();

		expect(content).toMatch(/Max 2 remediation loops per phase/);
		expect(content).toMatch(/If still no_go -> STOP and report to user/);
	});

	test("verifier output contract is specified", async () => {
		const content = await readPromptSource();

		expect(content).toMatch(/go:\s*\{\s*verdict:\s*\\?"go\\?",\s*summary:\s*\\?"1-2 sentence confirmation\\?"\s*\}/);
		expect(content).toMatch(/no_go:\s*\{\s*verdict:\s*\\?"no_go\\?",\s*issues:\s*\[\\?"itemized failures\\?"\],\s*summary:\s*\\?"what failed and why\\?"\s*\}/);
	});

	test("verifier checks lint \+ tests \+ criteria", async () => {
		const content = await readPromptSource();

		expect(content).toMatch(/Check: \(1\) lint passed on modified files, \(2\) tests exist and pass, \(3\) success criteria met/);
	});
});

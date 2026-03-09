import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const standalonePlanAgentPath = path.join(repoRoot, "agent/agents/plan.md");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

describe("plan agent worktree inheritance", () => {
	test("standalone plan agent reuses the caller workspace instead of creating a new worktree", async () => {
		const source = await readFile(standalonePlanAgentPath);

		expect(source).not.toContain("worktree-setup");
		expect(source).not.toMatch(/ask the user[^\n]*branch name/i);
		expect(source).not.toMatch(/all plans require an isolated git worktree/i);
		expect(source).toMatch(/reuse the workspace or worktree you were started in/i);
		expect(source).toMatch(/never create a new worktree unless the user explicitly asks/i);
	});
});

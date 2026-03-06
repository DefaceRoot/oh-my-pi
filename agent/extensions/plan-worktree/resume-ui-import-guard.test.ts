import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

describe("resume-ui import safety", () => {
	test("does not dynamically import pi-tui inside ui.custom callback", async () => {
		const content = await Bun.file(planWorktreePath).text();

		expect(content).not.toMatch(/ctx\.ui\.custom<[^>]*>\(async[\s\S]*?await import\("@oh-my-pi\/pi-tui"\)/);
	});
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

function extractFreeformCommandBlock(source: string): string {
	const start = source.indexOf('pi.registerCommand("freeform-worktree", {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.registerCommand("planned-worktree", {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("plan-worktree phase 4 freeform command flow (RED)", () => {
	test("freeform handler runs category -> name -> base branch -> setupWorktreeFromTopic", async () => {
		const source = await readExtensionSource();
		const freeformBlock = extractFreeformCommandBlock(source);

		expect(freeformBlock).toMatch(/await promptForWorktreeCategory\(ctx\)/);
		expect(freeformBlock).toMatch(/await ctx\.ui\.input\(/);
		expect(freeformBlock).toMatch(/await ctx\.ui\.select\(/);
		expect(freeformBlock).toMatch(/await setupWorktreeFromTopic\(ctx,\s*\{/);
		expect(freeformBlock).toMatch(
			/await promptForWorktreeCategory\(ctx\)[\s\S]*await ctx\.ui\.input\([\s\S]*await ctx\.ui\.select\([\s\S]*await setupWorktreeFromTopic\(ctx,\s*\{/,
		);
	});

	test("success path creates a new session and pre-fills the freeform template placeholder", async () => {
		const source = await readExtensionSource();
		const freeformBlock = extractFreeformCommandBlock(source);

		expect(freeformBlock).toMatch(/await ctx\.newSession\(/);
		expect(freeformBlock).toMatch(/ctx\.ui\.setEditorText\([\s\S]*\[DESCRIBE YOUR REQUEST HERE\]/);
		expect(freeformBlock).toMatch(/if \(!setup\) \{[\s\S]*return;[\s\S]*\}[\s\S]*await ctx\.newSession\(/);
	});

	test("failure path runs cleanupFailedWorktree and shows a user-visible error", async () => {
		const source = await readExtensionSource();
		const freeformBlock = extractFreeformCommandBlock(source);

		expect(freeformBlock).toMatch(/catch \(err\)/);
		expect(freeformBlock).toMatch(/await cleanupFailedWorktree\(/);
		expect(freeformBlock).toMatch(/ctx\.ui\.notify\([\s\S]*"error"\)/);
	});

	test("cancelling at category, name, or base-branch step warns and exits without session creation", async () => {
		const source = await readExtensionSource();
		const freeformBlock = extractFreeformCommandBlock(source);
		const cancelledWarnings = freeformBlock.match(/ctx\.ui\.notify\("[^"]*cancelled[^"]*",\s*"warning"\)/g) ?? [];

		expect(cancelledWarnings.length).toBeGreaterThanOrEqual(3);
		expect(freeformBlock).not.toMatch(/ctx\.ui\.notify\("[^"]*cancelled[^"]*",\s*"warning"\)[\s\S]*await ctx\.newSession\(/);
	});
});

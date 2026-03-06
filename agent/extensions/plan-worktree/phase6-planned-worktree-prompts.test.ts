import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

function extractContinuePlannedBlock(source: string): string {
	const start = source.indexOf("const continuePlannedWorktreeFromLinkedPlan = async (");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("session_start", async (_event, ctx) => {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("plan-worktree phase 6 planned flow prompts + curator suggestion (RED)", () => {
	test("after plan link, planned flow prompts category (trimmed 8), then name prefilled from suggestion, then base branch", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/await\s+promptForWorktreeCategory\(ctx\)/);
		expect(plannedBlock).toMatch(/WORKTREE_CATEGORY_OPTIONS[\s\S]*slice\(0,\s*8\)/);
		expect(plannedBlock).toMatch(/await\s+ctx\.ui\.input\([\s\S]*suggested[\w-]*[\s\S]*\)/i);
		expect(plannedBlock).toMatch(/await\s+getBaseBranchOptions\(pi,\s*repoRoot\)/);
		expect(plannedBlock).toMatch(
			/promptForWorktreeCategory\(ctx\)[\s\S]*ctx\.ui\.input\([\s\S]*suggested[\w-]*[\s\S]*\)[\s\S]*getBaseBranchOptions\(pi,\s*repoRoot\)/i,
		);
	});

	test("curator suggestion invocation includes plan title + phase headings context and strict slug output instruction", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/agent\s*:\s*"curator"/);
		expect(plannedBlock).toMatch(/plan\s*title/i);
		expect(plannedBlock).toMatch(/phase\s*headings/i);
		expect(plannedBlock).toMatch(/(reply|respond)[\s\S]*(exactly\s+one|exactly)[\s\S]*kebab-case[\s\S]*(slug|branch)/i);
	});

	test("curator timeout or failure falls back to plan-path-derived slug", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/buildBranchNameCandidates\(\{[\s\S]*planFilePath[\s\S]*\}\)/);
		expect(plannedBlock).toMatch(/catch\s*\([^)]*\)[\s\S]*fallback/i);
		expect(plannedBlock).toMatch(/curator[\s\S]*(timeout|failed|error)/i);
	});

	test("empty curator output is sanitized and still falls back to path-derived slug", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/sanitizeBranchSegment\(\s*curator[\w-]*\s*\)/i);
		expect(plannedBlock).toMatch(/if\s*\(\s*!\s*curator[\w-]*\s*\)[\s\S]*fallback/i);
	});

	test("user override of suggested branch name is respected", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/const\s+suggested[\w-]*\s*=/i);
		expect(plannedBlock).toMatch(/const\s+requested[\w-]*\s*=\s*await\s+ctx\.ui\.input\([\s\S]*suggested[\w-]*[\s\S]*\)/i);
		expect(plannedBlock).toMatch(/sanitizeBranchSegment\(\s*requested[\w-]*\s*\)/i);
	});
});

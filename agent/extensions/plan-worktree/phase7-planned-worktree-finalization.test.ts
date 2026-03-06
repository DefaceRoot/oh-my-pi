import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

function extractContinuePlannedBlock(source: string): string {
	const start = source.indexOf("const continuePlannedWorktreeFromLinkedPlan = async (");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("const suggestBranchNameFromPlan = async (", start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractFreeformCommandBlock(source: string): string {
	const start = source.indexOf('pi.registerCommand("freeform-worktree", {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.registerCommand("planned-worktree", {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("plan-worktree phase 7 planned flow finalization (RED)", () => {
	test("selection-ready flow finalizes via setupWorktreeFromTopic using selected category/name/base + plan metadata", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/await\s+setupWorktreeFromTopic\(ctx,\s*\{/);
		expect(plannedBlock).toMatch(/planFilePath:\s*(?:linkedPlannedPlanPath|pendingPlannedWorktreeSelection\.planFilePath)/);
		expect(plannedBlock).toMatch(/categoryOverride:[\s\S]*pendingPlannedWorktreeSelection\.(?:categoryPrefix|categoryLabel)/);
		expect(plannedBlock).toMatch(/baseBranchOverride:\s*pendingPlannedWorktreeSelection\.baseBranch/);
		expect(plannedBlock).toMatch(/branchNameOverride:\s*pendingPlannedWorktreeSelection\.branchNamePart/);
	});

	test("successful planned finalization creates/switches session and persists worktree + plan metadata", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/await\s+ctx\.newSession\(/);
		expect(plannedBlock).toMatch(/sessionManager\.appendCustomEntry\(\s*PERSISTED_WORKTREE_STATE_TYPE/);
		expect(plannedBlock).toMatch(/sessionManager\.appendCustomEntry\(\s*PERSISTED_PLAN_METADATA_TYPE/);
		expect(plannedBlock).toMatch(/await\s+tryRestoreWorktreeState\(ctx\)/);
		expect(plannedBlock).toMatch(/persistWorktreeState\(\)/);
	});

	test("planned kickoff prefill is short (<=5 lines) and includes @plan + granularity + designer + TODO-first + TDD + verifier", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);
		const prefillLinesMatch = plannedBlock.match(
			/ctx\.ui\.setEditorText\(\s*\[(?<body>[\s\S]*?)\]\.join\("\\n"\)\s*\)/,
		);

		expect(prefillLinesMatch?.groups?.body).toBeDefined();
		const lines = prefillLinesMatch?.groups?.body
			? prefillLinesMatch.groups.body
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
			: [];
		expect(lines.length).toBeLessThanOrEqual(5);

		const normalized = (prefillLinesMatch?.groups?.body ?? "").toLowerCase();
		expect(normalized).toMatch(/@[^\n]*plan/);
		expect(normalized).toMatch(/subagent|one task per phase|granular/);
		expect(normalized).toMatch(/designer/);
		expect(normalized).toMatch(/todo/);
		expect(normalized).toMatch(/tdd/);
		expect(normalized).toMatch(/verifier/);
	});

	test("planned finalization selects orchestrator model for the new session", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/await\s+ensureOrchestratorRuntimeDefaults\(ctx\)/);
	});

	test("planned finalization setup failure triggers cleanup and clear error notification", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/catch\s*\(err\)/);
		expect(plannedBlock).toMatch(/await\s+cleanupFailedWorktree\(/);
		expect(plannedBlock).toMatch(/ctx\.ui\.notify\([^\n]*planned[^\n]*error[^\n]*"error"\)/i);
	});

	test("freeform template path remains unchanged (no planned @plan kickoff template regression)", async () => {
		const source = await readExtensionSource();
		const freeformBlock = extractFreeformCommandBlock(source);

		expect(freeformBlock).toMatch(/\[DESCRIBE YOUR REQUEST HERE\]/);
		expect(freeformBlock).not.toMatch(/@docs\/plans\/<plan-title>\/YYYY-MM-DD-<feature-slug>\.md/);
	});

	test("planned finalization fails clearly when plan metadata is unavailable", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractContinuePlannedBlock(source);

		expect(plannedBlock).toMatch(/if\s*\(\s*!planMetadata\s*\)\s*\{[\s\S]*ctx\.ui\.notify\([\s\S]*planned[\s\S]*metadata[\s\S]*"error"\)/i);
	});
});

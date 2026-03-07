import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

function extractPlannedCommandBlock(source: string): string {
	const start = source.indexOf('pi.registerCommand("planned-worktree", {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.registerCommand("cleanup-worktrees", {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractInputHookBlock(source: string): string {
	const start = source.indexOf('pi.on("input", async (event, ctx) => {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("pi.registerCommand(IMPLEMENT_COMMAND, {", start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractPlanPathValidationHelper(source: string): string {
	const start = source.indexOf("function isDocsPlanMarkdownPath(filePath: string): boolean {");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("function getPlanWorkspaceDir(planFilePath: string): string {", start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractManualPlanPathParserHelper(source: string): string {
	const start = source.indexOf("function parseReviewCompleteManualPlanPath(args: string): string | undefined {");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("function findLatestAssistantReviewFindings(", start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}
describe("implementation-engine phase 5 planned flow plan linking (RED)", () => {
	test("planned-worktree command primes @ mention linking and pending state", async () => {
		const source = await readExtensionSource();
		const plannedBlock = extractPlannedCommandBlock(source);

		expect(plannedBlock).toMatch(/pendingPlannedWorktree\s*=\s*true/);
		expect(plannedBlock).toMatch(/ctx\.ui\.setEditorText\(\s*"@"\s*\)/);
		expect(plannedBlock).not.toMatch(/Not yet implemented/);
	});

	test("input hook handles pending planned flow by parsing @ mention and validating supported markdown plan paths", async () => {
		const source = await readExtensionSource();
		const inputBlock = extractInputHookBlock(source);

		expect(inputBlock).toMatch(/if\s*\(\s*pendingPlannedWorktree\s*\)/);
		expect(inputBlock).toMatch(/parseReviewCompleteManualPlanPath\(/);
		expect(inputBlock).toMatch(/isDocsPlanMarkdownPath\(/);
		expect(inputBlock).toMatch(/Bun\.file\([\s\S]*?\)\.exists\(\)/);
	});

	test("invalid or missing plan path shows clear error and always clears pending state", async () => {
		const source = await readExtensionSource();
		const inputBlock = extractInputHookBlock(source);

		expect(inputBlock).toMatch(/plannedWorktreePlanPathPromptText\(\)/);
		expect(source).toMatch(
			/function\s+plannedWorktreePlanPathPromptText\(\):\s*string\s*\{[\s\S]*docs\/plans[\s\S]*\.omp\/sessions\/plans[\s\S]*\.md/i,
		);
		const resetMatches = inputBlock.match(/pendingPlannedWorktree\s*=\s*false/g) ?? [];
		expect(resetMatches.length).toBeGreaterThanOrEqual(2);
	});

	test("input hook leaves normal chat behavior untouched when no pending planned flow", async () => {
		const source = await readExtensionSource();
		const inputBlock = extractInputHookBlock(source);

		expect(inputBlock).toMatch(/if \(text === "\/resume" \|\| text\?\.startsWith\("\/resume "\)\) \{[\s\S]*return \{ text: "\/resume-ui" \ };/);
		expect(inputBlock).toMatch(/if\s*\(\s*!pendingPlannedWorktree\s*\)\s*\{[\s\S]*return;[\s\S]*\}/);
	});

	test("plan path validator accepts canonical .omp/sessions/plans markdown paths in planned-worktree flow", async () => {
		const source = await readExtensionSource();
		const validatorBlock = extractPlanPathValidationHelper(source);

		expect(validatorBlock).toMatch(/\.omp[\s\S]*sessions[\s\S]*plans/i);
		expect(validatorBlock).toMatch(/endsWith\("\.md"\)/);
	});

	test("plan path validator keeps existing docs/plans markdown acceptance", async () => {
		const source = await readExtensionSource();
		const validatorBlock = extractPlanPathValidationHelper(source);

		expect(validatorBlock).toMatch(/docs\$\{path\.sep\}plans\$\{path\.sep\}/);
	});

	test("pending planned-worktree flow resolves path before validation and rejects invalid paths", async () => {
		const source = await readExtensionSource();
		const inputBlock = extractInputHookBlock(source);

		expect(inputBlock).toMatch(/resolvePlanFilePath\([\s\S]*ctx\.sessionManager\.getCwd\(\)\)/);
		expect(inputBlock).toMatch(/resolvePlanFilePath\([\s\S]*\)[\s\S]*if\s*\(\s*!isDocsPlanMarkdownPath\(resolvedPlanPath\)\s*\)/);
		expect(inputBlock).toMatch(/if\s*\(\s*!isDocsPlanMarkdownPath\(resolvedPlanPath\)\s*\)[\s\S]*ctx\.ui\.notify\([\s\S]*"error"\)/);
	});

	test("plan path mention parsing still supports additional text around @path", async () => {
		const source = await readExtensionSource();
		const parserBlock = extractManualPlanPathParserHelper(source);

		expect(parserBlock).toMatch(/const mentionMatch = trimmed\.match\(\/@\(\?:/);
		expect(parserBlock).toMatch(/const fallbackTokenMatch = trimmed\.match\(\/\^\(\?:/);
		expect(parserBlock).toMatch(/const raw = mentionMatch[\s\S]*fallbackTokenMatch/);
	});
	test("@ mention extraction keeps existing first-mention parsing behavior", async () => {
		const source = await readExtensionSource();

		expect(source).toMatch(/const mentionMatch = trimmed\.match\(\/@\(\?:/);
		expect(source).toMatch(/const raw = mentionMatch[\s\S]*fallbackTokenMatch/);
	});
});

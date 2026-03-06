import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");
const cleanupPath = path.join(repoRoot, "agent/extensions/plan-worktree/cleanup.ts");
const interactiveModePath = path.join(
	repoRoot,
	"agent/patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/modes/interactive-mode.ts",
);

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();
const readCleanupSource = async (): Promise<string> => Bun.file(cleanupPath).text();
const readInteractiveSource = async (): Promise<string> => Bun.file(interactiveModePath).text();

function extractBlock(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf(endMarker, start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractFreeformKickoffLines(source: string): string[] {
	const freeformBlock = extractBlock(
		source,
		'pi.registerCommand("freeform-worktree", {',
		'pi.registerCommand("planned-worktree", {',
	);
	const prefillMatch = freeformBlock.match(/ctx\.ui\.setEditorText\(\s*\[(?<body>[\s\S]*?)\]\.join\("\\n"\)\s*,?\s*\)/);
	expect(prefillMatch?.groups?.body).toBeDefined();
	return (prefillMatch?.groups?.body ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

function extractActionButtonsBlock(source: string): string {
	return extractBlock(
		source,
		"const ACTION_BUTTONS: ActionButtonUi[] = [",
		"];",
	);
}

describe("plan-worktree phase 8 cleanup + dead-menu hardening (RED)", () => {
	test("cleanup-worktrees footer command is implemented with real cleanup flow (not placeholder)", async () => {
		const source = await readExtensionSource();
		const cleanupBlock = extractBlock(
			source,
			'pi.registerCommand("cleanup-worktrees", {',
			'pi.registerCommand("git-menu", {',
		);

		expect(cleanupBlock).not.toMatch(/Not yet implemented/);
		expect(cleanupBlock).toMatch(/(getWorktreeList|selectWorktrees|\/cleanup|cleanupFlow|runCleanup)/);
	});

	test("cleanup selection flow uses tmux multi-select when available and falls back to ui.select", async () => {
		const cleanupSource = await readCleanupSource();
		const selectionBlock = extractBlock(
			cleanupSource,
			"async function selectWorktrees(",
			"interface MergeAssessment",
		);

		expect(selectionBlock).toMatch(/showMultiSelectPopupMenu|_showMultiSelectPopupMenu/);
		expect(selectionBlock).toMatch(/if\s*\([^)]*===\s*null\)\s*\{[\s\S]*ctx\.ui\.select\(/);
	});

	test("cleanup flow safely shifts cwd before removing currently active worktree and reports summary", async () => {
		const cleanupSource = await readCleanupSource();

		expect(cleanupSource).toMatch(/const\s+removingCurrentSessionWorktree\s*=\s*isSameOrInside\(cwd,\s*wt\.path\)/);
		expect(cleanupSource).toMatch(/if\s*\(removingCurrentSessionWorktree\)\s*\{[\s\S]*process\.chdir\(repoRoot\)/);
		expect(cleanupSource).toMatch(/parts\.push\(`Removed worktrees \$\{removed\.length\}:/);
		expect(cleanupSource).toMatch(/ctx\.ui\.notify\(parts\.join\(" \| "\)\s*\|\|\s*"Cleanup complete",\s*"info"\)/);
	});

	test("freeform kickoff template stays concise (<=10 lines) and keeps core orchestration instructions", async () => {
		const source = await readExtensionSource();
		const lines = extractFreeformKickoffLines(source);
		const normalized = lines.join("\n").toLowerCase();

		expect(lines.length).toBeLessThanOrEqual(10);
		expect(normalized).toContain("[describe your request here]");
		expect(normalized).toMatch(/numbered phase list \(2-6 phases\)/);
		expect(normalized).toMatch(/task subagents/);
	});

	test("legacy worktree-menu command path and strings are fully removed", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const actionButtonsBlock = extractActionButtonsBlock(interactiveSource);

		expect(extensionSource).not.toMatch(/registerCommand\("worktree-menu",\s*\{/);
		expect(extensionSource).not.toMatch(/Worktree Actions|Plan first|Use existing plan|Cleanup old worktrees/);
		expect(actionButtonsBlock).not.toContain('/worktree-menu');
	});

	test("typed /cleanup command remains registered and wired", async () => {
		const extensionSource = await readExtensionSource();
		const cleanupSource = await readCleanupSource();

		expect(cleanupSource).toMatch(/registerCommand\("cleanup",\s*\{/);
		expect(extensionSource).toMatch(/import\s*\{\s*registerCleanupCommand\s*\}\s*from\s*"\.\/cleanup\.ts"/);
		expect(extensionSource).toMatch(/registerCleanupCommand\(pi,\s*\{/);
	});
});

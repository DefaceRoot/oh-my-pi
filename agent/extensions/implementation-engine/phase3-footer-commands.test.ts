import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");
const interactiveModePath = path.join(
	repoRoot,
"agent/patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/modes/interactive-mode.ts",
);

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();
const readInteractiveSource = async (): Promise<string> => Bun.file(interactiveModePath).text();

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

interface ActionButtonSnapshot {
	label: string;
	command: string;
	statusKey: string;
	normalText: string;
	hoverText: string;
}

interface HoverFixture {
	planKey: string;
	implementKey: string;
	cleanupKey: string;
	freeformText: string;
	plannedText: string;
	cleanupText: string;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function extractConstString(source: string, name: string): string {
	const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\"([^\"]+)\"`));
	expect(match).toBeTruthy();
	return match?.[1] ?? "";
}

function resolveStatusKeyValue(source: string, token: string): string {
	const match = source.match(new RegExp(`const\\s+${token}\\s*=\\s*\"([^\"]+)\"`));
	return match?.[1] ?? token;
}

function extractActionButtons(source: string): ActionButtonSnapshot[] {
	const start = source.indexOf("const ACTION_BUTTONS: ActionButtonUi[] = [");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("];", start);
	expect(end).toBeGreaterThan(start);
	const block = source.slice(start, end);

	const buttonRegex = /\{\s*label:\s*"([^"]+)",[\s\S]*?command:\s*"([^"]+)",[\s\S]*?statusKey:\s*([A-Z_]+),[\s\S]*?normalText:\s*"([^"]+)",[\s\S]*?hoverText:\s*"([^"]+)",[\s\S]*?\}/g;
	const parsed: ActionButtonSnapshot[] = [];

	for (const match of block.matchAll(buttonRegex)) {
		parsed.push({
			label: match[1] ?? "",
			command: match[2] ?? "",
			statusKey: resolveStatusKeyValue(source, match[3] ?? ""),
			normalText: match[4] ?? "",
			hoverText: match[5] ?? "",
		});
	}

	expect(parsed.length).toBeGreaterThan(0);
	return parsed;
}

function extractHoverFixture(source: string): HoverFixture {
	return {
		planKey: extractConstString(source, "PLAN_WORKFLOW_STATUS_KEY"),
		implementKey: extractConstString(source, "IMPLEMENT_WORKFLOW_STATUS_KEY"),
		cleanupKey: extractConstString(source, "CLEANUP_WORKFLOW_STATUS_KEY"),
		freeformText: extractConstString(source, "FREEFORM_WORKTREE_ACTION_TEXT"),
		plannedText: extractConstString(source, "PLANNED_WORKTREE_ACTION_TEXT"),
		cleanupText: extractConstString(source, "CLEANUP_WORKTREES_ACTION_TEXT"),
	};
}

function resolveHoveredButton(
	buttons: ActionButtonSnapshot[],
	lineText: string,
	x: number,
): ActionButtonSnapshot | undefined {
	const line = stripAnsi(lineText);
	for (const button of buttons) {
		const labelIndex = line.indexOf(button.label);
		if (labelIndex === -1) continue;

		const startCol = line.slice(0, labelIndex).length + 1;
		const endCol = startCol + button.label.length - 1;
		if (x >= startCol && x <= endCol) {
			return button;
		}
	}
	return undefined;
}

function applyHoverTransition(
	statuses: Map<string, string>,
	buttons: ActionButtonSnapshot[],
	previousLabel: string | undefined,
	nextButton: ActionButtonSnapshot | undefined,
): string | undefined {
	if (previousLabel) {
		const previous = buttons.find(candidate => candidate.label === previousLabel);
		if (previous) statuses.set(previous.statusKey, previous.normalText);
	}

	if (nextButton) {
		statuses.set(nextButton.statusKey, nextButton.hoverText);
	}

	return nextButton?.label;
}

function centerColumnForLabel(lineText: string, label: string): number {
	const line = stripAnsi(lineText);
	const index = line.indexOf(label);
	expect(index).toBeGreaterThanOrEqual(0);
	return index + Math.ceil(label.length / 2) + 1;
}

describe("implementation-engine phase 3 footer actions and command wiring (RED)", () => {
	test("setActionButton clears legacy flat workflow statuses so Worktree menu is the only entry point", async () => {
		const source = await readExtensionSource();

		expect(source).toMatch(/for \(const key of \[[\s\S]*PLAN_WORKFLOW_STATUS_KEY[\s\S]*IMPLEMENT_WORKFLOW_STATUS_KEY[\s\S]*REVIEW_COMPLETE_STATUS_KEY[\s\S]*CLEANUP_WORKFLOW_STATUS_KEY[\s\S]*PLAN_REVIEW_STATUS_KEY[\s\S]*FIX_PLAN_STATUS_KEY[\s\S]*\]\) \{\s*ctx\.ui\.setStatus\(key,\s*undefined\);\s*\}/);

		expect(source).not.toMatch(/const\s+SYNC_NEEDED_STATUS_KEY\s*=/);
		expect(source).not.toMatch(/const\s+SPACER_STATUS_KEY\s*=/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*SYNC_NEEDED_STATUS_KEY,/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*SPACER_STATUS_KEY,/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*[^,]+,\s*DELETE_WORKTREE_ACTION_TEXT\s*\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*[^,]+,\s*["'`][^"'`]*✕ Worktree[^"'`]*["'`]\s*\)/);
	});

	test("freeform/planned/cleanup footer outputs are assigned to three distinct status keys", async () => {
		const source = await readExtensionSource();
		const fixture = extractHoverFixture(source);

		const distinct = new Set([fixture.planKey, fixture.implementKey, fixture.cleanupKey]);
		expect(distinct.size).toBe(3);
	});

	test("interactive mapping wires Freeform/Planned/Cleanup to the new commands and status slots", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);

		const freeform = buttons.find(button => button.label === "Freeform");
		expect(freeform).toBeDefined();
		expect(freeform?.command).toBe("/freeform-worktree");
		expect(freeform?.statusKey).toBe(fixture.planKey);

		const planned = buttons.find(button => button.label === "Planned");
		expect(planned).toBeDefined();
		expect(planned?.command).toBe("/planned-worktree");
		expect(planned?.statusKey).toBe(fixture.implementKey);

		const cleanup = buttons.find(button => button.label === "Cleanup");
		expect(cleanup).toBeDefined();
		expect(cleanup?.command).toBe("/cleanup-worktrees");
		expect(cleanup?.statusKey).toBe(fixture.cleanupKey);
	});

	test("hovering the Planned footer action should resolve Planned, not another button label", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);
		const lineText = `${fixture.freeformText} ${fixture.plannedText} ${fixture.cleanupText}`;

		const hovered = resolveHoveredButton(
			buttons,
			lineText,
			centerColumnForLabel(lineText, "Planned"),
		);

		expect(hovered?.label).toBe("Planned");
	});

	test("hover transition Planned -> Cleanup preserves each button's own status text slot", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);
		const lineText = `${fixture.freeformText} ${fixture.plannedText} ${fixture.cleanupText}`;

		const statuses = new Map<string, string>([
			[fixture.planKey, fixture.freeformText],
			[fixture.implementKey, fixture.plannedText],
			[fixture.cleanupKey, fixture.cleanupText],
		]);

		let previousLabel: string | undefined;
		const plannedHover = resolveHoveredButton(
			buttons,
			lineText,
			centerColumnForLabel(lineText, "Planned"),
		);
		expect(plannedHover?.label).toBe("Planned");
		expect(plannedHover).toBeDefined();
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, plannedHover);

		const cleanupHover = resolveHoveredButton(
			buttons,
			lineText,
			centerColumnForLabel(lineText, "Cleanup"),
		);
		expect(cleanupHover?.label).toBe("Cleanup");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, cleanupHover);

		expect(statuses.get(fixture.planKey)).toBe(fixture.freeformText);
		expect(statuses.get(fixture.implementKey)).toContain("Planned");
		expect(statuses.get(fixture.cleanupKey)).toContain("Cleanup");
	});

	test("legacy worktree-menu command registration is removed", async () => {
		const source = await readExtensionSource();

		expect(source).not.toMatch(/registerCommand\("worktree-menu",\s*\{/);
	});

	test("new worktree commands are registered", async () => {
		const source = await readExtensionSource();

		expect(source).toMatch(/registerCommand\("freeform-worktree",\s*\{/);
		expect(source).toMatch(/registerCommand\("planned-worktree",\s*\{/);
		expect(source).toMatch(/registerCommand\("cleanup-worktrees",\s*\{/);
		expect(source).toMatch(/pi\.registerCommand\(DELETE_WORKTREE_COMMAND,\s*\{/);
	});

	test("active-worktree footer no longer emits flat sync/delete/progress entries", async () => {
		const source = await readExtensionSource();

		expect(source).not.toMatch(
			/const hasActiveWorktree =\s*setupDone && Boolean\(last\.worktreePath\) && Boolean\(last\.branchName\);/,
		);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*SYNC_NEEDED_STATUS_KEY,/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*SPACER_STATUS_KEY,/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*[^,]+,\s*DELETE_WORKTREE_ACTION_TEXT\s*\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(\s*[^,]+,\s*["'`][^"'`]*✕ Worktree[^"'`]*["'`]\s*\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\("worktree",\s*["'`][^"'`]*["'`]\s*\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\("worktree",\s*undefined\s*\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(REMOTE_SYNC_STATUS_KEY,\s*[^)]+\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(DELETE_WORKTREE_PROGRESS_STATUS_KEY,\s*[^)]+\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(IMPLEMENT_PROGRESS_STATUS_KEY,\s*[^)]+\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(REVIEW_COMPLETE_PROGRESS_STATUS_KEY,\s*[^)]+\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(FIX_ISSUES_PROGRESS_STATUS_KEY,\s*[^)]+\)/);
		expect(source).not.toMatch(/ctx\.ui\.setStatus\(UPDATE_VERSION_PROGRESS_STATUS_KEY,\s*[^)]+\)/);
		expect(source).toMatch(/const notifyWorktreeProgress = \(/);
		expect(source).toMatch(/notifyWorktreeProgress\(ctx,\s*"worktree: creating\.\.\."\)/);
		expect(source).toMatch(/notifyWorktreeProgress\(ctx,\s*`remote-sync: \$\{reason\}\.\.\.`\)/);
		expect(source).toMatch(/notifyWorktreeProgress\(ctx,\s*"delete-worktree: removing\.\.\."\)/);
	});
});

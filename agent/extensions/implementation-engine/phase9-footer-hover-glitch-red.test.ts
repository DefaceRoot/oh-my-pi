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
	reviewKey: string;
	freeformText: string;
	plannedText: string;
	cleanupText: string;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function decodeAnsiEscapes(text: string): string {
	return text.replace(/\\x1b/g, "\x1b");
}

function extractConstString(source: string, name: string): string {
	const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\"([^\"]+)\"`));
	expect(match).toBeTruthy();
	return decodeAnsiEscapes(match?.[1] ?? "");
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

	const buttonRegex =
		/\{\s*label:\s*"([^"]+)",[\s\S]*?command:\s*"([^"]+)",[\s\S]*?statusKey:\s*([A-Z_]+),[\s\S]*?normalText:\s*"([^"]+)",[\s\S]*?hoverText:\s*"([^"]+)",[\s\S]*?\}/g;
	const parsed: ActionButtonSnapshot[] = [];

	for (const match of block.matchAll(buttonRegex)) {
		parsed.push({
			label: match[1] ?? "",
			command: match[2] ?? "",
			statusKey: resolveStatusKeyValue(source, match[3] ?? ""),
			normalText: decodeAnsiEscapes(match[4] ?? ""),
			hoverText: decodeAnsiEscapes(match[5] ?? ""),
		});
	}

	expect(parsed.length).toBeGreaterThan(0);
	return parsed;
}

function extractHoverFixture(source: string): HoverFixture {
	return {
		planKey: extractConstString(source, "PLAN_WORKFLOW_STATUS_KEY"),
		implementKey: extractConstString(source, "IMPLEMENT_WORKFLOW_STATUS_KEY"),
		reviewKey: extractConstString(source, "REVIEW_COMPLETE_STATUS_KEY"),
		freeformText: extractConstString(source, "FREEFORM_WORKTREE_ACTION_TEXT"),
		plannedText: extractConstString(source, "PLANNED_WORKTREE_ACTION_TEXT"),
		cleanupText: extractConstString(source, "CLEANUP_WORKTREES_ACTION_TEXT"),
	};
}

function findActionButtonBounds(
	line: string,
	button: ActionButtonSnapshot,
	mouseCol: number,
): { startCol: number; endCol: number; matchLength: number } | undefined {
	const renderedCandidates = new Set<string>();
	for (const renderedText of [button.hoverText, button.normalText]) {
		const rendered = stripAnsi(renderedText);
		if (!rendered.includes(button.label)) continue;
		renderedCandidates.add(rendered);
		const withoutTrailingSpace = rendered.trimEnd();
		if (withoutTrailingSpace !== rendered && withoutTrailingSpace.includes(button.label)) {
			renderedCandidates.add(withoutTrailingSpace);
		}
	}

	let bestMatch: { startCol: number; endCol: number; matchLength: number } | undefined;
	for (const rendered of renderedCandidates) {
		const labelOffset = rendered.indexOf(button.label);
		if (labelOffset === -1) continue;

		let searchFrom = 0;
		while (searchFrom < line.length) {
			const renderedIndex = line.indexOf(rendered, searchFrom);
			if (renderedIndex === -1) break;
			searchFrom = renderedIndex + 1;

			const labelIndex = renderedIndex + labelOffset;
			const startCol = line.slice(0, labelIndex).length + 1;
			const endCol = startCol + button.label.length - 1;
			if (mouseCol < startCol || mouseCol > endCol) continue;

			const matchLength = rendered.length;
			if (!bestMatch || matchLength > bestMatch.matchLength) {
				bestMatch = { startCol, endCol, matchLength };
			}
		}
	}

	return bestMatch;
}

function getActionButtonUnderMouse(
	buttons: ActionButtonSnapshot[],
	lineText: string,
	x: number,
): ActionButtonSnapshot | undefined {
	const line = stripAnsi(lineText);

	let bestHit: { button: ActionButtonSnapshot; matchLength: number } | undefined;
	for (const button of buttons) {
		const bounds = findActionButtonBounds(line, button, x);
		if (!bounds) continue;
		if (!bestHit || bounds.matchLength > bestHit.matchLength) {
			bestHit = { button, matchLength: bounds.matchLength };
		}
	}

	return bestHit?.button;
}

function hasSameVisibleText(left: string, right: string): boolean {
	return stripAnsi(left).trim() === stripAnsi(right).trim();
}
function shouldUpdateActionButtonStatus(statuses: Map<string, string>, button: ActionButtonSnapshot): boolean {
	const currentText = statuses.get(button.statusKey);
	if (!currentText) return false;
	return (
		currentText === button.normalText ||
		currentText === button.hoverText ||
		hasSameVisibleText(currentText, button.normalText) ||
		hasSameVisibleText(currentText, button.hoverText)
	);
}

function applyHoverTransition(
	statuses: Map<string, string>,
	buttons: ActionButtonSnapshot[],
	previousLabel: string | undefined,
	nextButton: ActionButtonSnapshot | undefined,
): string | undefined {
	if (previousLabel) {
		const previous = buttons.find(candidate => candidate.label === previousLabel);
		const previousText = previous ? statuses.get(previous.statusKey) : undefined;
		if (previous && previousText && hasSameVisibleText(previousText, previous.hoverText)) {
			statuses.set(previous.statusKey, previous.normalText);
		}
	}

	if (nextButton && shouldUpdateActionButtonStatus(statuses, nextButton)) {
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

function renderNoWorktreeFooterLine(statuses: Map<string, string>, fixture: HoverFixture): string {
	const values = [
		statuses.get(fixture.planKey),
		statuses.get(fixture.implementKey),
		statuses.get(fixture.reviewKey),
	].filter((value): value is string => Boolean(value));
	return values.join(" ");
}

describe("implementation-engine phase 9 footer hover/click glitch reproduction (RED)", () => {
	test("ANSI-rendered Freeform/Planned/Cleanup line resolves each segment hit target", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);
		const lineText = `${fixture.freeformText} ${fixture.plannedText} ${fixture.cleanupText}`;

		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Freeform"))?.label,
		).toBe("Freeform");
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Planned"))?.label,
		).toBe("Planned");
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Cleanup"))?.label,
		).toBe("Cleanup");
	});

	test("hovering Freeform -> Planned -> Cleanup -> off keeps labels stable and visible buttons clickable", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);

		const statuses = new Map<string, string>([
			[fixture.planKey, fixture.freeformText],
			[fixture.implementKey, fixture.plannedText],
			[fixture.reviewKey, fixture.cleanupText],
		]);

		let previousLabel: string | undefined;
		let lineText = renderNoWorktreeFooterLine(statuses, fixture);

		const freeformHover = getActionButtonUnderMouse(
			buttons,
			lineText,
			centerColumnForLabel(lineText, "Freeform"),
		);
		expect(freeformHover?.label).toBe("Freeform");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, freeformHover);

		lineText = renderNoWorktreeFooterLine(statuses, fixture);
		const plannedHover = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Planned"));
		expect(plannedHover?.label).toBe("Planned");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, plannedHover);

		lineText = renderNoWorktreeFooterLine(statuses, fixture);
		const cleanupHover = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Cleanup"));
		expect(cleanupHover?.label).toBe("Cleanup");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, cleanupHover);

		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, undefined);
		expect(previousLabel).toBeUndefined();
		expect(statuses.get(fixture.planKey)).toBe(fixture.freeformText);
		expect(statuses.get(fixture.implementKey)).toBe(fixture.plannedText);
		expect(statuses.get(fixture.reviewKey)).toBe(fixture.cleanupText);

		lineText = renderNoWorktreeFooterLine(statuses, fixture);
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Freeform"))?.label,
		).toBe("Freeform");
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Planned"))?.label,
		).toBe("Planned");
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Cleanup"))?.label,
		).toBe("Cleanup");
	});

	test("Planned should still be hit-testable when visible text loses trailing ANSI reset during rapid status churn", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);

		const plannedWithoutReset = fixture.plannedText.replace(/\x1b\[0m$/, "");
		const lineText = `${fixture.freeformText} ${plannedWithoutReset} ${fixture.cleanupText}`;
		expect(stripAnsi(lineText)).toContain("Planned");

		const plannedHit = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Planned"));
		expect(plannedHit?.label).toBe("Planned");
		expect(plannedHit?.label).not.toBe("Plan");
	});

	test("Cleanup remains clickable while visible even if shared review slot text is updated without full ANSI envelope", async () => {
		const extensionSource = await readExtensionSource();
		const interactiveSource = await readInteractiveSource();
		const fixture = extractHoverFixture(extensionSource);
		const buttons = extractActionButtons(interactiveSource);

		const lineText = `${fixture.freeformText} ${fixture.plannedText} Cleanup`;
		expect(stripAnsi(lineText)).toContain("Cleanup");

		const cleanupHit = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Cleanup"));
		expect(cleanupHit?.label).toBe("Cleanup");
	});

	test("startup no longer auto-applies archived workflow patch bundles", async () => {
		const source = await readExtensionSource();

		expect(source).not.toContain("ensureWorkflowPatchHealth");
		expect(source).not.toContain("WORKFLOW_PATCH_SCRIPT_PATH");
		expect(source).not.toContain("OMP_IMPLEMENT_PATCH_GUARD");
		expect(source).not.toContain("manage.sh apply");
	});
});

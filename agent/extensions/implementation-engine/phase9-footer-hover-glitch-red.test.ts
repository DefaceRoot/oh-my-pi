import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
type ActionButtonUi,
ACTION_BUTTONS,
findActionButtonBounds,
hasSameVisibleText,
stripAnsi,
} from "../../../packages/coding-agent/src/modes/action-buttons.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

function getActionButtonUnderMouse(
	buttons: ActionButtonUi[],
	lineText: string,
	x: number,
): ActionButtonUi | undefined {
	const line = stripAnsi(lineText);

	let bestHit: { button: ActionButtonUi; matchLength: number } | undefined;
	for (const button of buttons) {
		const bounds = findActionButtonBounds(line, button, x);
		if (!bounds) continue;
		if (!bestHit || bounds.matchLength > bestHit.matchLength) {
			bestHit = { button, matchLength: bounds.matchLength };
		}
	}

	return bestHit?.button;
}

function shouldUpdateActionButtonStatus(statuses: Map<string, string>, button: ActionButtonUi): boolean {
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
	buttons: ActionButtonUi[],
	previousLabel: string | undefined,
	nextButton: ActionButtonUi | undefined,
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

describe("implementation-engine phase 9 footer hover/click glitch reproduction (RED)", () => {
	test("ANSI-rendered footer line resolves each segment hit target", async () => {
		const buttons = ACTION_BUTTONS;
		const lineText = buttons.map(button => button.normalText).join(" ");

		for (const button of buttons) {
			expect(
				getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, button.label))?.label,
			).toBe(button.label);
		}
	});

	test("hovering Git -> Merge OMP -> off keeps labels stable and visible buttons clickable", async () => {
		const buttons = ACTION_BUTTONS;
		const lineText = buttons.map(button => button.normalText).join(" ");

		const statuses = new Map<string, string>(
			buttons.map(button => [button.statusKey, button.normalText]),
		);

		let previousLabel: string | undefined;
		const gitHover = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Git"));
		expect(gitHover?.label).toBe("Git");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, gitHover);

		const mergeHover = getActionButtonUnderMouse(
			buttons,
			lineText,
			centerColumnForLabel(lineText, "Merge OMP"),
		);
		expect(mergeHover?.label).toBe("Merge OMP");
		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, mergeHover);

		previousLabel = applyHoverTransition(statuses, buttons, previousLabel, undefined);
		expect(previousLabel).toBeUndefined();

		for (const button of buttons) {
			expect(statuses.get(button.statusKey)).toBe(button.normalText);
		}

		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Git"))?.label,
		).toBe("Git");
		expect(
			getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Merge OMP"))?.label,
		).toBe("Merge OMP");
	});

	test("Merge OMP should still be hit-testable when visible text loses trailing ANSI reset", () => {
		const buttons = ACTION_BUTTONS;
		const git = buttons.find(button => button.label === "Git");
		const merge = buttons.find(button => button.label === "Merge OMP");
		expect(git).toBeDefined();
		expect(merge).toBeDefined();

		const mergeWithoutReset = merge!.normalText.replace(/\x1b\[0m$/, "");
		const lineText = `${git!.normalText} ${mergeWithoutReset}`;
		expect(stripAnsi(lineText)).toContain("Merge OMP");

		const mergeHit = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Merge OMP"));
		expect(mergeHit?.label).toBe("Merge OMP");
	});

	test("Git remains clickable while visible even if rendered without ANSI envelope", () => {
		const buttons = ACTION_BUTTONS;
		const git = buttons.find(button => button.label === "Git");
		const merge = buttons.find(button => button.label === "Merge OMP");
		expect(git).toBeDefined();
		expect(merge).toBeDefined();

		const lineText = `${stripAnsi(git!.normalText)} ${merge!.normalText}`;
		expect(stripAnsi(lineText)).toContain("Git");

		const gitHit = getActionButtonUnderMouse(buttons, lineText, centerColumnForLabel(lineText, "Git"));
		expect(gitHit?.label).toBe("Git");
	});

	test("startup no longer auto-applies archived workflow patch bundles", async () => {
		const source = await readExtensionSource();

		expect(source).not.toContain("ensureWorkflowPatchHealth");
		expect(source).not.toContain("WORKFLOW_PATCH_SCRIPT_PATH");
		expect(source).not.toContain("OMP_IMPLEMENT_PATCH_GUARD");
		expect(source).not.toContain("manage.sh apply");
	});
});
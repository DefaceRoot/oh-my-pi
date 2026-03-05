import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const actionButtonsPath = path.join(import.meta.dir, "action-buttons.ts");
const actionButtonsSource = fs.readFileSync(actionButtonsPath, "utf8");

const EXPECTED_PLAN_REVIEW_EDITOR_TEXT = String.raw`Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n`;
const EXPECTED_FIX_PLAN_EDITOR_TEXT = "Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly \u2014 do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\\n\\nPlan Review Output:\\n";

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractActionButtonsBlock(source: string): string {
	const actionButtonsMatch = source.match(/const ACTION_BUTTONS:\s*ActionButtonUi\[\]\s*=\s*\[([\s\S]*?)\n\];/);
	expect(actionButtonsMatch).not.toBeNull();
	return actionButtonsMatch![1];
}

function extractEditorText(actionButtonsBlock: string, label: string): string {
	const pattern = new RegExp(`label:\\s*"${escapeRegex(label)}"[\\s\\S]*?editorText:\\s*"((?:\\\\.|[^"\\\\])*)",`);
	const match = actionButtonsBlock.match(pattern);
	expect(match).not.toBeNull();
	return match![1];
}

describe("interactive mode footer prompts", () => {
	test("includes required workflow action buttons", () => {
		const actionButtonsBlock = extractActionButtonsBlock(actionButtonsSource);
		const requiredLabels = ["Plan Review", "Fix Plan", "Submit PR", "Review", "Fix Issues", "Cleanup", "Worktree"];

		for (const label of requiredLabels) {
			expect(actionButtonsBlock).toContain(`label: "${label}"`);
		}
	});

	test("locks Plan Review and Fix Plan editorText prompts", () => {
		const actionButtonsBlock = extractActionButtonsBlock(actionButtonsSource);

		expect(extractEditorText(actionButtonsBlock, "Plan Review")).toBe(EXPECTED_PLAN_REVIEW_EDITOR_TEXT);
		expect(extractEditorText(actionButtonsBlock, "Fix Plan")).toBe(EXPECTED_FIX_PLAN_EDITOR_TEXT);
	});
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const actionButtonsPath = path.join(import.meta.dir, "action-buttons.ts");
const actionButtonsSource = fs.readFileSync(actionButtonsPath, "utf8");

const EXPECTED_PLAN_REVIEW_EDITOR_TEXT = String.raw`Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n`;
const EXPECTED_FIX_PLAN_EDITOR_TEXT =
	"Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\\n\\nPlan Review Output:\\n";

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractActionButtonsBlock(source: string): string {
	const actionButtonsMatch = source.match(/const ACTION_BUTTONS:\s*ActionButtonUi\[\]\s*=\s*\[(.*?)\];/s);
	expect(actionButtonsMatch).not.toBeNull();
	return actionButtonsMatch![1];
}

function extractWorkflowMenusBlock(source: string): string {
	const workflowMenusMatch = source.match(/const WORKFLOW_MENUS:\s*WorkflowMenu\[\]\s*=\s*\[([\s\S]*?)\];/);
	expect(workflowMenusMatch).not.toBeNull();
	return workflowMenusMatch![1];
}

function extractEditorTextBinding(sourceBlock: string, label: string): string {
	const pattern = new RegExp(`label:\\s*"${escapeRegex(label)}"[\\s\\S]*?editorText:\\s*([A-Z0-9_]+)`);
	const match = sourceBlock.match(pattern);
	expect(match).not.toBeNull();
	return match![1];
}

function extractStringConstant(source: string, constantName: string): string {
	const pattern = new RegExp(`const\\s+${escapeRegex(constantName)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)";`);
	const match = source.match(pattern);
	expect(match).not.toBeNull();
	return match![1];
}

describe("interactive mode footer prompts", () => {
	test("includes required direct action buttons and workflow labels", () => {
		const actionButtonsBlock = extractActionButtonsBlock(actionButtonsSource);
		const workflowMenusBlock = extractWorkflowMenusBlock(actionButtonsSource);
		const requiredDirectActionLabels = ["Git", "Refresh OMP"];
		const requiredWorkflowLabels = [
			"Plan Review",
			"Fix Plan",
			"Submit PR",
			"Review",
			"Fix Issues",
			"Cleanup",
			"Worktree",
		];

		expect(actionButtonsBlock).toContain("LAZYGIT_BUTTON");
		expect(actionButtonsBlock).toContain("FORK_REFRESH_BUTTON");

		for (const label of requiredDirectActionLabels) {
			expect(actionButtonsSource).toContain(`label: "${label}"`);
		}

		for (const label of requiredWorkflowLabels) {
			expect(workflowMenusBlock).toContain(`label: "${label}"`);
		}
	});

	test("locks Plan Review and Fix Plan editorText prompts", () => {
		const workflowMenusBlock = extractWorkflowMenusBlock(actionButtonsSource);

		expect(extractEditorTextBinding(workflowMenusBlock, "Plan Review")).toBe("PLAN_REVIEW_EDITOR_TEXT");
		expect(extractEditorTextBinding(workflowMenusBlock, "Fix Plan")).toBe("FIX_PLAN_EDITOR_TEXT");
		expect(extractStringConstant(actionButtonsSource, "PLAN_REVIEW_EDITOR_TEXT")).toBe(
			EXPECTED_PLAN_REVIEW_EDITOR_TEXT,
		);
		expect(extractStringConstant(actionButtonsSource, "FIX_PLAN_EDITOR_TEXT")).toBe(EXPECTED_FIX_PLAN_EDITOR_TEXT);
	});
});

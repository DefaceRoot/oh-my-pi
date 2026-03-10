import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ACTION_BUTTONS, WORKFLOW_MENUS, type WorkflowMenuEntry } from "../../packages/coding-agent/src/modes/action-buttons.ts";

const actionButtonsSourcePath = path.join(
	import.meta.dir,
	"..",
	"..",
	"packages/coding-agent/src/modes/action-buttons.ts",
);

interface WorkflowActionSnapshot {
	label: string;
	command: string;
	editorText?: string;
}

const EXPECTED_DIRECT_BUTTON_STYLES = [
	{
		label: "Git",
		command: "/lazygit",
		normalText: "\x1b[30;44m Git \x1b[0m",
		hoverText: "\x1b[30;104m Git \x1b[0m",
	},
	{
		label: "Merge OMP",
		command: "/merge-omp",
		normalText: "\x1b[30;46m Merge OMP \x1b[0m",
		hoverText: "\x1b[30;106m Merge OMP \x1b[0m",
	},
];

const EXPECTED_WORKFLOW_COMMANDS = new Map<string, string>([
	["Freeform", "/freeform-worktree"],
	["Planned", "/planned-worktree"],
	["Plan Review", "/plan-review"],
	["Fix Plan", "/fix-plan"],
	["Submit PR", "/submit-pr"],
	["Review", "/review-complete"],
	["Fix Issues", "/fix-issues"],
	["Cleanup", "/cleanup-worktrees"],
	["✕ Worktree", "/delete-worktree"],
]);

const EXPECTED_PLAN_REVIEW_EDITOR_TEXT =
"Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n";

const EXPECTED_FIX_PLAN_EDITOR_TEXT =
"Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\n\nPlan Review Output:\n";

async function readActionButtonsSource(): Promise<string> {
	return Bun.file(actionButtonsSourcePath).text();
}

function extractStringConstant(source: string, name: string): string {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = source.match(new RegExp(`const\\s+${escapedName}\\s*=\\s*\"((?:\\\\.|[^\"\\\\])*)\";`));
	expect(match).toBeTruthy();
	return JSON.parse(`\"${match?.[1] ?? ""}\"`) as string;
}

function flattenWorkflowEntries(entries: WorkflowMenuEntry[]): WorkflowActionSnapshot[] {
	const flattened: WorkflowActionSnapshot[] = [];

	for (const entry of entries) {
		if ("actions" in entry) {
			flattened.push(...flattenWorkflowEntries(entry.actions));
			continue;
		}
		flattened.push({
			label: entry.label,
			command: entry.command,
			editorText: entry.editorText,
		});
	}

	return flattened;
}

describe("footer action snapshot regression lock", () => {
	test("locks direct footer buttons, workflow commands, and critical prompt strings", async () => {
		const source = await readActionButtonsSource();
		const directByLabel = new Map(ACTION_BUTTONS.map(button => [button.label, button]));
		const workflowActions = WORKFLOW_MENUS.flatMap(menu => flattenWorkflowEntries(menu.actions));
		const workflowByLabel = new Map(workflowActions.map(action => [action.label, action]));

		for (const expected of EXPECTED_DIRECT_BUTTON_STYLES) {
			const actual = directByLabel.get(expected.label);
			expect(actual).toBeDefined();
			expect(actual?.command).toBe(expected.command);
			expect(actual?.normalText).toBe(expected.normalText);
			expect(actual?.hoverText).toBe(expected.hoverText);
		}

		for (const [label, command] of EXPECTED_WORKFLOW_COMMANDS) {
			const action = workflowByLabel.get(label);
			expect(action).toBeDefined();
			expect(action?.command).toBe(command);
		}

		const planReviewText = extractStringConstant(source, "PLAN_REVIEW_EDITOR_TEXT");
		const fixPlanText = extractStringConstant(source, "FIX_PLAN_EDITOR_TEXT");
		expect(planReviewText).toBe(EXPECTED_PLAN_REVIEW_EDITOR_TEXT);
		expect(fixPlanText).toBe(EXPECTED_FIX_PLAN_EDITOR_TEXT);

		expect(workflowByLabel.get("Plan Review")?.editorText).toBe(EXPECTED_PLAN_REVIEW_EDITOR_TEXT);
		expect(workflowByLabel.get("Fix Plan")?.editorText).toBe(EXPECTED_FIX_PLAN_EDITOR_TEXT);
	});
});
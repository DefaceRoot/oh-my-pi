import { visibleWidth } from "@oh-my-pi/pi-tui";

export const LAZYGIT_STATUS_KEY = "000-lazygit";
export const FORK_MERGE_STATUS_KEY = "yyy-omp-merge";
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

const PLAN_REVIEW_EDITOR_TEXT =
	"Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n";
const FIX_PLAN_EDITOR_TEXT =
	"Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\n\nPlan Review Output:\n";

export interface ActionButtonUi {
	label: string;
	command: string;
	statusKey: string;
	normalText: string;
	hoverText: string;
	editorText?: string;
}

export interface WorkflowMenuAction {
	id: string;
	label: string;
	command: string;
	editorText?: string;
}

export interface WorkflowMenuActionGroup {
	id: string;
	label: string;
	actions: WorkflowMenuAction[];
}

export type WorkflowMenuEntry = WorkflowMenuAction | WorkflowMenuActionGroup;

export interface WorkflowMenu {
	id: string;
	hotkeyAction: string;
	label: string;
	actions: WorkflowMenuEntry[];
}

export interface FlattenedWorkflowMenuAction extends WorkflowMenuAction {
	baseLabel: string;
	groupId?: string;
	groupLabel?: string;
}

export const LAZYGIT_BUTTON: ActionButtonUi = {
	label: "Git",
	command: "/lazygit",
	statusKey: LAZYGIT_STATUS_KEY,
	normalText: "\x1b[30;44m Git \x1b[0m",
	hoverText: "\x1b[30;104m Git \x1b[0m",
};

export const FORK_MERGE_BUTTON: ActionButtonUi = {
	label: "Merge OMP",
	command: "/merge-omp",
	statusKey: FORK_MERGE_STATUS_KEY,
	normalText: "\x1b[30;46m Merge OMP \x1b[0m",
	hoverText: "\x1b[30;106m Merge OMP \x1b[0m",
};

export const ACTION_BUTTONS: ActionButtonUi[] = [LAZYGIT_BUTTON, FORK_MERGE_BUTTON];

export const WORKFLOW_MENUS: WorkflowMenu[] = [
	{
		id: "worktree",
		hotkeyAction: "toggleWorktreeMenu",
		label: "Worktree",
		actions: [
			{
				id: "create-worktree",
				label: "Create",
				actions: [
					{ id: "freeform-worktree", label: "Freeform", command: "/freeform-worktree" },
					{ id: "planned-worktree", label: "Planned", command: "/planned-worktree" },
				],
			},
			{ id: "plan-review", label: "Plan Review", command: "/plan-review", editorText: PLAN_REVIEW_EDITOR_TEXT },
			{ id: "fix-plan", label: "Fix Plan", command: "/fix-plan", editorText: FIX_PLAN_EDITOR_TEXT },
			{ id: "git-menu", label: "Git Menu", command: "/git-menu" },
			{ id: "sync-needed", label: "! Sync", command: "/git-menu" },
			{ id: "submit-pr", label: "Submit PR", command: "/submit-pr" },
			{ id: "review-complete", label: "Review", command: "/review-complete" },
			{ id: "fix-issues", label: "Fix Issues", command: "/fix-issues" },
			{ id: "update-version-workflow", label: "Update Version", command: "/update-version-workflow" },
			{ id: "delete-worktree", label: "✕ Worktree", command: "/delete-worktree" },
			{ id: "cleanup-worktrees", label: "Cleanup", command: "/cleanup-worktrees" },
		],
	},
];

export function flattenWorkflowMenuActions(menu: WorkflowMenu): FlattenedWorkflowMenuAction[] {
	const flattened: FlattenedWorkflowMenuAction[] = [];

	for (const entry of menu.actions) {
		if ("actions" in entry) {
			for (const action of entry.actions) {
				flattened.push({
					...action,
					baseLabel: action.label,
					groupId: entry.id,
					groupLabel: entry.label,
					label: `[${entry.label}] ${action.label}`,
				});
			}
			continue;
		}

		flattened.push({
			...entry,
			baseLabel: entry.label,
		});
	}

	return flattened;
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

export function hasSameVisibleText(left: string, right: string): boolean {
	return stripAnsi(left).trim() === stripAnsi(right).trim();
}

export function findActionButtonBounds(
	line: string,
	button: ActionButtonUi,
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
			const startCol = visibleWidth(line.slice(0, labelIndex)) + 1;
			const endCol = startCol + visibleWidth(button.label) - 1;
			if (mouseCol < startCol || mouseCol > endCol) continue;

			const matchLength = visibleWidth(rendered);
			if (!bestMatch || matchLength > bestMatch.matchLength) {
				bestMatch = { startCol, endCol, matchLength };
			}
		}
	}

	return bestMatch;
}

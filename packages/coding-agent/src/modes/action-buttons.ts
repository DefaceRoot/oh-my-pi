import { visibleWidth } from "@oh-my-pi/pi-tui";

const PLAN_WORKFLOW_STATUS_KEY = "aaa-wt-worktree";
const SYNC_NEEDED_STATUS_KEY = "bbb-wt-sync";
const IMPLEMENT_WORKFLOW_STATUS_KEY = "ccc-wt-git";
const REVIEW_COMPLETE_STATUS_KEY = "ddd-wt-review";
const CLEANUP_WORKFLOW_STATUS_KEY = "eee-wt-cleanup";
const PLAN_REVIEW_STATUS_KEY = "fff-wt-plan-review";
const FIX_PLAN_STATUS_KEY = "ggg-wt-fix-plan";
const DELETE_WORKTREE_STATUS_KEY = "zzzz-wt-delete";
export const FORK_REFRESH_STATUS_KEY = "yyy-omp-refresh";
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

export interface ActionButtonUi {
	label: string;
	command: string;
	statusKey: string;
	normalText: string;
	hoverText: string;
	editorText?: string;
}

export const FORK_REFRESH_BUTTON: ActionButtonUi = {
	label: "Refresh OMP",
	command: "/refresh-fork",
	statusKey: FORK_REFRESH_STATUS_KEY,
	normalText: "\x1b[30;46m Refresh OMP \x1b[0m",
	hoverText: "\x1b[30;106m Refresh OMP \x1b[0m",
};

export const ACTION_BUTTONS: ActionButtonUi[] = [
	FORK_REFRESH_BUTTON,
	{
		label: "Worktree",
		command: "/planned-worktree",
		statusKey: PLAN_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;45m Worktree \x1b[0m",
		hoverText: "\x1b[30;105m Worktree \x1b[0m",
	},
	{
		label: "Git",
		command: "/git-menu",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;42m Git \x1b[0m",
		hoverText: "\x1b[30;102m Git \x1b[0m",
	},
	{
		label: "! Sync",
		command: "/git-menu",
		statusKey: SYNC_NEEDED_STATUS_KEY,
		normalText: "\x1b[30;103m ! Sync \x1b[0m",
		hoverText: "\x1b[30;43m ! Sync \x1b[0m",
	},
	{
		label: "Freeform",
		command: "/freeform-worktree",
		statusKey: PLAN_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;45m Freeform \x1b[0m",
		hoverText: "\x1b[30;105m Freeform \x1b[0m",
	},
	{
		label: "Planned",
		command: "/planned-worktree",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;46m Planned \x1b[0m",
		hoverText: "\x1b[30;106m Planned \x1b[0m",
	},
	{
		label: "Submit PR",
		command: "/submit-pr",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;42m Submit PR \x1b[0m",
		hoverText: "\x1b[30;102m Submit PR \x1b[0m",
	},
	{
		label: "Review",
		command: "/review-complete",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;44m Review \x1b[0m",
		hoverText: "\x1b[30;104m Review \x1b[0m",
	},
	{
		label: "Fix Issues",
		command: "/fix-issues",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;47m Fix Issues \x1b[0m",
		hoverText: "\x1b[30;107m Fix Issues \x1b[0m",
	},
	{
		label: "Update Version",
		command: "/update-version-workflow",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;46m Update Version \x1b[0m",
		hoverText: "\x1b[30;106m Update Version \x1b[0m",
	},
	{
		label: "✕ Worktree",
		command: "/delete-worktree",
		statusKey: DELETE_WORKTREE_STATUS_KEY,
		normalText: "\x1b[30;41m ✕ Worktree \x1b[0m",
		hoverText: "\x1b[30;101m ✕ Worktree \x1b[0m",
	},
	{
		label: "Cleanup",
		command: "/cleanup-worktrees",
		statusKey: CLEANUP_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;43m Cleanup \x1b[0m",
		hoverText: "\x1b[30;103m Cleanup \x1b[0m",
	},
	{
		label: "Plan Review",
		command: "/plan-review",
		statusKey: PLAN_REVIEW_STATUS_KEY,
		normalText: "\x1b[30;42m Plan Review \x1b[0m",
		hoverText: "\x1b[30;102m Plan Review \x1b[0m",
		editorText:
			"Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n",
	},
	{
		label: "Fix Plan",
		command: "/fix-plan",
		statusKey: FIX_PLAN_STATUS_KEY,
		normalText: "\x1b[30;42m Fix Plan \x1b[0m",
		hoverText: "\x1b[30;102m Fix Plan \x1b[0m",
		editorText:
			"Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\n\nPlan Review Output:\n",
	},
];

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

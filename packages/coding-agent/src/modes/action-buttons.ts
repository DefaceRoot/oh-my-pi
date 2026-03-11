import { visibleWidth } from "@oh-my-pi/pi-tui";

export const LAZYGIT_STATUS_KEY = "000-lazygit";
export const WORKTREE_MENU_STATUS_KEY = "050-worktree-menu";
export const FORK_MERGE_STATUS_KEY = "yyy-omp-merge";
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

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

export const WORKTREE_MENU_BUTTON: ActionButtonUi = {
	label: "Worktree",
	command: "/worktree-menu",
	statusKey: WORKTREE_MENU_STATUS_KEY,
	normalText: "\x1b[30;45m Worktree \x1b[0m",
	hoverText: "\x1b[30;105m Worktree \x1b[0m",
};

export const FORK_MERGE_BUTTON: ActionButtonUi = {
	label: "Merge OMP",
	command: "/merge-omp",
	statusKey: FORK_MERGE_STATUS_KEY,
	normalText: "\x1b[30;46m Merge OMP \x1b[0m",
	hoverText: "\x1b[30;106m Merge OMP \x1b[0m",
};

export const ACTION_BUTTONS: ActionButtonUi[] = [LAZYGIT_BUTTON, WORKTREE_MENU_BUTTON, FORK_MERGE_BUTTON];

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
			{
				id: "manage-worktree",
				label: "Manage",
				actions: [
					{ id: "delete-worktree", label: "Delete", command: "/delete-worktree" },
					{ id: "cleanup-worktrees", label: "Cleanup", command: "/cleanup-worktrees" },
				],
			},
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
		for (const variant of [rendered.trimEnd(), rendered.trimStart(), rendered.trim()]) {
			if (variant.length === 0 || variant === rendered) continue;
			if (variant.includes(button.label)) {
				renderedCandidates.add(variant);
			}
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

export function getActionButtonAtMouse(line: string, mouseCol: number): ActionButtonUi | undefined {
	const plainLine = stripAnsi(line);
	let bestHit: { button: ActionButtonUi; matchLength: number } | undefined;
	for (const button of ACTION_BUTTONS) {
		const bounds = findActionButtonBounds(plainLine, button, mouseCol);
		if (!bounds) continue;
		if (!bestHit || bounds.matchLength > bestHit.matchLength) {
			bestHit = { button, matchLength: bounds.matchLength };
		}
	}

	return bestHit?.button;
}

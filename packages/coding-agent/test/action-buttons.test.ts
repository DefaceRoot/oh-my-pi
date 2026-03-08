import { describe, expect, test } from "bun:test";
import { ACTION_BUTTONS, WORKFLOW_MENUS, flattenWorkflowMenuActions } from "../src/modes/action-buttons";

describe("Action Buttons Model", () => {
	test("keeps Worktree as a stable top-level workflow menu", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		expect(worktreeMenu?.hotkeyAction).toBe("toggleWorktreeMenu");
	});

	test("groups create actions under Worktree with explicit group model", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		const createGroup = worktreeMenu?.actions.find(entry => "actions" in entry && entry.id === "create-worktree");
		const flattenedLabels = new Set(worktreeMenu ? flattenWorkflowMenuActions(worktreeMenu).map(action => action.label) : []);

		expect(createGroup).toBeDefined();
		expect(flattenedLabels.has("[Create] Freeform")).toBe(true);
		expect(flattenedLabels.has("[Create] Planned")).toBe(true);
	});

	test("keeps direct action buttons focused on standalone actions", () => {
		expect(ACTION_BUTTONS.some(button => button.label === "Refresh OMP")).toBe(true);
		expect(ACTION_BUTTONS.some(button => button.label === "Worktree")).toBe(false);
	});

	test("adds a blue lazygit direct action button first", () => {
		const lazygitButton = ACTION_BUTTONS.find(button => button.command === "/lazygit");

		expect(lazygitButton).toBeDefined();
		expect(ACTION_BUTTONS[0]?.command).toBe("/lazygit");
		expect(lazygitButton).toMatchObject({
			label: "Git",
			command: "/lazygit",
			normalText: "\x1b[30;44m Git \x1b[0m",
			hoverText: "\x1b[30;104m Git \x1b[0m",
		});
	});

	test("renames worktree git action to Git Menu", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		const flattenedActions = worktreeMenu ? flattenWorkflowMenuActions(worktreeMenu) : [];
		const gitAction = flattenedActions.find(action => action.id === "git-menu");

		expect(gitAction).toBeDefined();
		expect(gitAction?.label).toBe("Git Menu");
	});
});

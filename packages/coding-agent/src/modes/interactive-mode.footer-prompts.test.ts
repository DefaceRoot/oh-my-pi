import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const actionButtonsPath = path.join(import.meta.dir, "action-buttons.ts");
const actionButtonsSource = fs.readFileSync(actionButtonsPath, "utf8");

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

describe("interactive mode footer prompts", () => {
	test("includes git, worktree, and merge action buttons together", () => {
		const actionButtonsBlock = extractActionButtonsBlock(actionButtonsSource);
		const requiredDirectActionLabels = ["Git", "Worktree", "Merge OMP"];

		expect(actionButtonsBlock).toContain("LAZYGIT_BUTTON");
		expect(actionButtonsBlock).toContain("WORKTREE_MENU_BUTTON");
		expect(actionButtonsBlock).toContain("FORK_MERGE_BUTTON");

		for (const label of requiredDirectActionLabels) {
			expect(actionButtonsSource).toContain(`label: "${label}"`);
		}
	});

	test("keeps worktree workflow menu focused on worktree actions only", () => {
		const workflowMenusBlock = extractWorkflowMenusBlock(actionButtonsSource);
		const requiredWorkflowLabels = ["Worktree", "Create", "Freeform", "Planned", "Manage", "Delete", "Cleanup"];
		const forbiddenWorkflowLabels = [
			"Plan Review",
			"Fix Plan",
			"Git Menu",
			"Submit PR",
			"Review",
			"Fix Issues",
			"Update Version",
			"✕ Worktree",
			"! Sync",
		];

		for (const label of requiredWorkflowLabels) {
			expect(workflowMenusBlock).toContain(`label: "${label}"`);
		}

		for (const label of forbiddenWorkflowLabels) {
			expect(workflowMenusBlock).not.toContain(`label: "${label}"`);
		}
	});
});
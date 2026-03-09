import { describe, expect, test } from "bun:test";
import {
	WORKFLOW_ACTION_IDS,
	deriveWorkflowActionStates,
	type ActionButtonStage,
	type WorkflowActionId,
	type WorkflowActionState,
} from "./workflow-action-state.ts";

function toRecord(
	states: Map<WorkflowActionId, WorkflowActionState>,
): Record<WorkflowActionId, WorkflowActionState> {
	return Object.fromEntries(states) as Record<WorkflowActionId, WorkflowActionState>;
}

function expectExactStates(input: {
	states: Record<WorkflowActionId, WorkflowActionState>;
	enabled: WorkflowActionId[];
	hidden?: WorkflowActionId[];
}): void {
	const { states, enabled, hidden = [] } = input;
	const enabledSet = new Set(enabled);
	const hiddenSet = new Set(hidden);

	for (const actionId of WORKFLOW_ACTION_IDS) {
		const expected: WorkflowActionState = hiddenSet.has(actionId)
			? "hidden"
			: enabledSet.has(actionId)
				? "enabled"
				: "disabled";
		expect(states[actionId]).toBe(expected);
	}
}

const ACTIVE_WORKTREE_BASE_ENABLED: WorkflowActionId[] = [
	"git-menu",
	"delete-worktree",
	"cleanup-worktrees",
];

describe("implementation-engine workflow action state derivation", () => {
	test("hides all actions when stage is none", () => {
		const states = deriveWorkflowActionStates({
			stage: "none",
			hasActiveWorktree: false,
			syncNeeded: false,
		});

		expect(states.size).toBe(WORKFLOW_ACTION_IDS.length);
		expectExactStates({
			states: toRecord(states),
			enabled: [],
			hidden: [...WORKFLOW_ACTION_IDS],
		});
	});

	test("enables only create and planning controls when no worktree is active", () => {
		const states = toRecord(
			deriveWorkflowActionStates({
				stage: "plan",
				hasActiveWorktree: false,
				syncNeeded: false,
			}),
		);

		expectExactStates({
			states,
			enabled: [
				"freeform-worktree",
				"planned-worktree",
				"plan-review",
				"fix-plan",
				"cleanup-worktrees",
			],
		});
	});

	test("enables submit-pr review path and sync when active worktree needs sync", () => {
		const states = toRecord(
			deriveWorkflowActionStates({
				stage: "submit-pr",
				hasActiveWorktree: true,
				syncNeeded: true,
			}),
		);

		expectExactStates({
			states,
			enabled: [
				...ACTIVE_WORKTREE_BASE_ENABLED,
				"sync-branch",
				"submit-pr",
				"review-complete",
			],
		});
	});

	test("enables fix-issues path without exposing unrelated actions", () => {
		const states = toRecord(
			deriveWorkflowActionStates({
				stage: "fix-issues",
				hasActiveWorktree: true,
				syncNeeded: false,
			}),
		);

		expectExactStates({
			states,
			enabled: [...ACTIVE_WORKTREE_BASE_ENABLED, "fix-issues"],
		});
	});

	test("enables update-version action only in update-version stage", () => {
		const states = toRecord(
			deriveWorkflowActionStates({
				stage: "update-version",
				hasActiveWorktree: true,
				syncNeeded: false,
			}),
		);

		expectExactStates({
			states,
			enabled: [...ACTIVE_WORKTREE_BASE_ENABLED, "update-version-workflow"],
		});
	});

	test("plan/implement/cleanup active stages keep submit-pr as center action", () => {
		for (const stage of ["plan", "implement", "cleanup"] as ActionButtonStage[]) {
			const states = toRecord(
				deriveWorkflowActionStates({
					stage,
					hasActiveWorktree: true,
					syncNeeded: false,
				}),
			);

			expectExactStates({
				states,
				enabled: [...ACTIVE_WORKTREE_BASE_ENABLED, "submit-pr"],
			});
		}
	});
});

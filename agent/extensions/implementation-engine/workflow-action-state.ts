export type WorkflowActionState = "hidden" | "disabled" | "enabled";

export type ActionButtonStage =
	| "plan"
	| "implement"
	| "submit-pr"
	| "fix-issues"
	| "update-version"
	| "cleanup"
	| "none";

export const WORKFLOW_ARTIFACT_DIR_TEMPLATES = {
	planned: ".omp/sessions/plans/<plan>/<nested_dir_for_all_subagents>",
	nonPlanned: ".omp/sessions/<session>/<nested_dir_for_all_subagents>",
} as const;

export function deriveWorkflowArtifactDirTemplate(stage: ActionButtonStage): string {
	switch (stage) {
		case "plan":
		case "implement":
		case "submit-pr":
		case "fix-issues":
		case "update-version":
		case "cleanup":
			return WORKFLOW_ARTIFACT_DIR_TEMPLATES.planned;
		case "none":
			return WORKFLOW_ARTIFACT_DIR_TEMPLATES.nonPlanned;
	}
}

export const WORKFLOW_ACTION_IDS = [
	"freeform-worktree",
	"planned-worktree",
	"plan-review",
	"fix-plan",
	"git-menu",
	"sync-branch",
	"submit-pr",
	"review-complete",
	"fix-issues",
	"update-version-workflow",
	"cleanup-worktrees",
	"delete-worktree",
] as const;

export type WorkflowActionId = (typeof WORKFLOW_ACTION_IDS)[number];

export function deriveWorkflowActionStates(input: {
	stage: ActionButtonStage;
	hasActiveWorktree: boolean;
	syncNeeded: boolean;
}): Map<WorkflowActionId, WorkflowActionState> {
	const { stage, hasActiveWorktree, syncNeeded } = input;
	const workflowStates = new Map<WorkflowActionId, WorkflowActionState>(
		WORKFLOW_ACTION_IDS.map(actionId => [actionId, "disabled"]),
	);

	const setEnabled = (...actionIds: WorkflowActionId[]) => {
		for (const actionId of actionIds) {
			workflowStates.set(actionId, "enabled");
		}
	};

	if (stage === "none") {
		for (const actionId of WORKFLOW_ACTION_IDS) {
			workflowStates.set(actionId, "hidden");
		}
		return workflowStates;
	}

	if (!hasActiveWorktree) {
		setEnabled(
			"freeform-worktree",
			"planned-worktree",
			"plan-review",
			"fix-plan",
			"cleanup-worktrees",
		);
		return workflowStates;
	}

	setEnabled("git-menu", "delete-worktree", "cleanup-worktrees");
	if (syncNeeded) {
		setEnabled("sync-branch");
	}

	switch (stage) {
		case "submit-pr":
			setEnabled("submit-pr", "review-complete");
			break;
		case "fix-issues":
			setEnabled("fix-issues");
			break;
		case "update-version":
			setEnabled("update-version-workflow");
			break;
		case "cleanup":
			setEnabled("submit-pr");
			break;
		case "plan":
		case "implement":
			setEnabled("submit-pr");
			break;
		case "none":
			break;
	}

	return workflowStates;
}

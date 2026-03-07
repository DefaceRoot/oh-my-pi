type BudgetState = "pre_delegation" | "post_task_verification";

type ReadResult = { allowed: true } | { allowed: false; reason: string };

const PROTOCOL_PREFIXES = ["skill://", "memory://", "rule://", "plan://"];

export function isOrchestratorReadProtocolPath(path: string): boolean {
	return PROTOCOL_PREFIXES.some(prefix => path.startsWith(prefix));
}
const PRE_DELEGATION_MAX = 5;
const POST_TASK_EXTRA_MAX = 2;

export class OrchestratorReadBudget {
	state: BudgetState = "pre_delegation";
	private preDelegationPaths = new Set<string>();
	private taskModifiedFiles = new Set<string>();
	private postTaskExtraPaths = new Set<string>();

	tryRead(path: string): ReadResult {
		if (isOrchestratorReadProtocolPath(path)) {
			return { allowed: true };
		}

		if (this.state === "pre_delegation") {
			if (this.preDelegationPaths.has(path)) return { allowed: true };
			if (this.preDelegationPaths.size >= PRE_DELEGATION_MAX) {
				return {
					allowed: false,
					reason: `Orchestrator read budget exceeded (${PRE_DELEGATION_MAX} files). Delegate to a subagent for further exploration.`,
				};
			}
			this.preDelegationPaths.add(path);
			return { allowed: true };
		}

		if (this.taskModifiedFiles.has(path)) return { allowed: true };
		if (this.postTaskExtraPaths.has(path)) return { allowed: true };
		if (this.postTaskExtraPaths.size >= POST_TASK_EXTRA_MAX) {
			return {
				allowed: false,
				reason: `Post-task context read budget exceeded (${POST_TASK_EXTRA_MAX} additional files beyond task-modified files).`,
			};
		}
		this.postTaskExtraPaths.add(path);
		return { allowed: true };
	}

	transitionToPostTask(modifiedFiles: Set<string>): void {
		this.state = "post_task_verification";
		this.taskModifiedFiles = new Set(modifiedFiles);
		this.postTaskExtraPaths.clear();
	}

	resetForNextDelegation(): void {
		this.state = "pre_delegation";
		this.preDelegationPaths.clear();
		this.taskModifiedFiles.clear();
		this.postTaskExtraPaths.clear();
	}
}

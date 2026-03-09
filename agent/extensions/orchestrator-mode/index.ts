import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	isOrchestratorParentToolAllowed,
	resolveParentRuntimeRole,
	shouldEnforceOrchestratorGuards,
} from "../implementation-engine/orchestrator-guard.ts";
import { OrchestratorReadBudget } from "../implementation-engine/orchestrator-read-budget.ts";

type OrchestratorPolicyEvent = {
	toolName: string;
	input?: unknown;
};

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
};

type TodoPhase = {
	id: string;
	name: string;
	tasks: TodoTask[];
};

type SessionMessageEntry = {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: { phases?: unknown };
		isError?: boolean;
	};
};

type OrchestratorPolicyContext = {
	orchestratorModeThisTurn: boolean;
	activeAgentIsParentTurn: boolean;
	todoBootstrapRequired: boolean;
	todoRefreshRequired: boolean;
	todoDeficiencyReason?: string;
};

type OrchestratorContextParams = {
	role: string | undefined;
	promptText: string;
	hasUI: boolean;
	sessionFile: string | undefined;
};

type OrchestratorBlockDecision = { block: true; reason: string } | undefined;

const NESTED_TASK_SESSION_RE = /(?:^|\/)\d+-[A-Za-z][^/]*\.jsonl$/;
const SUBAGENT_PROMPT_RE = /your assignment is below\./i;
const SUBAGENT_DIVIDER_RE = /═══════════Task═══════════/;
const NATIVE_HANDOFF_PROMPT_RE = /Write a comprehensive handoff document that will allow another instance/;
const MIN_ORCHESTRATOR_TODO_PHASES = 2;
const MIN_ORCHESTRATOR_TODO_TASKS = 3;

function detectCurrentRole(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; role?: unknown };
		if (entry.type === "model_change" && typeof entry.role === "string") {
			return entry.role;
		}
	}
	return undefined;
}

function cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		id: phase.id,
		name: phase.name,
		tasks: phase.tasks.map((task) => ({
			id: task.id,
			content: task.content,
			status: task.status,
			notes: task.notes,
		})),
	}));
}

function getLatestTodoPhasesFromEntries(entries: SessionMessageEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (
			message?.role !== "toolResult" ||
			message.toolName !== "todo_write" ||
			message.isError ||
			!Array.isArray(message.details?.phases)
		) {
			continue;
		}

		return cloneTodoPhases(message.details.phases as TodoPhase[]);
	}

	return [];
}

function getTodoPlanDeficiency(phases: TodoPhase[]): string | undefined {
	if (phases.length < MIN_ORCHESTRATOR_TODO_PHASES) {
		return `Create at least ${MIN_ORCHESTRATOR_TODO_PHASES} named phases so the user can follow orchestration progress.`;
	}

	const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	if (totalTasks < MIN_ORCHESTRATOR_TODO_TASKS) {
		return `Expand the todo list to at least ${MIN_ORCHESTRATOR_TODO_TASKS} concrete tasks across the phases.`;
	}

	for (const phase of phases) {
		if (!phase.name.trim()) {
			return "Every todo phase needs a clear name.";
		}
		if (phase.tasks.length === 0) {
			return "Every todo phase needs at least one concrete task.";
		}
		for (const task of phase.tasks) {
			if (!task.content.trim()) {
				return "Every todo item needs clear task text.";
			}
		}
	}

	return undefined;
}

function isOrchestratorContext(
	params: OrchestratorContextParams,
): OrchestratorPolicyContext {
	if (!params.hasUI) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
		};
	}

	if (!params.promptText.trim()) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
		};
	}

	if (NATIVE_HANDOFF_PROMPT_RE.test(params.promptText)) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
		};
	}

	if (
		SUBAGENT_PROMPT_RE.test(params.promptText) ||
		SUBAGENT_DIVIDER_RE.test(params.promptText)
	) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
		};
	}

	if (
		typeof params.sessionFile === "string" &&
		NESTED_TASK_SESSION_RE.test(params.sessionFile)
	) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
		};
	}

	const parentRuntimeRole = resolveParentRuntimeRole(params.role);
	const activeAgentIsParentTurn = true;
	const orchestratorModeThisTurn = shouldEnforceOrchestratorGuards({
		activeAgentIsParentTurn,
		parentRuntimeRole,
	});

	return {
		orchestratorModeThisTurn,
		activeAgentIsParentTurn,
		todoBootstrapRequired: false,
		todoRefreshRequired: false,
	};
}
function isTodoGateExceptionTool(toolName: string): boolean {
	return toolName === "todo_write" || toolName === "await";
}

function buildOrchestratorPrompt(): string {
	return [
		"",
		"## ORCHESTRATOR ROLE — DELEGATION ONLY",
		"",
		"<critical>",
		"You are using the Orchestrator model role.",
		"This role NEVER implements directly, even for tiny requests.",
		"If work is small enough to do directly, switch back to the Default role instead of doing it here.",
		"Your first response to any actionable request MUST be ONLY a numbered execution list with 2-6 items.",
		"Immediately after that execution list, create a detailed phased todo list with todo_write before any delegation happens.",
		"That todo list is the live source of truth for the session. Keep it deep, specific, and continuously updated.",
		"Do not keep a shallow todo list. Break every stage into concrete subtasks the user can follow.",
		"After every subagent result or new user instruction, update todo_write before any other orchestration action.",
		"The only exception is await when background work is already running and you need to wait before the next todo update.",
		"You do not edit files, write files, run discovery tools, or provide implementation details yourself.",
		"All investigation beyond the small read budget, all code changes, all tests, and all verification are delegated.",
		"Grafana-specific investigation, debugging, and dashboard work MUST be delegated to the grafana subagent.",
		"Only the grafana subagent has direct Grafana MCP access.",
		"</critical>",
		"",
		"Parent tool contract:",
		"- task for discovery, implementation, review, and verification",
		"- ask only when user input is truly required",
		"- await only to wait on background work that is already running",
		"- todo_write for detailed visible tracking from kickoff through closeout",
		"- read only for narrow decomposition, capped at 5 distinct files per user request",
		"- bash only for git status",
		"",
		`Detailed todo minimums: at least ${MIN_ORCHESTRATOR_TODO_PHASES} phases and at least ${MIN_ORCHESTRATOR_TODO_TASKS} concrete tasks overall.`,
		"If you are about to use any other tool or explain code changes yourself, stop and delegate instead.",
	].join("\n");

}

function shouldBlockTool(
	event: OrchestratorPolicyEvent,
	context: OrchestratorPolicyContext,
): OrchestratorBlockDecision {
	if (!context.orchestratorModeThisTurn || !context.activeAgentIsParentTurn) {
		return undefined;
	}

	if (context.todoRefreshRequired && !isTodoGateExceptionTool(event.toolName)) {
		return {
			block: true,
			reason:
				"Orchestrator mode: update todo_write now to reflect the latest progress before doing anything else.",
		};
	}

	if (context.todoBootstrapRequired && !isTodoGateExceptionTool(event.toolName)) {
		return {
			block: true,
			reason:
				`Orchestrator mode: create a detailed phased todo list with todo_write before continuing. ${context.todoDeficiencyReason ?? ""}`.trim(),
		};
	}

	if (!isOrchestratorParentToolAllowed(event.toolName)) {
		return {
			block: true,
			reason:
				`Orchestrator mode: parent tool '${event.toolName}' is disabled. ` +
				"Delegate through Task subagents instead.",
		};
	}

	return undefined;
}

export default function orchestratorModeExtension(pi: ExtensionAPI) {
	pi.logger.debug("orchestrator-mode: extension loaded");

	let orchestratorModeThisTurn = false;
	let activeAgentIsParentTurn = false;
	let todoBootstrapRequired = false;
	let todoRefreshRequired = false;
	let todoDeficiencyReason: string | undefined;
	const readBudget = new OrchestratorReadBudget();

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const promptText = event.prompt?.trim() ?? "";
			const role = detectCurrentRole(ctx);
			const sessionFile = (
				ctx.sessionManager as { getSessionFile?: () => string | undefined }
			).getSessionFile?.();
			const orchestratorContext = isOrchestratorContext({
				role,
				promptText,
				hasUI: ctx.hasUI,
				sessionFile,
			});

			orchestratorModeThisTurn = orchestratorContext.orchestratorModeThisTurn;
			activeAgentIsParentTurn = orchestratorContext.activeAgentIsParentTurn;
			readBudget.resetForNextDelegation();

			if (!orchestratorModeThisTurn) {
				todoBootstrapRequired = false;
				todoRefreshRequired = false;
				todoDeficiencyReason = undefined;
				return;
			}

			const todoPhases = getLatestTodoPhasesFromEntries(
				ctx.sessionManager.getEntries() as SessionMessageEntry[],
			);
			todoDeficiencyReason = getTodoPlanDeficiency(todoPhases);
			todoBootstrapRequired = Boolean(todoDeficiencyReason);

			pi.logger.debug("orchestrator-mode: enforcing delegation-only parent policy", {
				role: role ?? "unknown",
				sessionFile,
				todoBootstrapRequired,
				todoRefreshRequired,
				todoDeficiencyReason,
			});

			return {
				systemPrompt: event.systemPrompt + buildOrchestratorPrompt(),
			};
		} catch (err) {
			orchestratorModeThisTurn = false;
			activeAgentIsParentTurn = false;
			todoBootstrapRequired = false;
			todoRefreshRequired = false;
			todoDeficiencyReason = undefined;
			pi.logger.warn(
				"orchestrator-mode: failed to detect orchestrator context; fail-open policy allows tool call",
				{
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
	});

	pi.on("tool_call", async (event) => {
		const decision = shouldBlockTool(event, {
			orchestratorModeThisTurn,
			activeAgentIsParentTurn,
			todoBootstrapRequired,
			todoRefreshRequired,
			todoDeficiencyReason,
		});
		if (decision) return decision;

		if (!orchestratorModeThisTurn || !activeAgentIsParentTurn) return;

		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "read") {
			const readPath = typeof input.path === "string" ? input.path.trim() : "";
			if (!readPath) {
				return {
					block: true,
					reason: "Orchestrator mode: read requires an explicit path.",
				};
			}
			const budgetResult = readBudget.tryRead(readPath);
			if (!budgetResult.allowed) {
				return {
					block: true,
					reason: budgetResult.reason,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			if (!/^git\s+status(?:\s|$)/.test(command.trim())) {
				return {
					block: true,
					reason: "Orchestrator mode: bash is limited to `git status`.",
				};
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!orchestratorModeThisTurn || !activeAgentIsParentTurn || event.isError) return;

		if (event.toolName === "todo_write") {
			const todoPhases = Array.isArray((event.details as { phases?: unknown } | undefined)?.phases)
				? cloneTodoPhases((event.details as { phases: TodoPhase[] }).phases)
				: getLatestTodoPhasesFromEntries(ctx.sessionManager.getEntries() as SessionMessageEntry[]);
			todoDeficiencyReason = getTodoPlanDeficiency(todoPhases);
			todoBootstrapRequired = Boolean(todoDeficiencyReason);
			todoRefreshRequired = false;
		}

		if (event.toolName === "task") {
			todoRefreshRequired = true;
		}
	});
}

export const _testExports = {
	buildOrchestratorPrompt,
	getLatestTodoPhasesFromEntries,
	getTodoPlanDeficiency,
	isOrchestratorContext,
	shouldBlockTool,
};

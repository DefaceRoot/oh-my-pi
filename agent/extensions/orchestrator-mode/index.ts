import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { buildPlanTodoBootstrapData } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-todos";
import { collectDelegationContext } from "@oh-my-pi/pi-coding-agent/task/delegation-context";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	getLatestTodoPhasesFromEntries,
	getLatestTodoPhasesFromEntriesOrUndefined,
	TODO_BOOTSTRAP_ENTRY_TYPE,
	type TodoBootstrapEntryData,
	type TodoPhase,
} from "@oh-my-pi/pi-coding-agent/tools/todo-write";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
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

function resolvePlanTodoBootstrap(
	ctx: ExtensionContext,
): TodoBootstrapEntryData | undefined {
	const metadata = collectDelegationContext({
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		getSessionFile: () => {
			const manager = ctx.sessionManager as { getSessionFile?: () => string | undefined };
			return manager.getSessionFile?.() ?? null;
		},
		getSessionSpawns: () => "*",
		settings: {} as ToolSession["settings"],
		getCompactContext: () => "",
		getSessionEntries: () => ctx.sessionManager.getEntries() as Array<Record<string, unknown>>,
		getPlanModeState: () => undefined,
	} as ToolSession);
	const planFilePath = metadata.planFilePath?.trim();
	if (!planFilePath) return undefined;

	let resolvedPlanPath: string;
	try {
		resolvedPlanPath = planFilePath.startsWith("local://")
			? resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => ctx.sessionManager.getArtifactsDir?.() ?? null,
				getSessionId: () => ctx.sessionManager.getSessionId?.() ?? null,
			})
			: path.normalize(resolveToCwd(planFilePath, ctx.cwd));
	} catch {
		return undefined;
	}

	if (!fs.existsSync(resolvedPlanPath)) return undefined;
	const planContent = fs.readFileSync(resolvedPlanPath, "utf8");
	return buildPlanTodoBootstrapData(planContent, planFilePath);
}

function persistPlanTodoBootstrap(ctx: ExtensionContext, data: TodoBootstrapEntryData): void {
	const sessionManager = ctx.sessionManager as { appendCustomEntry?: (customType: string, data?: unknown) => string };
	if (!sessionManager.appendCustomEntry) return;
	sessionManager.appendCustomEntry(TODO_BOOTSTRAP_ENTRY_TYPE, data);
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

function isAgentResultRead(event: OrchestratorPolicyEvent): boolean {
	if (event.toolName !== "read") return false;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const readPath = typeof input.path === "string" ? input.path.trim() : "";
	return readPath.startsWith("agent://");
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
		"Your first action to any actionable request MUST be immediate delegation or creating the detailed todo list.",
		"Skip the preamble. Do not output a numbered execution list before acting.",
		"Either spawn an exploration/research subagent immediately, or create a detailed phased todo list with todo_write.",
		"That todo list is the live source of truth for the session. Keep it deep, specific, and continuously updated.",
		"Do not keep a shallow todo list. Break every stage into concrete subtasks the user can follow.",
		"After every subagent result or new user instruction, update todo_write before any other orchestration action.",
		"The only exception is await when background work is already running and you need to wait before the next todo update.",
		"You do not edit files, write files, run discovery tools, or provide implementation details yourself.",
		"All investigation beyond the small read budget, all code changes, all tests, and all verification are delegated.",
		"Routing decision tree: bug reports, failing tests, and unexpected behavior MUST go to the debug subagent.",
		"Routing decision tree: known-good scoped code changes go to implement after diagnosis is complete.",
		"Routing decision tree: direct git-only handoff goes to commit only when no implementation-owned file set is pending.",
		"Do not delegate lint or code-reviewer directly from the parent turn; those run only inside implement/debug quality loops.",
		"Grafana-specific investigation, debugging, and dashboard work MUST be delegated to the grafana subagent.",
		"Only the grafana subagent has direct Grafana MCP access.",
		"</critical>",
		"",
		"Available subagents — spawn via task with agent: \"<name>\":",
		"- explore       : read-only codebase scout; use for all discovery and reconnaissance",
		"- research      : web search + semantic codebase research specialist",
		"- implement     : implementation worker (owns lint → code-reviewer → commit loop)",
		"- debug         : root-cause debugging specialist (diagnose, reproduce, and fix)",
		"- designer      : frontend/UI specialist",
		"- grafana       : Grafana investigation and dashboard specialist",
		"- lint          : quality gate runner (implementation-owned; do not spawn directly)",
		"- code-reviewer : evidence-first code reviewer (implementation-owned; do not spawn directly)",
		"- verifier      : phase-end verification specialist",
		"- coderabbit    : CodeRabbit CLI verifier",
		"- commit        : git-only commit specialist",
		"- merge         : git rebase/conflict specialist",
		"- curator       : naming specialist",
		"- plan          : plan authoring architect",
		"- plan-verifier : plan-only verifier",
		"- worktree-setup: git worktree setup specialist",
		"There is no 'code', 'coder', 'worker', or any other agent. Use only the names above.",
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

	const allowTodoRefreshGateBypass =
		isTodoGateExceptionTool(event.toolName) || isAgentResultRead(event);

	if (context.todoRefreshRequired && !allowTodoRefreshGateBypass) {
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

			let todoPhases = getLatestTodoPhasesFromEntriesOrUndefined(
				ctx.sessionManager.getEntries() as never,
			);
			if (todoPhases === undefined) {
				const bootstrap = resolvePlanTodoBootstrap(ctx);
				if (bootstrap) {
					todoPhases = bootstrap.phases;
					persistPlanTodoBootstrap(ctx, bootstrap);
				}
			}
			todoDeficiencyReason = getTodoPlanDeficiency(todoPhases ?? []);
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
				? ((event.details as { phases: TodoPhase[] }).phases)
				: getLatestTodoPhasesFromEntries(ctx.sessionManager.getEntries() as never);
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

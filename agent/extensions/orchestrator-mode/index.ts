import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RolesConfigFile } from "@oh-my-pi/pi-coding-agent";
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
	resolveParentRuntimeRole,
	isOrchestratorParentToolAllowed,
	shouldEnforceOrchestratorGuards,
} from "../implementation-engine/orchestrator-guard.ts";
import { OrchestratorReadBudget } from "../implementation-engine/orchestrator-read-budget.ts";

type OrchestratorPolicyEvent = {
	toolName: string;
	input?: unknown;
};

type OrchestratorToolAccess = {
	toolNames: Set<string>;
	mcpPrefixes: string[];
};

type OrchestratorRolesShape = {
	roles?: Record<string, { tools?: unknown; mcp?: unknown }>;
};

type OrchestratorPolicyContext = {
	orchestratorModeThisTurn: boolean;
	activeAgentIsParentTurn: boolean;
	todoBootstrapRequired: boolean;
	todoRefreshRequired: boolean;
	todoDeficiencyReason?: string;
	orchestratorToolAccess?: OrchestratorToolAccess;
	/** True once checkpoint() succeeds in this turn; cleared at turn start. */
	checkpointCreatedThisTurn: boolean;
	/** True when explore/research results land; must call rewind before dispatching impl agents. */
	rewindRequiredBeforeImplementation: boolean;
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
const REPO_ROLES_PATH = path.resolve(import.meta.dir, "..", "..", "roles.yml");

let autoSkillTrackingSessionId: string | undefined;
let autoSkillSessionPromptSignature: string | undefined;
let requiredAutoSkillUrls = new Set<string>();
let completedAutoSkillUrls = new Set<string>();
let pendingAutoSkillReadUrls: string[] = [];
let orchestratorToolAccess = resolveOrchestratorToolAccess(REPO_ROLES_PATH);

function toMcpToolPrefix(serverName: string): string | undefined {
	const normalized = serverName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!normalized) return undefined;

	return `mcp_${normalized}_`;
}

function resolveOrchestratorToolAccess(rolesPath: string): OrchestratorToolAccess | undefined {
	const configFile = RolesConfigFile.relocate(rolesPath);
	configFile.invalidate();
	const loaded = configFile.load();
	if (!loaded || typeof loaded !== "object") return undefined;

	const roles = loaded as OrchestratorRolesShape;
	const orchestratorRole = roles.roles?.orchestrator;
	if (!orchestratorRole || typeof orchestratorRole !== "object") return undefined;

	const toolNames = new Set<string>();
	if (Array.isArray(orchestratorRole.tools)) {
		for (const toolName of orchestratorRole.tools) {
			if (typeof toolName !== "string") continue;
			const normalizedToolName = toolName.trim();
			if (normalizedToolName.length > 0) {
				toolNames.add(normalizedToolName);
			}
		}
	}

	const mcpPrefixes = Array.isArray(orchestratorRole.mcp)
		? orchestratorRole.mcp
			.map(serverName => (typeof serverName === "string" ? toMcpToolPrefix(serverName) : undefined))
			.filter((prefix): prefix is string => prefix !== undefined)
		: [];

	return { toolNames, mcpPrefixes };
}

function isToolAllowedByOrchestratorAccess(
	toolName: string,
	access: OrchestratorToolAccess | undefined,
): boolean {
	if (!access) return isOrchestratorParentToolAllowed(toolName);
	if (access.toolNames.has(toolName)) return true;
	return access.mcpPrefixes.some(prefix => toolName.startsWith(prefix));
}

function shouldBlockBashCommand(command: string, bashEnabled: boolean): OrchestratorBlockDecision {
	if (bashEnabled) return undefined;

	const normalizedCommand = command.trim();
	const gitStatusCommandRe = /^(?:cd\s+[^\s$`()[\]{}<>|;&]+(?:\s+[^\s$`()[\]{}<>|;&]+)*(?:\s*(?:&&|;)\s*)\s*)?git\s+status(?:\s+[^\s$`()[\]{}<>|;&]+)*$/;
	if (gitStatusCommandRe.test(normalizedCommand)) return undefined;

	return {
		block: true,
		reason: "Orchestrator mode: bash is limited to `git status` unless bash is enabled by the role config.",
	};
}

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

const MUST_READ_SKILLS_SECTION_RE = /# Must-Read Skills[\s\S]*?(?=\n# |\n$)/;
const MUST_READ_SKILL_URL_RE = /`(skill:\/\/[^`]+)`/g;
const AUTO_SKILL_BOOTSTRAP_PHASE_ID = "phase-auto-skill-reading";
const AUTO_SKILL_BOOTSTRAP_TASK_ID = "task-auto-skill-reading";

function extractMustReadSkillUrls(systemPrompt: string): string[] {
	const section = MUST_READ_SKILLS_SECTION_RE.exec(systemPrompt)?.[0];
	if (!section) return [];

	return Array.from(section.matchAll(MUST_READ_SKILL_URL_RE), match => match[1]);
}

function getSessionInitSystemPrompt(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; systemPrompt?: unknown };
		if (entry.type === "session_init" && typeof entry.systemPrompt === "string") {
			return entry.systemPrompt;
		}
	}

	return undefined;
}

function syncAutoSkillTracking(sessionId: string | undefined, sessionSystemPrompt: string | undefined): string[] {
	if (!sessionId) {
		autoSkillTrackingSessionId = undefined;
		autoSkillSessionPromptSignature = undefined;
		requiredAutoSkillUrls = new Set();
		completedAutoSkillUrls = new Set();
		pendingAutoSkillReadUrls = [];
		return [];
	}

	if (sessionId !== autoSkillTrackingSessionId) {
		autoSkillTrackingSessionId = sessionId;
		autoSkillSessionPromptSignature = undefined;
		requiredAutoSkillUrls = new Set();
		completedAutoSkillUrls = new Set();
		pendingAutoSkillReadUrls = [];
	}

	if (!sessionSystemPrompt) return [];

	if (sessionSystemPrompt !== autoSkillSessionPromptSignature) {
		autoSkillSessionPromptSignature = sessionSystemPrompt;
		requiredAutoSkillUrls = new Set(extractMustReadSkillUrls(sessionSystemPrompt));
		completedAutoSkillUrls = new Set();
		pendingAutoSkillReadUrls = [];
	}

	return [...requiredAutoSkillUrls].filter(skillUrl => !completedAutoSkillUrls.has(skillUrl));
}


function buildAutoSkillReminder(skillUrls: string[]): string {
	if (skillUrls.length === 0) return "";

	return [
		"",
		"<system-reminder>",
		`Before anything else, read the following skills: ${skillUrls.join(", ")}.`,
		"Read those skills before calling `todo_write`.",
		"</system-reminder>",
	].join("\n");
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
			checkpointCreatedThisTurn: false,
			rewindRequiredBeforeImplementation: false,
		};
	}

	if (!params.promptText.trim()) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
			checkpointCreatedThisTurn: false,
			rewindRequiredBeforeImplementation: false,
		};
	}

	if (NATIVE_HANDOFF_PROMPT_RE.test(params.promptText)) {
		return {
			orchestratorModeThisTurn: false,
			activeAgentIsParentTurn: false,
			todoBootstrapRequired: false,
			todoRefreshRequired: false,
			checkpointCreatedThisTurn: false,
			rewindRequiredBeforeImplementation: false,
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
			checkpointCreatedThisTurn: false,
			rewindRequiredBeforeImplementation: false,
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
			checkpointCreatedThisTurn: false,
			rewindRequiredBeforeImplementation: false,
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
		checkpointCreatedThisTurn: false,
		rewindRequiredBeforeImplementation: false,
	};
}
function isTodoGateExceptionTool(toolName: string): boolean {
	return toolName === "todo_write" || toolName === "await";
}

const EXPLORE_AGENT_TYPES = new Set(["explore", "research"]);
const IMPLEMENTATION_AGENT_TYPES = new Set(["implement", "debug", "designer"]);

function getTaskAgentTypes(input: unknown): string[] {
	const raw = input as Record<string, unknown> | null;
	const tasks = Array.isArray(raw?.tasks)
		? (raw as { tasks: Array<{ agent?: unknown }> }).tasks
		: [];
	return tasks
		.map(t => (typeof t.agent === "string" ? t.agent.toLowerCase().trim() : ""))
		.filter(Boolean);
}

function hasExploreAgents(input: unknown): boolean {
	return getTaskAgentTypes(input).some(a => EXPLORE_AGENT_TYPES.has(a));
}

function hasImplementationAgents(input: unknown): boolean {
	return getTaskAgentTypes(input).some(a => IMPLEMENTATION_AGENT_TYPES.has(a));
}

function isTodoBootstrapExceptionTool(event: OrchestratorPolicyEvent): boolean {
	return isTodoGateExceptionTool(event.toolName) || event.toolName === "read";
}

function isAgentResultRead(event: OrchestratorPolicyEvent): boolean {
	if (event.toolName !== "read") return false;
	const input = (event.input ?? {}) as Record<string, unknown>;
	const readPath = typeof input.path === "string" ? input.path.trim() : "";
	return readPath.startsWith("agent://");
}


function isSkillRead(event: OrchestratorPolicyEvent): boolean {
	if (event.toolName !== "read") return false;

	const input = (event.input ?? {}) as Record<string, unknown>;
	const readPath = typeof input.path === "string" ? input.path.trim() : "";
	return requiredAutoSkillUrls.has(readPath) && !completedAutoSkillUrls.has(readPath);
}


function shouldRequireTodoRefreshAfterResult(event: {
	toolName: string;
	details?: unknown;
	isError?: boolean;
}): boolean {
	if (event.isError) return false;

	if (event.toolName === "task") {
		const details = event.details as { results?: unknown; async?: { state?: unknown } } | undefined;
		if (Array.isArray(details?.results) && details.results.length > 0) return true;
		return details?.async?.state === "completed" || details?.async?.state === "failed";
	}

	if (event.toolName === "await") {
		const details = event.details as { jobs?: Array<{ status?: unknown }> } | undefined;
		return Array.isArray(details?.jobs) && details.jobs.some(job => job.status !== "running");
	}

	if (event.toolName === "cancel_job") {
		return true;
	}

	return false;
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
		"Your first action to any actionable request MUST be reading any unread Must-Read Skills from the system prompt, immediate delegation, or creating the detailed todo list.",
		"Skip the preamble. Do not output a numbered execution list before acting.",
		"If Must-Read Skills remain unread, read them before calling todo_write.",
		"Then either spawn an exploration/research subagent immediately, or create a detailed phased todo list with todo_write.",
		"That todo list is the live source of truth for the session. Keep it deep, specific, and continuously updated.",
		"Do not keep a shallow todo list. Break every stage into concrete subtasks the user can follow.",
		"After every subagent result or new user instruction, update todo_write before any other orchestration action. If you still owe unread Must-Read Skills from the system prompt, read them before calling todo_write.",
		"Never park on indefinite await. Every await call MUST set timeout (typically 60-120 seconds).",
		"After each await timeout or completion, immediately check whether independent work can be dispatched now.",
		"Dispatch any ready independent work before issuing another await call.",
		"Only await when background work is already running and no independent dispatch is currently available.",
		"When you need to spawn explore or research agents: call checkpoint first, then explore, then await results, then call rewind with a comprehensive summary (scope, affected files, findings, delegation plan).",
		"After rewind: call todo_write to refresh tracking, then dispatch implementation agents.",
		"This checkpoint → explore → rewind → implement sequence is enforced. Skipping checkpoint before explore dispatch is a protocol violation.",
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
		"## Mandatory CodeRabbit Review",
		"",
		"You MUST spawn a `coderabbit` agent for review:",
		"- After completing each implementation batch (all implementation tasks in a todo phase are done)",
		"- Before claiming any work is complete or yielding to the user",
		"- After any remediation cycle completes",
		"",
		"CodeRabbit invocation:",
		"1. Spawn coderabbit with: base_branch (e.g. `origin/main`), list of changed files in the assignment",
		"2. If coderabbit returns `no_go` with blocking findings (critical/severe/major):",
		"   - Spawn implement agent to fix blocking findings",
		"   - Re-run coderabbit",
		"   - Repeat until go or resolved",
		"3. Only proceed after coderabbit passes",
		"",
		"Skipping CodeRabbit review is PROHIBITED.",
		"",
		"Parent tool contract:",
		"- task for discovery, implementation, review, and verification",
		"- ask only when user input is truly required",
		"- await only with timeout to poll running background work; dispatch any ready independent work before awaiting again",
		"- todo_write for detailed visible tracking from kickoff through closeout",
		"- read only for narrow decomposition, capped at 5 distinct files per user request",
		"- bash when enabled by the role config; otherwise only the git status fallback is permitted",
		"- cancel_job to abort a running background job when it is no longer needed or has gone wrong",
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

	const unreadMustReadSkills = [...requiredAutoSkillUrls].some(skillUrl => !completedAutoSkillUrls.has(skillUrl));
	if (event.toolName === "todo_write" && unreadMustReadSkills) {
		return {
			block: true,
			reason: "Orchestrator mode: read every Must-Read Skill before calling todo_write.",
		};
	}

	const allowTodoRefreshGateBypass =
		isTodoGateExceptionTool(event.toolName) ||
		isAgentResultRead(event) ||
		isSkillRead(event) ||
		event.toolName === "checkpoint" ||
		event.toolName === "rewind";

	if (context.todoRefreshRequired && !allowTodoRefreshGateBypass) {
		return {
			block: true,
			reason:
				"Orchestrator mode: update todo_write now to reflect the latest progress before doing anything else unless unread Must-Read Skills still need to be read.",
		};
	}

	if (context.todoBootstrapRequired && !isTodoBootstrapExceptionTool(event)) {
		return {
			block: true,
			reason:
				`Orchestrator mode: create a detailed phased todo list with todo_write before continuing unless unread Must-Read Skills still need to be read. ${context.todoDeficiencyReason ?? ""}`.trim(),
		};
	}

	// Gate: require checkpoint before dispatching explore/research agents
	if (
		event.toolName === "task" &&
		!context.todoBootstrapRequired &&
		!context.checkpointCreatedThisTurn &&
		hasExploreAgents(event.input)
	) {
		return {
			block: true,
			reason:
				"Orchestrator mode: call checkpoint with a context-gathering goal before dispatching exploration agents. " +
				"After exploration, call rewind with a comprehensive findings summary, then dispatch implementation agents.",
		};
	}

	// Gate: require rewind after exploration results before dispatching implementation agents
	if (
		event.toolName === "task" &&
		context.rewindRequiredBeforeImplementation &&
		hasImplementationAgents(event.input)
	) {
		return {
			block: true,
			reason:
				"Orchestrator mode: call rewind with a comprehensive exploration summary before dispatching implementation agents. " +
				"This compresses exploration context and keeps the orchestrator context window lean for the delegation phase.",
		};
	}

	const toolAccess = context.orchestratorToolAccess ?? orchestratorToolAccess;
	if (event.toolName !== "bash" && !isToolAllowedByOrchestratorAccess(event.toolName, toolAccess)) {
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

	// Per-turn and cross-turn state for context-gathering checkpoint protocol.
	// checkpointCreatedThisTurn: reset each turn; set when checkpoint() succeeds.
	// exploreTasksDispatchedThisTurn: reset each turn; set when explore/research task is sent.
	// rewindRequiredBeforeImplementation: NOT reset per-turn; persists until rewind() clears it.
	let checkpointCreatedThisTurn = false;
	let exploreTasksDispatchedThisTurn = false;
	let rewindRequiredBeforeImplementation = false;

	pi.on("before_provider_request", async (event, ctx) => {
		const unreadSkillUrls = syncAutoSkillTracking(ctx.sessionManager.getSessionId?.(), getSessionInitSystemPrompt(ctx));
		if (unreadSkillUrls.length === 0) return;

		const todoPhases = getLatestTodoPhasesFromEntriesOrUndefined(ctx.sessionManager.getEntries() as never);
		if (todoPhases !== undefined) return;

		const payload = event.payload;
		if (!payload || typeof payload !== "object") return;

		const request = { ...(payload as Record<string, unknown>) };
		if ("toolChoice" in request) {
			delete request.toolChoice;
		}
		if (typeof request.systemPrompt === "string") {
			request.systemPrompt = `${request.systemPrompt}${buildAutoSkillReminder(unreadSkillUrls)}`;
		}

		return request;
	});


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
			checkpointCreatedThisTurn = false;
			exploreTasksDispatchedThisTurn = false;
			// rewindRequiredBeforeImplementation is intentionally NOT reset here.
			// Exploration results from a prior turn still require a rewind call before
			// implementation agents can be dispatched in any subsequent turn.
			const agentDir = (ctx.settings as { getAgentDir?: () => string | undefined }).getAgentDir?.();
			const rolesPath =
				typeof agentDir === "string" && agentDir.trim().length > 0
					? path.join(agentDir.trim(), "roles.yml")
					: REPO_ROLES_PATH;
			orchestratorToolAccess = resolveOrchestratorToolAccess(rolesPath);

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
			orchestratorToolAccess,
			checkpointCreatedThisTurn,
			rewindRequiredBeforeImplementation,
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
			if (readPath.startsWith("skill://") && requiredAutoSkillUrls.has(readPath) && !completedAutoSkillUrls.has(readPath)) {
				pendingAutoSkillReadUrls.push(readPath);
			}
		}

		if (event.toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			const bashDecision = shouldBlockBashCommand(command, isToolAllowedByOrchestratorAccess("bash", orchestratorToolAccess));
			if (bashDecision) return bashDecision;
		}

		// Track explore/research task dispatch so we know to require rewind once results land.
		if (event.toolName === "task" && hasExploreAgents(event.input)) {
			exploreTasksDispatchedThisTurn = true;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!orchestratorModeThisTurn || !activeAgentIsParentTurn) return;

		if (event.toolName === "read") {
			const readPath = pendingAutoSkillReadUrls.shift();
			if (readPath && !event.isError && requiredAutoSkillUrls.has(readPath)) {
				completedAutoSkillUrls.add(readPath);
			}
			return;
		}

		if (event.isError) return;

		if (event.toolName === "checkpoint") {
			checkpointCreatedThisTurn = true;
			return;
		}

		if (event.toolName === "rewind") {
			// Rewind with a comprehensive findings summary acts as both a context-window
			// saver and a progress statement — clear both gates so the orchestrator can
			// proceed to dispatch implementation agents and update todos without being blocked.
			rewindRequiredBeforeImplementation = false;
			todoRefreshRequired = false;
			return;
		}

		if (event.toolName === "todo_write") {
			const todoPhases = Array.isArray((event.details as { phases?: unknown } | undefined)?.phases)
				? ((event.details as { phases: TodoPhase[] }).phases)
				: getLatestTodoPhasesFromEntries(ctx.sessionManager.getEntries() as never);
			todoDeficiencyReason = getTodoPlanDeficiency(todoPhases);
			todoBootstrapRequired = Boolean(todoDeficiencyReason);
			todoRefreshRequired = false;
			return;
		}

		if (shouldRequireTodoRefreshAfterResult(event)) {
			todoRefreshRequired = true;
			// If explore/research tasks were dispatched this turn, incoming results signal
			// exploration is complete — require rewind before implementation delegation.
			if (exploreTasksDispatchedThisTurn) {
				rewindRequiredBeforeImplementation = true;
			}
		}


	});
}

export const _testExports = {
	buildOrchestratorPrompt,
	getLatestTodoPhasesFromEntries,
	getTodoPlanDeficiency,
	isOrchestratorContext,
	resolveOrchestratorToolAccess,
	syncAutoSkillTracking,
	shouldBlockBashCommand,
	shouldBlockTool,
	shouldRequireTodoRefreshAfterResult,
	hasExploreAgents,
	hasImplementationAgents,
};

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as path from "node:path";
import {
	getLatestPlanModeActivePlanFilePath,
	isCanonicalPlannedSessionPlanFile,
	isPlanModeWritableMarkdownFile,
	PLAN_MODE_ACTIVE_PLAN_FILE_ENTRY_TYPE,
	resolveExplicitPlanModePlanFilePath,
} from "../../../packages/coding-agent/src/plan-mode/active-plan-file";
import { resolveToCwd } from "../../../packages/coding-agent/src/tools/path-utils";

const PLAN_MODE_WRITE_SCOPE_REASON =
	"Plan mode can modify only markdown files under `.omp/sessions/plans/` and its nested directories inside the active plans root, excluding plan-verifier artifacts.";

function isPlanModeActive(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; role?: string };
		if (entry.type === "model_change") {
			return entry.role === "plan";
		}
	}
	return false;
}

function getActivePlanFilePath(ctx: ExtensionContext): string | undefined {
	return getLatestPlanModeActivePlanFilePath(
		ctx.sessionManager.getEntries() as Array<Record<string, unknown>>,
		{
			cwd: ctx.cwd,
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		},
	);
}

function resolvePlanPath(filePath: string, ctx: ExtensionContext): string {
	if (filePath.startsWith("local://")) {
		return resolveLocalUrlToPath(filePath, {
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		});
	}
	return path.normalize(resolveToCwd(filePath, ctx.cwd));
}

function buildPlanPrompt(planRoot: string, activePlanFilePath?: string): string {
	const activePlanLine = activePlanFilePath
		? `- Active plan file for this session: \`${activePlanFilePath}\`\n`
		: "";

	return `

<plan-agent-mode>
## Role

You are operating as the Plan Agent.
Your sole deliverable is the plan document for this session.
Planning uses the workspace already attached to the session.
Reuse the workspace or worktree already visible from the current CWD.
Never create a new worktree during planning unless the user explicitly asks for that workflow.

## Persistent Plan Contract

Canonical persisted layout:
- Plan file: \`.omp/sessions/plans/<plan-slug>/plan.md\`
- Plan-verifier artifacts: \`.omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/\`
- Only the plan agent updates \`plan.md\`; plan-verifier agents write artifacts only.
${activePlanLine}## Constraints

- READ-ONLY access to the codebase. You MUST NOT modify project files.
- Use the write and edit tools only for markdown files under \`.omp/sessions/plans/\` and its nested directories.
- Treat the active plan file as the primary deliverable for this session, even when you create supporting markdown files nearby.
- If the user explicitly points you at an existing \`.omp/sessions/plans/.../plan.md\`, treat that file as the active plan file for this session.
- NEVER write plan-verifier artifacts yourself.
- Do not assume planning catalogs are reloaded during implementation; encode required execution context directly in the plan.

## Ask Tool Protocol

Every user-facing planning question MUST be asked with the ask tool.
NEVER place the actual question in plain assistant text when waiting for user input.
If a draft reply contains a question mark for something the user needs to answer, stop and convert that into an ask tool call instead.
MINIMUM 5 ASK TOOL QUESTIONS before writing the final plan.
Use the ask tool again for section-by-section validation instead of typing raw questions in assistant prose.

## Mandatory Flow

### Phase 0 — Parallel Research
Spawn 5-15 parallel research subagents via the Task tool. Use agent: \"research\" for official docs, best practices, ecosystem changes, security concerns, and BTCA-backed semantic search when available.

### Phase 1 — Parallel Codebase Exploration
Spawn parallel explore subagents for independent subsystems. Map files, patterns, tests, and integration points before synthesis.

### Phase 2 — Brainstorming With User
Ask one question at a time. Prefer multiple-choice questions. Cover scope, architecture tradeoffs, constraints, testing expectations, and sequencing preferences.

### Phase 3 — Write the Plan
Write the session plan to \`${planRoot}/<plan-slug>/plan.md\` after creating the plan directory if needed.
The plan must be self-contained for a fresh implementation session.

Required plan sections:
- Summary
- Codebase Context
- Research Findings
- Phased Implementation Plan
- Edge Cases
- Verification
- Critical Files

### Phase 4 — Plan Verification
After writing the plan, spawn one \`plan-verifier\` subagent per phase.
Each verifier writes artifacts under \`.omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/\`.
Planning is complete only when every latest verifier result passes.
</plan-agent-mode>
`;
}

export default function planModeExtension(pi: ExtensionAPI) {
	pi.logger.debug("plan-mode: extension loaded");

	let planModeThisTurn = false;

	pi.on("input", async (event, ctx) => {
		if (!isPlanModeActive(ctx)) return;
		const reboundPlanFilePath = resolveExplicitPlanModePlanFilePath(event.text, {
			cwd: ctx.cwd,
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		});
		if (!reboundPlanFilePath) return;

		const activePlanFilePath = getActivePlanFilePath(ctx);
		if (
			activePlanFilePath &&
			resolvePlanPath(activePlanFilePath, ctx) === resolvePlanPath(reboundPlanFilePath, ctx)
		) {
			return;
		}

		pi.appendEntry(PLAN_MODE_ACTIVE_PLAN_FILE_ENTRY_TYPE, {
			planFilePath: reboundPlanFilePath,
			reason: "user-input",
		});
		pi.logger.debug("plan-mode: rebound active plan file from user input", {
			reboundPlanFilePath,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		planModeThisTurn = isPlanModeActive(ctx);
		if (!planModeThisTurn) return;

		const planRoot = path.join(ctx.cwd, ".omp", "sessions", "plans");
		const activePlanFilePath = getActivePlanFilePath(ctx);

		pi.logger.debug("plan-mode: plan mode active — injecting system prompt", {
			activePlanFilePath,
		});

		return {
			systemPrompt: event.systemPrompt + buildPlanPrompt(planRoot, activePlanFilePath),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeThisTurn) return;

		if (event.toolName === "notebook") {
			return { block: true, reason: "Plan mode blocks notebook edits." };
		}

		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const rawPath = (event.input as Record<string, unknown>)?.path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			return {
				block: true,
				reason: PLAN_MODE_WRITE_SCOPE_REASON,
			};
		}

		const trimmedPath = rawPath.trim();
		const resolvedTargetPath = resolvePlanPath(trimmedPath, ctx);
		let activePlanFilePath = getActivePlanFilePath(ctx);
		if (!activePlanFilePath) {
			if (!isCanonicalPlannedSessionPlanFile(resolvedTargetPath)) {
				return {
					block: true,
					reason: PLAN_MODE_WRITE_SCOPE_REASON,
				};
			}
			pi.appendEntry(PLAN_MODE_ACTIVE_PLAN_FILE_ENTRY_TYPE, {
				planFilePath: trimmedPath,
				reason: "tool-path",
			});
			activePlanFilePath = getActivePlanFilePath(ctx) ?? trimmedPath;
			pi.logger.debug("plan-mode: rebound active plan file from tool path", {
				activePlanFilePath,
			});
		}

		const resolvedActivePlanPath = resolvePlanPath(activePlanFilePath, ctx);

		if (!isPlanModeWritableMarkdownFile(resolvedTargetPath, resolvedActivePlanPath)) {
			return {
				block: true,
				reason: `${PLAN_MODE_WRITE_SCOPE_REASON} Attempted path: ${rawPath}`,
			};
		}
	});
}

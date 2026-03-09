import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";

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
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; mode?: string; data?: { planFilePath?: unknown } };
		if (entry.type !== "mode_change" || entry.mode !== "plan") continue;
		const planFilePath = entry.data?.planFilePath;
		if (typeof planFilePath === "string" && planFilePath.trim().length > 0) {
			return planFilePath.trim();
		}
	}
	return undefined;
}

function resolvePlanPath(filePath: string, cwd: string): string {
	if (filePath.startsWith("local://")) return filePath;
	return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
}

function buildPlanPrompt(planRoot: string, activePlanFilePath?: string): string {
	const activePlanLine = activePlanFilePath
		? `- Active plan file for this session: \`${activePlanFilePath}\`\n`		: "";

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
${activePlanLine}
## Constraints

- READ-ONLY access to the codebase. You MUST NOT modify project files.
- Use the write and edit tools ONLY on the active plan file for this session.
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
		const activePlanFilePath = getActivePlanFilePath(ctx);
		if (typeof rawPath !== "string" || rawPath.trim().length === 0 || !activePlanFilePath) {
			return {
				block: true,
				reason: "Plan mode can modify only the active plan file inside the active plan workspace.",
			};
		}

		const resolvedTargetPath = resolvePlanPath(rawPath.trim(), ctx.cwd);
		const resolvedActivePlanPath = resolvePlanPath(activePlanFilePath, ctx.cwd);

		if (resolvedTargetPath !== resolvedActivePlanPath) {
			return {
				block: true,
				reason: `Plan mode can modify only the active plan file inside the active plan workspace. Attempted path: ${rawPath}`,
			};
		}
	});
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WORKTREE_MUTATION_RE = /\bgit\s+worktree\s+(?:add|remove|move|prune|repair|lock|unlock)\b/i;
const EXPLICIT_WORKTREE_REQUEST_PATTERNS = [
	/\b(?:create|use|start|open|make|setup|set up|spin up|spawn|launch|prepare)\b[\s\S]{0,40}\b(?:git\s+)?worktree\b/i,
	/(?:^|\s)\/(?:implement|wt|worktree|delete-worktree|cleanup)\b/i,
];
const WORKTREE_POLICY_PROMPT = `
<critical>
Workspace rule:
- Reuse the current workspace unless the user explicitly requests a git worktree workflow.
- If this session did not start inside a git worktree, you MUST NOT create or switch to a new git worktree on your own.
- Do NOT spawn \`worktree-setup\`, do NOT request subagent isolation with \`isolated: true\`, and do NOT run mutating \`git worktree\` commands unless the user explicitly asked for that workflow.
</critical>
`;

type CheckoutMode = "none" | "repo" | "worktree";

type WorktreePolicyEvent = {
	toolName: string;
	input?: unknown;
};

type WorktreePolicyContext = {
	currentAgentThisTurn: string;
	explicitWorktreeRequest: boolean;
	sessionInsideWorktree: boolean;
	worktreeAllowedThisTurn: boolean;
};

type WorktreePolicyBlockDecision = { block: true; reason: string } | undefined;

export function detectAgentName(systemPrompt: string): string {
	const match = systemPrompt.match(/^name:\s*(\S+)/m);
	return match ? match[1] : "default";
}

export function detectExplicitWorktreeRequest(promptText: string): boolean {
	const text = promptText.trim();
	if (!text) return false;
	return EXPLICIT_WORKTREE_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

export async function detectCheckoutMode(startCwd: string): Promise<CheckoutMode> {
	let current = path.resolve(startCwd);
	const maxDepth = 50;
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const gitPath = path.join(current, ".git");
		try {
			const stat = await fs.stat(gitPath);
			if (stat.isFile()) return "worktree";
			if (stat.isDirectory()) return "repo";
		} catch {
			// Keep walking up.
		}
		const parent = path.dirname(current);
		if (parent === current) return "none";
		current = parent;
	}
	return "none";
}

export function createWorktreePolicyContext(params: {
	currentAgentThisTurn: string;
	explicitWorktreeRequest: boolean;
	sessionInsideWorktree: boolean;
}): WorktreePolicyContext {
	const worktreeAllowedThisTurn =
		params.currentAgentThisTurn === "worktree-setup" ||
		params.explicitWorktreeRequest ||
		params.sessionInsideWorktree;
	return {
		currentAgentThisTurn: params.currentAgentThisTurn,
		explicitWorktreeRequest: params.explicitWorktreeRequest,
		sessionInsideWorktree: params.sessionInsideWorktree,
		worktreeAllowedThisTurn,
	};
}

export function shouldBlockTool(
	event: WorktreePolicyEvent,
	context: WorktreePolicyContext,
): WorktreePolicyBlockDecision {
	if (context.worktreeAllowedThisTurn) return undefined;
	const input = (event.input ?? {}) as Record<string, unknown>;

	if (event.toolName === "task") {
		const targetAgent = typeof input.agent === "string" ? input.agent : undefined;
		if (targetAgent === "worktree-setup") {
			return {
				block: true,
				reason:
					"Worktree policy: the user did not explicitly request a worktree. Stay in the current workspace instead of spawning `worktree-setup`.",
			};
		}
		if (input.isolated === true) {
			return {
				block: true,
				reason:
					"Worktree policy: the user did not explicitly request isolated task workspaces. Reuse the current workspace instead of setting `isolated: true`.",
			};
		}
	}

	if (event.toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		if (WORKTREE_MUTATION_RE.test(command)) {
			return {
				block: true,
				reason:
					`Worktree policy: the user did not explicitly request a worktree. Stay in the current workspace instead of running \`${command}\`.`,
			};
		}
	}

	return undefined;
}

export default function worktreePolicyExtension(pi: ExtensionAPI) {
	pi.logger.debug("worktree-policy: extension loaded");

	let currentContext = createWorktreePolicyContext({
		currentAgentThisTurn: "default",
		explicitWorktreeRequest: false,
		sessionInsideWorktree: false,
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const currentAgentThisTurn = detectAgentName(event.systemPrompt);
			const explicitWorktreeRequest = detectExplicitWorktreeRequest(event.prompt ?? "");
			const sessionInsideWorktree = (await detectCheckoutMode(ctx.cwd)) === "worktree";
			currentContext = createWorktreePolicyContext({
				currentAgentThisTurn,
				explicitWorktreeRequest,
				sessionInsideWorktree,
			});

			if (currentContext.worktreeAllowedThisTurn) return;

			pi.logger.debug("worktree-policy: injecting current-workspace guard", {
				agent: currentAgentThisTurn,
				explicitWorktreeRequest,
				sessionInsideWorktree,
			});
			return {
				systemPrompt: event.systemPrompt + WORKTREE_POLICY_PROMPT,
			};
		} catch (err) {
			currentContext = createWorktreePolicyContext({
				currentAgentThisTurn: "default",
				explicitWorktreeRequest: false,
				sessionInsideWorktree: false,
			});
			pi.logger.warn("worktree-policy: failed to detect worktree context; fail-open policy allows tool call", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("tool_call", async (event) => {
		const decision = shouldBlockTool(event, currentContext);
		if (decision) return decision;
	});
}

export const _testExports = {
	createWorktreePolicyContext,
	detectAgentName,
	detectCheckoutMode,
	detectExplicitWorktreeRequest,
	shouldBlockTool,
};

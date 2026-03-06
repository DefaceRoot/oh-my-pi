import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BLOCKED_TOOLS = new Set(["edit", "write", "notebook", "todo_write", "ssh", "bash"]);
const ASK_SUBAGENT_PREFIX = "ask-";
const ALLOWED_ASK_PARENT_TASK_AGENTS = new Set(["ask-explore", "ask-research"]);
const ALLOWED_ASK_PARENT_TOOLS = new Set([
  "read",
  "find",
  "grep",
  "fetch",
  "web_search",
  "mcp_augment_codebase_retrieval",
  "lsp",
  "submit_result",
  "task",
]);
const ASK_SUBAGENT_TOOL_ALLOW: Record<string, Set<string>> = {
  "ask-explore": new Set(["read", "find", "grep", "lsp", "submit_result"]),
  "ask-research": new Set(["fetch", "web_search", "mcp_augment_codebase_retrieval", "read", "submit_result"]),
};

type AskModePolicyEvent = {
	toolName: string;
	input?: unknown;
};

type AskModePolicyContext = {
	askModeThisTurn: boolean;
	askRoleThisTurn: boolean;
	askSubagentThisTurn: boolean;
	currentAgentThisTurn: string;
};

type AskModeBlockDecision = { block: true; reason: string } | undefined;

function isAskContext(params: { role: string | undefined; agent: string }): AskModePolicyContext {
	const askRoleThisTurn = params.role === "ask";
	const askSubagentThisTurn = params.agent.startsWith(ASK_SUBAGENT_PREFIX);
	return {
		askModeThisTurn: askRoleThisTurn || askSubagentThisTurn,
		askRoleThisTurn,
		askSubagentThisTurn,
		currentAgentThisTurn: params.agent,
	};
}

function shouldBlockTool(event: AskModePolicyEvent, context: AskModePolicyContext): AskModeBlockDecision {
	if (!context.askModeThisTurn) return undefined;

	if (BLOCKED_TOOLS.has(event.toolName)) {
		return {
			block: true,
			reason: `Ask mode is read-only. Tool '${event.toolName}' is disabled.`,
		};
	}

	if (event.toolName === "lsp") {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const action = input.action;
		const apply = input.apply;
		if (action === "rename" || (action === "code_actions" && apply === true)) {
			return {
				block: true,
				reason: "Ask mode blocks mutating LSP actions (rename and code_actions with apply=true).",
			};
		}
	}

	if (event.toolName === "task") {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const targetAgent = input.agent;

		if (context.askSubagentThisTurn) {
			return {
				block: true,
				reason: "ask-* subagents cannot spawn additional subagents.",
			};
		}

		if (
			context.askRoleThisTurn &&
			(typeof targetAgent !== "string" || !ALLOWED_ASK_PARENT_TASK_AGENTS.has(targetAgent))
		) {
			return {
				block: true,
				reason: "Ask mode may spawn only ask-explore or ask-research subagents.",
			};
		}
	}

	if (
		context.askRoleThisTurn &&
		!context.askSubagentThisTurn &&
		!ALLOWED_ASK_PARENT_TOOLS.has(event.toolName)
	) {
		return {
			block: true,
			reason: `Ask mode allows only read-only tools. Tool '${event.toolName}' is not allowed.`,
		};
	}

	if (context.askSubagentThisTurn) {
		const allowed = ASK_SUBAGENT_TOOL_ALLOW[context.currentAgentThisTurn];
		if (!allowed || !allowed.has(event.toolName)) {
			return {
				block: true,
				reason: `Agent '${context.currentAgentThisTurn}' is restricted from using tool '${event.toolName}'.`,
			};
		}
	}

	return undefined;
}

function detectAgentName(systemPrompt: string): string {
	const match = systemPrompt.match(/^name:\s*(\S+)/m);
	return match ? match[1] : "default";
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

export default function askModeExtension(pi: ExtensionAPI) {
	pi.logger.debug("ask-mode: extension loaded");

	let askModeThisTurn = false;
	let askRoleThisTurn = false;
	let askSubagentThisTurn = false;
	let currentAgentThisTurn = "default";

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const role = detectCurrentRole(ctx);
			const agent = detectAgentName(event.systemPrompt);
			currentAgentThisTurn = agent;

			const askContext = isAskContext({ role, agent });
			askRoleThisTurn = askContext.askRoleThisTurn;
			askSubagentThisTurn = askContext.askSubagentThisTurn;
			askModeThisTurn = askContext.askModeThisTurn;

			if (askModeThisTurn) {
				pi.logger.debug(
					`ask-mode: enforcing read-only policy for role=${role ?? "unknown"}, agent=${agent}`,
				);
			}
		} catch (err) {
			askModeThisTurn = false;
			askRoleThisTurn = false;
			askSubagentThisTurn = false;
			currentAgentThisTurn = "default";
			pi.logger.warn("ask-mode: failed to detect ask role/agent; fail-open policy allows tool call", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("tool_call", async (event) => {
		const decision = shouldBlockTool(event, {
			askModeThisTurn,
			askRoleThisTurn,
			askSubagentThisTurn,
			currentAgentThisTurn,
		});
		if (decision) return decision;
	});
}

export const _testExports = { shouldBlockTool, isAskContext };
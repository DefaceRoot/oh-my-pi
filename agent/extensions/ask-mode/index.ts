import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BLOCKED_TOOLS = new Set(["edit", "write", "notebook", "todo_write", "ssh", "bash"]);
const ALLOWED_ASK_PARENT_TASK_AGENTS = new Set(["explore", "research"]);
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
  "inspect_image",
  "ask",
]);

type AskModePolicyEvent = {
	toolName: string;
	input?: unknown;
};

type AskModePolicyContext = {
	askRoleThisTurn: boolean;
};

type AskModeBlockDecision = { block: true; reason: string } | undefined;

function isAskContext(params: { role: string | undefined }): AskModePolicyContext {
	return {
		askRoleThisTurn: params.role === "ask",
	};
}

function shouldBlockTool(event: AskModePolicyEvent, context: AskModePolicyContext): AskModeBlockDecision {
	if (!context.askRoleThisTurn) return undefined;

	if (BLOCKED_TOOLS.has(event.toolName)) {
		return {
			block: true,
			reason: "Ask mode is read-only. Tool '" + event.toolName + "' is disabled.",
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

		if (typeof targetAgent !== "string" || !ALLOWED_ASK_PARENT_TASK_AGENTS.has(targetAgent)) {
			return {
				block: true,
				reason: "Ask mode may spawn only explore or research subagents.",
			};
		}
	}

	if (!ALLOWED_ASK_PARENT_TOOLS.has(event.toolName)) {
		return {
			block: true,
			reason: "Ask mode allows only read-only tools. Tool '" + event.toolName + "' is not allowed.",
		};
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

	let askRoleThisTurn = false;

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const role = detectCurrentRole(ctx);
			const agent = detectAgentName(event.systemPrompt);

			const askContext = isAskContext({ role });
			askRoleThisTurn = askContext.askRoleThisTurn;

			if (askRoleThisTurn) {
				pi.logger.debug(
					"ask-mode: enforcing read-only policy for role=" + (role ?? "unknown") + ", agent=" + agent,
				);
			}
		} catch (err) {
			askRoleThisTurn = false;
			pi.logger.warn("ask-mode: failed to detect ask role; fail-open policy allows tool call", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("tool_call", async (event) => {
		const decision = shouldBlockTool(event, { askRoleThisTurn });
		if (decision) return decision;
	});
}

export const _testExports = { shouldBlockTool, isAskContext };

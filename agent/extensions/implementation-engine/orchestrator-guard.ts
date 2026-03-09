export type ParentRuntimeRole = "default" | "orchestrator";

export const MUTATING_TOOL_NAMES = new Set(["edit", "write", "notebook"]);
export const MCP_TOOL_PREFIX = "mcp_";

const ORCHESTRATOR_PARENT_ALLOWED_TOOL_NAMES = new Set(["task", "ask", "await", "todo_write", "read", "bash"]);
const ORCHESTRATOR_PARENT_ALLOWED_MCP_TOOL_NAMES = new Set(["mcp_augment_codebase_retrieval"]);

export function resolveParentRuntimeRole(role: string | null | undefined): ParentRuntimeRole {
	return typeof role === "string" && role.trim().toLowerCase() === "orchestrator"
		? "orchestrator"
		: "default";
}

export function shouldEnforceOrchestratorGuards(params: {
	activeAgentIsParentTurn: boolean;
	parentRuntimeRole: ParentRuntimeRole;
}): boolean {
	return params.activeAgentIsParentTurn && params.parentRuntimeRole === "orchestrator";
}

export function isOrchestratorParentToolAllowed(toolName: string): boolean {
	if (toolName.startsWith(MCP_TOOL_PREFIX)) {
		return ORCHESTRATOR_PARENT_ALLOWED_MCP_TOOL_NAMES.has(toolName);
	}
	return ORCHESTRATOR_PARENT_ALLOWED_TOOL_NAMES.has(toolName);
}

export const PLAN_MODE_MAIN_AGENT_REQUIRED_TOOLS = ["write", "edit", "exit_plan_mode"] as const;

export function mergePlanModeMainAgentTools(
	activeTools: string[],
	isToolAvailable: (toolName: string) => boolean,
): string[] {
	const merged = [...activeTools];
	for (const toolName of PLAN_MODE_MAIN_AGENT_REQUIRED_TOOLS) {
		if (!isToolAvailable(toolName) || merged.includes(toolName)) {
			continue;
		}
		merged.push(toolName);
	}
	return merged;
}

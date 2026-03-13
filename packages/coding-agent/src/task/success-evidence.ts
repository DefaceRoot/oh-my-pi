import type { AgentDefinition } from "./types";

function normalizeToolName(value: string): string {
	return value.trim();
}

function toNormalizedToolList(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) return [];
	const unique = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const normalized = normalizeToolName(entry);
		if (!normalized || normalized === "submit_result") continue;
		unique.add(normalized);
	}
	return [...unique];
}

export function validateSuccessToolRequirements(
	agent: Pick<AgentDefinition, "name" | "successRequiresTools">,
	observedToolNames: Iterable<string>,
): string | null {
	const requiredTools = toNormalizedToolList(agent.successRequiresTools);
	if (requiredTools.length === 0) return null;

	const observed = new Set<string>();
	for (const toolName of observedToolNames) {
		const normalized = normalizeToolName(toolName);
		if (!normalized || normalized === "submit_result") continue;
		observed.add(normalized);
	}

	for (const requiredTool of requiredTools) {
		if (observed.has(requiredTool)) {
			return null;
		}
	}

	const observedSummary = observed.size > 0 ? [...observed].sort().join(", ") : "none";
	return `Subagent \"${agent.name}\" reported success without required verification evidence; it must run at least one of: ${requiredTools.join(", ")}. Observed tools: ${observedSummary}.`;
}

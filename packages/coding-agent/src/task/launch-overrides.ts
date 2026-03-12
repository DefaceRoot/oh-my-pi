import type { Settings } from "../config/settings";
import { extractExplicitThinkingSelector, isDefaultModelAlias } from "../config/model-resolver";
import type { AgentDefinition } from "./types";
import { resolveSubagentRole } from "./model-role";

interface SubagentLaunchSession {
	settings: Settings;
	getActiveModelString?: () => string | undefined;
	getModelString?: () => string | undefined;
}

function normalizeModelOverride(value: string | string[] | undefined): string | string[] | undefined {
	if (Array.isArray(value)) {
		const normalized = value.map(pattern => pattern.trim()).filter(pattern => pattern.length > 0);
		return normalized.length > 0 ? normalized : undefined;
	}
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : undefined;
	}
	return undefined;
}

function resolveRoleModelOverride(session: SubagentLaunchSession, agentName: string): string | string[] | undefined {
	const subagentRole = resolveSubagentRole(agentName);
	const roleModelLookupOrder =
		subagentRole === "implement" ? (["implement", "default"] as const) : ([subagentRole, "implement", "default"] as const);
	return roleModelLookupOrder
		.map(role => normalizeModelOverride(session.settings.getModelRole(role)))
		.find((value): value is string | string[] => value !== undefined);
}

export function resolveSubagentLaunchOverrides(options: {
	session: SubagentLaunchSession;
	agentName: string;
	agentModel: string[] | undefined;
	agentThinkingLevel: AgentDefinition["thinkingLevel"];
	settingsModelOverride: string | string[] | undefined;
}): { modelOverride: string | string[] | undefined; thinkingLevelOverride: AgentDefinition["thinkingLevel"] } {
	const { session, agentName, agentModel, agentThinkingLevel, settingsModelOverride } = options;
	const roleModelOverride = resolveRoleModelOverride(session, agentName);
	const effectiveAgentModel = normalizeModelOverride(isDefaultModelAlias(agentModel) ? undefined : agentModel);
	const modelOverride =
		settingsModelOverride ??
		roleModelOverride ??
		effectiveAgentModel ??
		normalizeModelOverride(session.getActiveModelString?.() ?? session.getModelString?.());
	const configuredModelOverride = settingsModelOverride ?? roleModelOverride;
	const configuredThinkingSelector =
		typeof configuredModelOverride === "string"
			? extractExplicitThinkingSelector(configuredModelOverride, session.settings)
			: undefined;
	return {
		modelOverride,
		thinkingLevelOverride: configuredModelOverride ? configuredThinkingSelector : agentThinkingLevel,
	};
}

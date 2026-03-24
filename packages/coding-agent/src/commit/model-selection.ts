import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { MODEL_ROLE_IDS } from "../config/model-registry";
import { parseModelPattern, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";

export interface ResolvedCommitModel {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
}

function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	for (const role of roles) {
		const resolved = resolveModelRoleValue(settings.getModelRole(role), availableModels, {
			settings,
			matchPreferences,
		});
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}
	return undefined;
}

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: {
		getAvailable: () => Model<Api>[];
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences })
		: resolveRoleSelection(["commit", ...MODEL_ROLE_IDS.filter(role => role !== "commit")], settings, available);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return { model, apiKey, thinkingLevel: resolved?.thinkingLevel };
}

export async function resolveCommitRoleModel(
	settings: Settings,
	modelRegistry: {
		getAvailable: () => Model<Api>[];
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
	fallbackModel: Model<Api>,
	fallbackApiKey: string,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedCommit = resolveRoleSelection(["commit"], settings, available);
	if (resolvedCommit?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedCommit.model);
		if (apiKey) return { model: resolvedCommit.model, apiKey, thinkingLevel: resolvedCommit.thinkingLevel };
	}

	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) return { model: candidate, apiKey };
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}

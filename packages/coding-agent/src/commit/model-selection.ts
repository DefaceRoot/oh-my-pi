import type { Api, Model } from "@oh-my-pi/pi-ai";
import { MODEL_ROLE_IDS } from "../config/model-registry";
import { expandRoleAlias, resolveModelFromSettings, resolveModelFromString } from "../config/model-resolver";
import type { Settings } from "../config/settings";

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: {
		getAvailable: () => Model<Api>[];
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<{ model: Model<Api>; apiKey: string }> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const roleOrder = ["commit", ...MODEL_ROLE_IDS.filter(role => role !== "commit")] as const;
	const model = override
		? resolveModelFromString(expandRoleAlias(override, settings), available, matchPreferences)
		: resolveModelFromSettings({
				settings,
				availableModels: available,
				matchPreferences,
				roleOrder,
			});
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return { model, apiKey };
}

export async function resolveCommitRoleModel(
	settings: Settings,
	modelRegistry: {
		getAvailable: () => Model<Api>[];
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
	fallbackModel: Model<Api>,
	fallbackApiKey: string,
): Promise<{ model: Model<Api>; apiKey: string }> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const commitRole = settings.getModelRole("commit");
	const commitRoleModel = commitRole
		? resolveModelFromString(expandRoleAlias(commitRole, settings), available, matchPreferences)
		: undefined;
	if (commitRoleModel) {
		const apiKey = await modelRegistry.getApiKey(commitRoleModel);
		if (apiKey) return { model: commitRoleModel, apiKey };
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}

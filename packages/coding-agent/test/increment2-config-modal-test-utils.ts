import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { PresetsConfig } from "../src/config/presets-config";
import type { RolesConfig } from "../src/config/roles-config";
import { AgentConfigModal } from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";

let themeInitialized = false;

export function initConfigModalTheme(): void {
	if (themeInitialized) return;
	initTheme();
	themeInitialized = true;
}

function requireBundledModel(provider: Parameters<typeof getBundledModel>[0], modelId: string): Model {
	const model = getBundledModel(provider, modelId);
	if (!model) {
		throw new Error(`Expected bundled model ${provider}/${modelId}`);
	}
	return model;
}

function createStubPresetsConfig(): PresetsConfig {
	return {
		getActivePreset: () => null,
		isModified: () => false,
		on: () => () => {},
		captureCurrentConfig: () => ({ modelRoles: {} as never, roles: {} as never, subagents: {} as never }),
		getPreset: () => undefined,
		savePreset: () => {},
		listPresets: () => [],
		applyPreset: async () => {},
		deletePreset: () => {},
		renamePreset: () => {},
	} as never;
}

export function getConfigModalTestModels(): Model[] {
	return [
		requireBundledModel("anthropic", "claude-haiku-4-5"),
		requireBundledModel("anthropic", "claude-sonnet-4-5"),
		requireBundledModel("openai", "gpt-4o"),
	];
}

export function getModelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export function createConfigModal(
	rolesConfig: RolesConfig,
	options: {
		subagentDefaultTools?: Partial<Record<string, string[]>>;
		modelRoles?: Partial<Record<string, string>>;
		values?: Record<string, unknown>;
		knownTools?: string[];
		presetsConfig?: PresetsConfig;
	} = {},
): AgentConfigModal {
	const subagentDefaultTools = options.subagentDefaultTools ?? {};
	const knownTools = [
		...new Set([
			"ast_grep",
			"read",
			"write",
			...Object.values(subagentDefaultTools).flat(),
			...(options.knownTools ?? []),
		]),
	].filter((tool): tool is string => tool !== undefined);
	const models = getConfigModalTestModels();

	return new AgentConfigModal({
		settings: {
			getModelRole: (role: string) => options.modelRoles?.[role],
			get: (key: string) => options.values?.[key],
		} as never,
		rolesConfig,
		presetsConfig: options.presetsConfig ?? createStubPresetsConfig(),
		knownTools,
		subagentDefaultTools,
		knownMcpServers: [],
		discoveredSkills: [],
		modelRegistry: {
			getAll: () => models,
			getAvailable: () => models,
		} as never,
		onDismiss: () => {},
		onRequestRender: () => {},
	} as never);
}

export function renderModalText(modal: AgentConfigModal, width = 140): string {
	return Bun.stripANSI(modal.render(width).join("\n"));
}

export function focusModelTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
}

export function openToolsTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 5; i++) {
		if (renderModalText(modal).includes("Tools:")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Tools tab not found in modal:\n${renderModalText(modal)}`);
}

export function openAdvancedTab(modal: AgentConfigModal): void {
	modal.handleInput("\t");
	for (let i = 0; i < 7; i++) {
		if (renderModalText(modal).includes("Max Task Recursion")) {
			return;
		}
		modal.handleInput("\x1b[C");
	}
	throw new Error(`Advanced tab not found in modal:\n${renderModalText(modal)}`);
}

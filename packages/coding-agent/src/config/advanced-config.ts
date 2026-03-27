import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseThinkingLevel } from "../thinking";
import type { AdvancedConfig } from "./roles-config";
import { Settings } from "./settings";
import { SETTINGS_SCHEMA, type SettingPath } from "./settings-schema";

type CompactionStrategy = "context-full" | "handoff" | "off";

const VALID_COMPACTION_STRATEGIES = new Set<CompactionStrategy>(["context-full", "handoff", "off"]);

export function resolveAdvancedThinkingLevel(config?: AdvancedConfig | null): ThinkingLevel | undefined {
	return parseThinkingLevel(config?.thinkingLevel ?? undefined);
}

export function applyAdvancedConfigToSettings(settings: Settings, config?: AdvancedConfig | null): void {
	if (!config) return;

	if (typeof config.maxRecursionDepth === "number" && Number.isFinite(config.maxRecursionDepth)) {
		settings.override("task.maxRecursionDepth", config.maxRecursionDepth);
	}

	if (
		typeof config.compactionStrategy === "string" &&
		VALID_COMPACTION_STRATEGIES.has(config.compactionStrategy as CompactionStrategy)
	) {
		settings.override("compaction.strategy", config.compactionStrategy as CompactionStrategy);
	}

	if (typeof config.temperature === "number" && Number.isFinite(config.temperature)) {
		settings.override("temperature", config.temperature);
	}
}

export function cloneSettingsSnapshot(baseSettings: Settings): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const value = baseSettings.get(key);
		snapshot[key] = key === "modelRoles" && (value === null || value === undefined) ? {} : value;
	}

	const cloned = Settings.isolated(snapshot);
	const originalGet = cloned.get.bind(cloned);
	const originalSet = cloned.set.bind(cloned);
	const originalSetModelRole = cloned.setModelRole.bind(cloned);
	const originalPersistModelRoles = cloned.persistModelRoles.bind(cloned);
	const originalOverride = cloned.override.bind(cloned);
	const originalOverrideModelRoles = cloned.overrideModelRoles.bind(cloned);
	const originalClearOverride = cloned.clearOverride.bind(cloned);
	const originalSetDisabledProviders = cloned.setDisabledProviders.bind(cloned);
	cloned.getCwd = () => baseSettings.getCwd();
	cloned.getAgentDir = () => baseSettings.getAgentDir();
	cloned.getStorage = () => baseSettings.getStorage();
	cloned.get = ((path: SettingPath) => {
		if (path === "modelRoles") return baseSettings.get(path);
		return originalGet(path);
	}) as typeof cloned.get;
	cloned.set = (path, value) => {
		cloned.clearOverride(path);
		baseSettings.set(path, value);
		originalSet(path, value);
	};
	cloned.setModelRole = (role, modelId) => {
		baseSettings.setModelRole(role, modelId);
		originalSetModelRole(role, modelId);
	};
	cloned.persistModelRoles = roles => {
		baseSettings.persistModelRoles(roles);
		originalPersistModelRoles(roles);
	};
	cloned.persistModelRolesAtomically = (async roles => {
		await baseSettings.persistModelRolesAtomically(roles);
	}) as typeof cloned.persistModelRolesAtomically;
	cloned.override = ((path, value) => {
		if (path === "modelRoles") {
			baseSettings.override(path, value);
		}
		originalOverride(path, value);
	}) as typeof cloned.override;
	cloned.overrideModelRoles = roles => {
		baseSettings.overrideModelRoles(roles);
		originalOverrideModelRoles(roles);
	};
	cloned.clearOverride = ((path: SettingPath) => {
		if (path === "modelRoles") {
			baseSettings.clearOverride(path);
		}
		originalClearOverride(path);
	}) as typeof cloned.clearOverride;
	cloned.getResolvedModelRoles = (modelRegistry =>
		baseSettings.getResolvedModelRoles(modelRegistry)) as typeof cloned.getResolvedModelRoles;
	cloned.getSessionResolvedModelRoles = (modelRegistry =>
		baseSettings.getSessionResolvedModelRoles(modelRegistry)) as typeof cloned.getSessionResolvedModelRoles;
	cloned.setDisabledProviders = ids => {
		baseSettings.setDisabledProviders(ids);
		originalSetDisabledProviders(ids);
	};
	cloned.flush = () => baseSettings.flush();
	return cloned;
}

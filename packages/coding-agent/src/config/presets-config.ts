import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { YAML } from "bun";
import { ConfigFile } from "../config";
import { EventBus } from "../utils/event-bus";
import { MODEL_ROLE_IDS, type ModelRegistry } from "./model-registry";
import { RoleConfigSchemaV2, type RolesConfig, SubagentConfigSchemaV2 } from "./roles-config";
import type { Settings } from "./settings";

const PresetMetadataSchema = Type.Object({
	description: Type.Optional(Type.String()),
	createdAt: Type.String({ minLength: 1 }),
	updatedAt: Type.String({ minLength: 1 }),
});

export type PresetMetadata = Static<typeof PresetMetadataSchema>;

const PresetModelRolesSchema = Type.Object(
	Object.fromEntries(MODEL_ROLE_IDS.map(role => [role, Type.String({ minLength: 1 })])) as Record<
		string,
		ReturnType<typeof Type.String>
	>,
	{ additionalProperties: false },
);

export const PresetSnapshotSchema = Type.Object({
	description: Type.Optional(Type.String()),
	createdAt: Type.String({ minLength: 1 }),
	updatedAt: Type.String({ minLength: 1 }),
	modelRoles: PresetModelRolesSchema,
	roles: Type.Record(Type.String({ minLength: 1 }), RoleConfigSchemaV2),
	subagents: Type.Record(Type.String({ minLength: 1 }), SubagentConfigSchemaV2),
});

export type PresetSnapshot = Static<typeof PresetSnapshotSchema>;

type CapturedPresetSnapshot = Omit<PresetSnapshot, keyof PresetMetadata>;

export const PresetsConfigSchema = Type.Object({
	activePreset: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	defaultPreset: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
	presets: Type.Record(Type.String({ minLength: 1 }), PresetSnapshotSchema),
});

export type PresetsConfigData = Static<typeof PresetsConfigSchema>;

export interface PresetAppliedEvent {
	name: string;
	snapshot: PresetSnapshot;
	sourceInstanceId: number;
}

export interface PresetsChangedEvent {
	activePreset: string | null;
}

export const DEFAULT_PRESETS_CONFIG: PresetsConfigData = {
	activePreset: null,
	defaultPreset: null,
	presets: {},
};

type PresetsConfigEventMap = {
	preset_applied: PresetAppliedEvent;
	presets_changed: PresetsChangedEvent;
};

export const PresetsConfigFile = new ConfigFile<PresetsConfigData>("presets", PresetsConfigSchema);

function clonePresetSnapshot(snapshot: PresetSnapshot): PresetSnapshot {
	return structuredClone(snapshot);
}

function clonePresetsConfig(config: PresetsConfigData): PresetsConfigData {
	return structuredClone(config);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(entry => stableValue(entry));
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)]),
		);
	}
	return value;
}

function stableSerialize(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

const presetConfigEvents = new Map<string, EventBus>();
const presetConfigVersions = new Map<string, number>();
let nextPresetConfigInstanceId = 1;

function getPresetConfigEvents(configPath: string): EventBus {
	const resolvedPath = path.resolve(configPath);
	const existing = presetConfigEvents.get(resolvedPath);
	if (existing) {
		return existing;
	}
	const created = new EventBus();
	presetConfigEvents.set(resolvedPath, created);
	return created;
}

export class PresetsConfig {
	#configFile: ConfigFile<PresetsConfigData>;
	#configPathKey: string;
	#resolved?: PresetsConfigData;
	#configVersion: number;
	#events: EventBus;
	#instanceId: number;
	#settings: Settings;
	#rolesConfig: RolesConfig;
	#modelRegistry: ModelRegistry;

	constructor(
		configPath: string | undefined,
		settings: Settings,
		rolesConfig: RolesConfig,
		modelRegistry: ModelRegistry,
	) {
		this.#configFile = PresetsConfigFile.relocate(configPath);
		this.#configPathKey = path.resolve(this.#configFile.path());
		this.#configVersion = presetConfigVersions.get(this.#configPathKey) ?? 0;
		this.#events = getPresetConfigEvents(this.#configPathKey);
		this.#instanceId = nextPresetConfigInstanceId++;
		this.#settings = settings;
		this.#rolesConfig = rolesConfig;
		this.#modelRegistry = modelRegistry;
	}

	invalidateCache(): void {
		this.#configFile.invalidate?.();
		this.#resolved = undefined;
	}

	#getConfig(): PresetsConfigData {
		const latestVersion = presetConfigVersions.get(this.#configPathKey) ?? 0;
		if (this.#resolved && this.#configVersion === latestVersion) {
			return this.#resolved;
		}
		this.#configFile.invalidate?.();
		const loaded = this.#configFile.load();
		this.#resolved = clonePresetsConfig(loaded ?? DEFAULT_PRESETS_CONFIG);
		this.#configVersion = latestVersion;
		return this.#resolved;
	}

	#persistConfig(config: PresetsConfigData): void {
		const configPath = this.#configFile.path();
		const serialized =
			configPath.endsWith(".json") || configPath.endsWith(".jsonc")
				? JSON.stringify(config, null, 2)
				: YAML.stringify(config, null, 2);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, serialized, "utf-8");
		this.#configFile.invalidate?.();
		const nextVersion = (presetConfigVersions.get(this.#configPathKey) ?? 0) + 1;
		presetConfigVersions.set(this.#configPathKey, nextVersion);
		this.#configVersion = nextVersion;
		this.#resolved = clonePresetsConfig(config);
		this.#events.emit("presets_changed", {
			activePreset: config.activePreset,
		} satisfies PresetsChangedEvent);
	}

	on<E extends keyof PresetsConfigEventMap>(event: E, handler: (event: PresetsConfigEventMap[E]) => void): () => void {
		return this.#events.on(event, data => handler(data as PresetsConfigEventMap[E]));
	}

	isEventFromThisInstance(event: PresetAppliedEvent): boolean {
		return event.sourceInstanceId === this.#instanceId;
	}

	listPresets(): Array<{ name: string } & PresetMetadata> {
		return Object.entries(this.#getConfig().presets)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, snapshot]) => ({
				name,
				description: snapshot.description,
				createdAt: snapshot.createdAt,
				updatedAt: snapshot.updatedAt,
			}));
	}

	getPreset(name: string): PresetSnapshot | undefined {
		const snapshot = this.#getConfig().presets[name];
		return snapshot ? clonePresetSnapshot(snapshot) : undefined;
	}

	savePreset(name: string, snapshot: PresetSnapshot): void {
		const config = clonePresetsConfig(this.#getConfig());
		config.presets[name] = clonePresetSnapshot(snapshot);
		this.#persistConfig(config);
	}

	deletePreset(name: string): void {
		const config = clonePresetsConfig(this.#getConfig());
		delete config.presets[name];
		if (config.activePreset === name) {
			config.activePreset = null;
		}
		if (config.defaultPreset === name) {
			config.defaultPreset = null;
		}
		this.#persistConfig(config);
	}

	renamePreset(oldName: string, newName: string): void {
		if (oldName === newName) {
			return;
		}
		const config = clonePresetsConfig(this.#getConfig());
		const snapshot = config.presets[oldName];
		if (!snapshot) {
			return;
		}
		config.presets[newName] = clonePresetSnapshot(snapshot);
		delete config.presets[oldName];
		if (config.activePreset === oldName) {
			config.activePreset = newName;
		}
		if (config.defaultPreset === oldName) {
			config.defaultPreset = newName;
		}
		this.#persistConfig(config);
	}

	getActivePreset(): string | null {
		const activePreset = this.#getConfig().activePreset;
		if (!activePreset) {
			return null;
		}
		if (this.#getConfig().presets[activePreset] === undefined) {
			logger.warn("Active preset missing from presets config", { name: activePreset });
			return null;
		}
		return activePreset;
	}

	setActivePreset(name: string | null): void {
		const config = clonePresetsConfig(this.#getConfig());
		if (name !== null && config.presets[name] === undefined) {
			throw new Error(`Unknown preset: ${name}`);
		}
		config.activePreset = name;
		this.#persistConfig(config);
	}

	captureCurrentConfig(): CapturedPresetSnapshot {
		const fullConfig = this.#rolesConfig.getFullConfig();
		return {
			modelRoles: this.#settings.getResolvedModelRoles(this.#modelRegistry),
			roles: fullConfig.roles,
			subagents: fullConfig.subagents,
		};
	}

	isModified(): boolean {
		const activePresetName = this.getActivePreset();
		if (!activePresetName) {
			return false;
		}
		const activePreset = this.getPreset(activePresetName);
		if (!activePreset) {
			return false;
		}
		const fullConfig = this.#rolesConfig.getFullConfig();
		const currentSnapshot = {
			modelRoles: this.#settings.getSessionResolvedModelRoles(this.#modelRegistry),
			roles: fullConfig.roles,
			subagents: fullConfig.subagents,
		};
		const activeSnapshot = {
			modelRoles: activePreset.modelRoles,
			roles: activePreset.roles,
			subagents: activePreset.subagents,
		};
		return stableSerialize(currentSnapshot) !== stableSerialize(activeSnapshot);
	}

	/**
	 * Returns the configured default preset name, or null if none is set or the
	 * named preset no longer exists in the store.
	 */
	getDefaultPreset(): string | null {
		const defaultPreset = this.#getConfig().defaultPreset;
		if (!defaultPreset) {
			return null;
		}
		if (this.#getConfig().presets[defaultPreset] === undefined) {
			logger.warn("Default preset missing from presets config", { name: defaultPreset });
			return null;
		}
		return defaultPreset;
	}

	/**
	 * Persists a new default preset. Pass null to clear the current default.
	 */
	setDefaultPreset(name: string | null): void {
		const config = clonePresetsConfig(this.#getConfig());
		if (name !== null && config.presets[name] === undefined) {
			throw new Error(`Unknown preset: ${name}`);
		}
		config.defaultPreset = name;
		this.#persistConfig(config);
	}

	async applyPreset(name: string): Promise<void> {
		const snapshot = this.getPreset(name);
		if (!snapshot) {
			throw new Error(`Unknown preset: ${name}`);
		}

		await this.#settings.persistModelRolesAtomically(snapshot.modelRoles);
		this.#rolesConfig.mergeConfig({ roles: snapshot.roles, subagents: snapshot.subagents });
		this.setActivePreset(name);
		this.#settings.clearOverride("modelRoles");
		this.#events.emit("preset_applied", {
			name,
			snapshot: clonePresetSnapshot(snapshot),
			sourceInstanceId: this.#instanceId,
		} satisfies PresetAppliedEvent);
	}
}

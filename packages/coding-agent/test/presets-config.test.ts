import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { Value } from "@sinclair/typebox/value";
import { YAML } from "bun";
import { MODEL_ROLE_IDS, ModelRegistry } from "../src/config/model-registry";
import { type PresetSnapshot, PresetSnapshotSchema, PresetsConfig } from "../src/config/presets-config";
import { RolesConfig, type RolesConfigData } from "../src/config/roles-config";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

describe("PresetsConfig", () => {
	let tempDir: string;
	let projectDir: string;
	let agentDir: string;
	let rolesPath: string;
	let configPath: string;
	let presetsPath: string;
	let authDbPath: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let rolesConfig: RolesConfig;

	beforeEach(async () => {
		_resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-presets-config-${Snowflake.next()}`);
		projectDir = path.join(tempDir, "project");
		agentDir = path.join(tempDir, "agent");
		rolesPath = path.join(agentDir, "roles.yml");
		configPath = path.join(agentDir, "config.yml");
		presetsPath = path.join(agentDir, "presets.yml");
		authDbPath = path.join(tempDir, "auth.db");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		authStorage = await AuthStorage.create(authDbPath);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		rolesConfig = new RolesConfig(rolesPath);
	});

	afterEach(async () => {
		authStorage?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		_resetSettingsForTest();
	});

	async function writeYaml(filePath: string, value: unknown): Promise<void> {
		await Bun.write(filePath, YAML.stringify(value, null, 2));
	}

	async function readYaml(filePath: string): Promise<Record<string, unknown>> {
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			return {};
		}
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
	}

	async function initConfigState(): Promise<void> {
		settings = await Settings.init({ cwd: projectDir, agentDir });
		rolesConfig = new RolesConfig(rolesPath);
	}

	function createPresetsConfig(): PresetsConfig {
		return new PresetsConfig(presetsPath, settings, rolesConfig, modelRegistry);
	}

	function getRequiredModel(provider: string, id: string): string {
		const model = modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`Expected model ${provider}/${id}`);
		}
		return `${model.provider}/${model.id}`;
	}

	function createSnapshot(modelKey: string): PresetSnapshot {
		return {
			description: "Stable baseline",
			createdAt: "2026-03-27T00:00:00.000Z",
			updatedAt: "2026-03-27T00:00:00.000Z",
			modelRoles: Object.fromEntries(MODEL_ROLE_IDS.map(role => [role, modelKey])),
			roles: {
				default: {
					tools: ["read", "grep"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
				research: {
					mcp: ["augment", "ref"],
					skills: {
						auto: ["brainstorming"],
						frontmatter: [],
					},
				},
			},
		};
	}

	it("validates preset snapshots with role and subagent config schemas", () => {
		const modelKey = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const validSnapshot = createSnapshot(modelKey);

		expect(Value.Check(PresetSnapshotSchema, validSnapshot)).toBe(true);
		expect(
			Value.Check(PresetSnapshotSchema, {
				...validSnapshot,
				roles: {
					default: {
						tools: ["read"],
						mcp: ["augment"],
						skills: { auto: ["brainstorming"] },
					},
				},
			}),
		).toBe(false);
		expect(
			Value.Check(PresetSnapshotSchema, {
				...validSnapshot,
				modelRoles: { default: modelKey },
			}),
		).toBe(false);
	});

	it("saves, lists, reads, and deletes presets", async () => {
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const modelKey = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const snapshot = createSnapshot(modelKey);

		presetsConfig.savePreset("Baseline", snapshot);

		expect(presetsConfig.listPresets()).toEqual([
			{
				name: "Baseline",
				description: "Stable baseline",
				createdAt: "2026-03-27T00:00:00.000Z",
				updatedAt: "2026-03-27T00:00:00.000Z",
			},
		]);
		expect(presetsConfig.getPreset("Baseline")).toEqual(snapshot);

		presetsConfig.deletePreset("Baseline");

		expect(presetsConfig.listPresets()).toEqual([]);
		expect(presetsConfig.getPreset("Baseline")).toBeUndefined();
	});

	it("captures current config with resolved model roles and deep-cloned roles data", async () => {
		const defaultModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const orchestratorModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${defaultModel}:high`,
				orchestrator: `${orchestratorModel}:off`,
			},
		});
		const initialRoles: RolesConfigData = {
			roles: {
				default: {
					tools: ["read", "write"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
				implement: {
					mcp: ["augment"],
					skills: {
						auto: ["simplify"],
						frontmatter: [],
					},
				},
			},
		};
		await writeYaml(rolesPath, initialRoles);
		await initConfigState();
		const presetsConfig = createPresetsConfig();

		const captured = presetsConfig.captureCurrentConfig();
		const resolvedRoles = settings.getResolvedModelRoles(modelRegistry);

		expect(Object.keys(captured.modelRoles).sort()).toEqual([...MODEL_ROLE_IDS].sort());
		expect(captured.modelRoles).toEqual(resolvedRoles);
		expect(captured.modelRoles.default).toContain(":high");
		expect(captured.modelRoles.orchestrator).toContain(":off");
		expect(captured.roles).toEqual(initialRoles.roles);
		expect(captured.subagents).toEqual(initialRoles.subagents);

		captured.roles.default.tools.push("grep");
		captured.subagents.implement.mcp.push("ref");

		expect(rolesConfig.getFullConfig()).toEqual(initialRoles);
	});

	it("persists model-role merges without copying runtime-only overrides into config.yml", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const alternateModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
				ask: baselineModel,
			},
		});
		await initConfigState();

		settings.override("modelRoles", {
			...settings.getModelRoles(),
			vision: `${alternateModel}:low`,
		});
		settings.persistModelRoles({ orchestrator: `${alternateModel}:medium` });
		await settings.flush();

		const configYaml = await readYaml(configPath);
		expect((configYaml.modelRoles ?? {}) as Record<string, string>).toEqual({
			default: `${baselineModel}:high`,
			ask: baselineModel,
			orchestrator: `${alternateModel}:medium`,
		});
	});

	it("captures persisted model roles instead of runtime-only overrides", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const alternateModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await initConfigState();
		const presetsConfig = createPresetsConfig();

		settings.override("modelRoles", {
			...settings.getModelRoles(),
			vision: `${alternateModel}:low`,
		});

		const captured = presetsConfig.captureCurrentConfig();

		expect(captured.modelRoles.default).toBe(`${baselineModel}:high`);
		expect(captured.modelRoles.vision).toBe(`${baselineModel}:high`);
	});

	it("keeps persisted preset snapshots clean when runtime role overrides are applied", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const alternateModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await initConfigState();
		const presetsConfig = createPresetsConfig();

		settings.overrideModelRoles({ default: `${alternateModel}:low` });

		const captured = presetsConfig.captureCurrentConfig();
		const persistedRoles = ((await readYaml(configPath)).modelRoles ?? {}) as Record<string, string>;

		expect(settings.getModelRole("default")).toBe(`${alternateModel}:low`);
		expect(captured.modelRoles.default).toBe(`${baselineModel}:high`);
		expect(persistedRoles.default).toBe(`${baselineModel}:high`);
	});

	it("applies a preset with merge semantics and preserves round-trip snapshots", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const presetModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
				ask: baselineModel,
				vision: `${baselineModel}:low`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
				debug: {
					tools: ["read", "bash"],
					mcp: ["augment"],
					skills: "none",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
				research: {
					mcp: ["augment"],
				},
				lint: {
					mcp: ["augment", "ref"],
				},
			},
		});
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const snapshot = presetsConfig.captureCurrentConfig();

		rolesConfig.setToolsForRole("default", ["read", "grep"]);
		rolesConfig.setMcpForSubagent("research", ["augment", "better-context"]);
		settings.setModelRole("default", `${presetModel}:medium`);
		settings.setModelRole("orchestrator", `${presetModel}:low`);
		await settings.flush();

		presetsConfig.savePreset("Captured", {
			...snapshot,
			description: "Before mutation",
			createdAt: "2026-03-27T01:00:00.000Z",
			updatedAt: "2026-03-27T01:00:00.000Z",
			roles: {
				...snapshot.roles,
				"retired-role": {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				...snapshot.subagents,
				"retired-agent": {
					mcp: ["augment", "ref"],
				},
			},
		});
		await presetsConfig.applyPreset("Captured");

		const configYaml = await readYaml(configPath);
		const persistedRoles = (configYaml.modelRoles ?? {}) as Record<string, string>;
		expect(persistedRoles.default).toBe(snapshot.modelRoles.default);
		expect(persistedRoles.orchestrator).toBe(snapshot.modelRoles.orchestrator);
		expect(persistedRoles.vision).toBe(snapshot.modelRoles.vision);
		expect(persistedRoles.default).toContain(":high");
		expect(persistedRoles.vision).toContain(":low");
		expect(rolesConfig.getToolsForRole("default")).toEqual(["read"]);
		expect(rolesConfig.getToolsForRole("debug")).toEqual(["read", "bash"]);
		expect(rolesConfig.getMcpForSubagent("research")).toEqual(["augment"]);
		expect(rolesConfig.getMcpForSubagent("lint")).toEqual(["augment", "ref"]);
		const mergedConfig = rolesConfig.getFullConfig();
		expect(mergedConfig.roles["retired-role"]).toBeUndefined();
		expect(mergedConfig.subagents["retired-agent"]).toBeUndefined();
		expect(presetsConfig.getActivePreset()).toBe("Captured");
		expect(presetsConfig.captureCurrentConfig()).toEqual(snapshot);
	});

	it("rejects apply when settings persistence fails and does not emit success", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const alternateModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const snapshot = presetsConfig.captureCurrentConfig();
		const events: string[] = [];
		presetsConfig.savePreset("Baseline", {
			...snapshot,
			createdAt: "2026-03-27T03:00:00.000Z",
			updatedAt: "2026-03-27T03:00:00.000Z",
		});
		settings.setModelRole("default", `${alternateModel}:medium`);
		await settings.flush();
		const beforeApply = await readYaml(configPath);
		const beforeModelRoles = (beforeApply.modelRoles ?? {}) as Record<string, string>;
		const unsubscribe = presetsConfig.on("preset_applied", event => {
			events.push(event.name);
		});

		await fs.chmod(configPath, 0o444);
		try {
			await expect(presetsConfig.applyPreset("Baseline")).rejects.toThrow();
		} finally {
			await fs.chmod(configPath, 0o644);
			unsubscribe();
		}

		const afterReject = await readYaml(configPath);
		const afterRejectModelRoles = (afterReject.modelRoles ?? {}) as Record<string, string>;
		expect(events).toEqual([]);
		expect(presetsConfig.getActivePreset()).toBeNull();
		expect(settings.getModelRole("default")).toBe(beforeModelRoles.default);
		expect(afterRejectModelRoles.default).toBe(beforeModelRoles.default);

		await settings.flush();
		const afterLaterFlush = await readYaml(configPath);
		expect(((afterLaterFlush.modelRoles ?? {}) as Record<string, string>).default).toBe(beforeModelRoles.default);
	});

	it("ignores project-level model role overrides when checking preset modified state", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const projectModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({ modelRoles: { default: `${projectModel}:low` } }, null, 2),
		);
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const snapshot = presetsConfig.captureCurrentConfig();
		presetsConfig.savePreset("Baseline", {
			...snapshot,
			createdAt: "2026-03-27T04:00:00.000Z",
			updatedAt: "2026-03-27T04:00:00.000Z",
		});
		presetsConfig.setActivePreset("Baseline");

		expect(settings.getModelRole("default")).toBe(`${projectModel}:low`);
		expect(snapshot.modelRoles.default).toBe(`${baselineModel}:high`);
		expect(presetsConfig.isModified()).toBe(false);
	});

	it("keeps project-only model roles out of session override state", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const projectModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await fs.mkdir(getProjectAgentDir(projectDir), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "settings.json"),
			JSON.stringify({ modelRoles: { default: `${projectModel}:low` } }, null, 2),
		);
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const snapshot = presetsConfig.captureCurrentConfig();
		presetsConfig.savePreset("Baseline", {
			...snapshot,
			createdAt: "2026-03-27T05:00:00.000Z",
			updatedAt: "2026-03-27T05:00:00.000Z",
		});
		presetsConfig.setActivePreset("Baseline");

		settings.overrideModelRoles({ ask: `${baselineModel}:off` });

		expect(settings.getSessionResolvedModelRoles(modelRegistry).default).toBe(`${baselineModel}:high`);
		expect(settings.getModelRole("default")).toBe(`${baselineModel}:high`);
		expect(presetsConfig.isModified()).toBe(true);
	});

	it("tracks modified state and emits after applying the active preset", async () => {
		const baselineModel = getRequiredModel("anthropic", "claude-sonnet-4-5");
		const alternateModel = getRequiredModel("anthropic", "claude-opus-4-5");
		await writeYaml(configPath, {
			modelRoles: {
				default: `${baselineModel}:high`,
			},
		});
		await writeYaml(rolesPath, {
			roles: {
				default: {
					tools: ["read"],
					mcp: ["augment"],
					skills: "all",
				},
			},
			subagents: {
				_default: {
					mcp: ["augment"],
				},
			},
		});
		await initConfigState();
		const presetsConfig = createPresetsConfig();
		const snapshot = presetsConfig.captureCurrentConfig();
		const events: Array<{ name: string }> = [];
		presetsConfig.savePreset("Baseline", {
			...snapshot,
			createdAt: "2026-03-27T02:00:00.000Z",
			updatedAt: "2026-03-27T02:00:00.000Z",
		});
		presetsConfig.setActivePreset("Baseline");
		const unsubscribe = presetsConfig.on("preset_applied", event => {
			events.push({ name: event.name });
		});

		expect(presetsConfig.isModified()).toBe(false);

		settings.overrideModelRoles({ default: `${alternateModel}:low` });
		expect(settings.getModelRole("default")).toBe(`${alternateModel}:low`);
		expect(presetsConfig.isModified()).toBe(true);

		await presetsConfig.applyPreset("Baseline");

		expect(settings.getModelRole("default")).toBe(snapshot.modelRoles.default);
		expect(events).toEqual([{ name: "Baseline" }]);
		expect(presetsConfig.isModified()).toBe(false);
		unsubscribe();
	});
});

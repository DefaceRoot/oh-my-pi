import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { cloneSettingsSnapshot } from "../src/config/advanced-config";
import { ModelRegistry } from "../src/config/model-registry";
import { _resetSettingsForTest, Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("createAgentSession advanced role overrides", () => {
	let tempDir: string;
	let authStorage: AuthStorage | null = null;

	beforeEach(() => {
		_resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `pi-sdk-advanced-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		authStorage?.close();
		authStorage = null;
		_resetSettingsForTest();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("applies role advanced config overrides when creating a role-scoped session", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  orchestrator:
    tools:
      - read
    mcp:
      - augment
    skills: all
    advanced:
      thinkingLevel: low
      maxRecursionDepth: 5
      compactionStrategy: handoff
      temperature: 0.2
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "orchestrator",
		});

		expect(session.thinkingLevel).toBe("low" as ThinkingLevel);
		expect(session.settings.get("task.maxRecursionDepth")).toBe(5);
		expect(session.settings.get("compaction.strategy")).toBe("handoff");
		expect(session.settings.get("temperature")).toBe(0.2);
		expect((session.agent as { temperature?: number }).temperature).toBe(0.2);
	});

	test("treats explicit null advancedConfig as no override instead of falling back to the role entry", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
	  default:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	  orchestrator:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	    advanced:
	      thinkingLevel: low
	      maxRecursionDepth: 5
	subagents:
	  _default:
	    mcp:
	      - augment
	`,
			"utf8",
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "orchestrator",
			advancedConfig: null,
		});

		expect(session.thinkingLevel).not.toBe("low" as ThinkingLevel);
		expect(session.settings.get("task.maxRecursionDepth")).not.toBe(5);
	});

	test("does not leak advanced overrides back into a reused Settings instance", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
	  default:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	  orchestrator:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	    advanced:
	      maxRecursionDepth: 5
	subagents:
	  _default:
	    mcp:
	      - augment
	`,
			"utf8",
		);
		const sharedSettings = Settings.isolated({ "async.enabled": true, "task.maxRecursionDepth": 2 });
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: sharedSettings,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "orchestrator",
		});

		expect(sharedSettings.get("task.maxRecursionDepth")).toBe(2);

		const { session: secondSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: sharedSettings,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "default",
		});

		expect(secondSession.settings.get("task.maxRecursionDepth")).toBe(2);
	});

	test("keeps settings writes persistent when role advanced overrides are active", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
	  default:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	  orchestrator:
	    tools:
	      - read
	    mcp:
	      - augment
	    skills: all
	    advanced:
	      temperature: 0.2
	subagents:
	  _default:
	    mcp:
	      - augment
	`,
			"utf8",
		);
		const sharedSettings = Settings.isolated({ "async.enabled": true });
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: sharedSettings,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read"],
			role: "orchestrator",
		});

		session.settings.set("temperature", 0.7);
		expect(session.settings.get("temperature")).toBe(0.7);
		expect(sharedSettings.get("temperature")).toBe(0.7);
	});
	test("preserves model-role persistence semantics in cloned advanced settings snapshots", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const baseline = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const alternate = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!baseline || !alternate) {
			throw new Error("Expected anthropic test models");
		}
		const baselineModel = `${baseline.provider}/${baseline.id}`;
		const alternateModel = `${alternate.provider}/${alternate.id}`;
		const sharedSettings = await Settings.init({ cwd: tempDir, agentDir: tempDir });
		sharedSettings.set("modelRoles", { default: `${baselineModel}:high` });
		await sharedSettings.flush();

		const clonedSettings = cloneSettingsSnapshot(sharedSettings);
		clonedSettings.override("temperature", 0.2);

		expect(clonedSettings).not.toBe(sharedSettings);
		expect(clonedSettings.get("temperature")).toBe(0.2);
		expect(clonedSettings.getResolvedModelRoles(modelRegistry)).toEqual(
			sharedSettings.getResolvedModelRoles(modelRegistry),
		);

		await clonedSettings.persistModelRolesAtomically({ default: `${alternateModel}:medium` });
		expect(clonedSettings.getResolvedModelRoles(modelRegistry)).toEqual(
			sharedSettings.getResolvedModelRoles(modelRegistry),
		);

		clonedSettings.overrideModelRoles({ default: `${alternateModel}:low` });
		expect(sharedSettings.getSessionResolvedModelRoles(modelRegistry).default).toBe(`${alternateModel}:low`);

		clonedSettings.clearOverride("modelRoles");
		expect(sharedSettings.getSessionResolvedModelRoles(modelRegistry).default).toBe(`${alternateModel}:medium`);
		expect(clonedSettings.getSessionResolvedModelRoles(modelRegistry)).toEqual(
			sharedSettings.getSessionResolvedModelRoles(modelRegistry),
		);
	});
	test("merges atomic model-role writes with fresh on-disk state", async () => {
		const configPath = path.join(tempDir, "config.yml");
		const sharedSettings = await Settings.init({ cwd: tempDir, agentDir: tempDir });
		sharedSettings.set("modelRoles", { default: "anthropic/claude-sonnet-4-5:high" });
		await sharedSettings.flush();

		fs.writeFileSync(
			configPath,
			YAML.stringify(
				{
					modelRoles: {
						default: "anthropic/claude-sonnet-4-5:high",
						ask: "anthropic/claude-opus-4-5:low",
					},
				},
				null,
				2,
			),
			"utf8",
		);

		await sharedSettings.persistModelRolesAtomically({
			default: "anthropic/claude-opus-4-5:medium",
		});

		const persisted = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
			modelRoles?: Record<string, string>;
		};
		expect(persisted.modelRoles).toEqual({
			default: "anthropic/claude-opus-4-5:medium",
			ask: "anthropic/claude-opus-4-5:low",
		});
	});


});

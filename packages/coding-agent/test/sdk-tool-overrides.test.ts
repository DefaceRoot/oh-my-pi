import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { createAgentSession, type MCPManager } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

function createCustomTool(name: string, mcpServerName?: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name} ok` }] }),
		...(mcpServerName ? { mcpServerName, mcpToolName: name } : {}),
	};
}

function createFakeMcpManager(
	tools: Array<ReturnType<typeof createCustomTool>>,
	instructions: ReadonlyMap<string, string>,
): MCPManager {
	return {
		getTools: () => tools as never,
		getServerInstructions: (allowedServerNames?: readonly string[]) => {
			if (!allowedServerNames) return new Map(instructions);
			const allowed = new Set(allowedServerNames);
			return new Map(Array.from(instructions.entries()).filter(([name]) => allowed.has(name)));
		},
		getConnectedServers: () => Array.from(instructions.keys()),
		getServerPrompts: () => [],
		setOnToolsChanged: () => {},
		setOnPromptsChanged: () => {},
		setOnResourcesChanged: () => {},
	} as unknown as MCPManager;
}

describe("createAgentSession tool overrides", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-tool-overrides-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("removes explicitly disabled MCP tools from active tools and prompt output", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
      - grafana
    disabledTools:
      - mcp_grafana_list_datasources
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const mcpManager = createFakeMcpManager(
			[
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
			],
			new Map([
				["augment", "Use augment for semantic code retrieval."],
				["grafana", "Prefer summary-oriented Grafana tools first."],
			]),
		);

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
			taskDepth: 1,

			toolNames: ["read"],
			mcpManager,
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
			],
		});

		expect(session.getActiveToolNames()).toContain("mcp_augment_codebase_retrieval");
		expect(session.getActiveToolNames()).not.toContain("mcp_grafana_list_datasources");
		expect(session.systemPrompt).toContain("mcp_augment_codebase_retrieval");
		expect(session.systemPrompt).not.toContain("mcp_grafana_list_datasources");
		expect(session.systemPrompt).toContain("### augment");
		expect(session.systemPrompt).not.toContain("### grafana");
	});

	test("filters explicitly requested disabled MCP tools from the initial session", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
      - grafana
    disabledTools:
      - mcp_grafana_list_datasources
    skills: all
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
			taskDepth: 1,
			toolNames: ["read", "mcp_grafana_list_datasources"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
			],
		});

		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames()).not.toContain("mcp_grafana_list_datasources");
		expect(session.systemPrompt).not.toContain("mcp_grafana_list_datasources");
	});


	test("keeps disabled MCP tools out of the discovery catalog", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
      - grafana
    disabledTools:
      - mcp_grafana_list_datasources
    skills: all
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
			settings: Settings.isolated({ "async.enabled": true, "mcp.discoveryMode": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
			],
		});

		expect(session.getDiscoverableMCPTools().map(tool => tool.name)).toEqual(["mcp_augment_codebase_retrieval"]);
	});

	test("applies memory and grep behavior overrides from persisted role config", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
      - grep
    mcp:
      - augment
    skills: all
    advanced:
      memoriesEnabled: true
      grepContextBefore: 2
      grepContextAfter: 3
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		const settings = Settings.isolated({ "async.enabled": true, "memories.enabled": false });
		const memoryRoot = getMemoryRoot(tempDir, settings.getCwd());
		fs.mkdirSync(memoryRoot, { recursive: true });
		fs.writeFileSync(path.join(memoryRoot, "memory_summary.md"), "Prefer structured retries.", "utf8");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			toolNames: ["read", "grep"],
		});

		expect(session.systemPrompt).toContain("memory://root/memory_summary.md");
		expect(session.settings.get("memories.enabled")).toBe(true);
		expect(session.settings.get("grep.contextBefore")).toBe(2);
		expect(session.settings.get("grep.contextAfter")).toBe(3);
		expect(settings.get("memories.enabled")).toBe(false);
	});
});

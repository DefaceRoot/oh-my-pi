import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { LoadedCustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Snowflake } from "@oh-my-pi/pi-utils";

const mockedLoadedTools: LoadedCustomTool[] = [];

const mockedMcpManager = {
	setNotificationsEnabled: () => {},
	setOnToolsChanged: () => {},
	setOnPromptsChanged: () => {},
	setOnResourcesChanged: () => {},
	getServerInstructions: () => new Map<string, string>(),
	getTools: () => mockedLoadedTools.map(tool => tool.tool),
};

mock.module("@oh-my-pi/pi-coding-agent/mcp", () => ({
	discoverAndLoadMCPTools: async () => ({
		manager: mockedMcpManager,
		tools: mockedLoadedTools,
		errors: [],
		connectedServers: ["augment", "grafana", "chrome-devtools"],
		exaApiKeys: [],
	}),
}));

const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");

type MainRole = "default" | "orchestrator" | "plan" | "ask";

function createMockMcpTool(name: string, serverName: string): LoadedCustomTool {
	return {
		path: `mcp:${serverName}`,
		resolvedPath: `mcp:${name}`,
		tool: {
			name,
			label: name,
			description: `${serverName} test tool`,
			parameters: Type.Object({}),
			renderCall: () => "",
			renderResult: () => "",
			execute: async () => ({
				content: [{ type: "text" as const, text: `${name} ok` }],
			}),
			mcpServerName: serverName,
			mcpToolName: name,
		} as any,
	};
}

describe("Phase 3 RED: parent MCP filtering", () => {
	const sessions: Array<{ dispose: () => Promise<void> }> = [];
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		_resetSettingsForTest();
		mockedLoadedTools.splice(0);
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionForRole(role: MainRole): Promise<{ getActiveToolNames: () => string[]; dispose: () => Promise<void> }> {
		const tempDir = path.join(os.tmpdir(), `pi-mcp-phase3-red-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", role);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: true,
			enableMCP: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session as any;
	}

	it("loads only role-allowed MCP servers in default mode", async () => {
		mockedLoadedTools.push(
			createMockMcpTool("mcp_augment_codebase_retrieval", "augment"),
			createMockMcpTool("mcp_grafana_list_datasources", "grafana"),
			createMockMcpTool("mcp_chrome_devtools_click", "chrome-devtools"),
		);

		const session = await createSessionForRole("default");
		const activeMcpTools = session.getActiveToolNames().filter(name => name.startsWith("mcp_")).sort();

		expect(activeMcpTools).toEqual(["mcp_augment_codebase_retrieval"]);
	});
});

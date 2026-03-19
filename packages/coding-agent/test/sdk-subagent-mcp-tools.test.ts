import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

describe("createAgentSession MCP proxy tool exposure", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-subagent-mcp-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("includes allowed MCP proxy tools in subagent tool list and prompt", async () => {
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
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
				createCustomTool("helper"),
			],
		});

		const activeToolNames = session.getActiveToolNames();
		expect(activeToolNames).toContain("read");
		expect(activeToolNames).toContain("helper");
		expect(activeToolNames).toContain("mcp_augment_codebase_retrieval");
		expect(activeToolNames).toContain("mcp_grafana_list_datasources");
		expect(activeToolNames.filter(name => name.startsWith("mcp_")).sort()).toEqual([
			"mcp_augment_codebase_retrieval",
			"mcp_grafana_list_datasources",
		]);
		expect(session.systemPrompt).toContain("mcp_augment_codebase_retrieval");
		expect(session.systemPrompt).toContain("mcp_grafana_list_datasources");
	});

	test("keeps MCP proxy tools out of sessions with an explicit empty allowlist", async () => {
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
			mcpAllowlist: [],
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
				createCustomTool("helper"),
			],
		});

		const activeToolNames = session.getActiveToolNames();
		expect(activeToolNames).toContain("read");
		expect(activeToolNames).toContain("helper");
		expect(activeToolNames.filter(name => name.startsWith("mcp_")).sort()).toEqual([]);
		expect(session.systemPrompt).not.toContain("mcp_augment_codebase_retrieval");
		expect(session.systemPrompt).not.toContain("mcp_grafana_list_datasources");
	});

	test("injects inherited MCP server instructions for allowlisted subagent tools", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const inheritedTools = [
			createCustomTool("mcp_grafana_list_datasources", "grafana"),
			createCustomTool("mcp_chrome_devtools_list_pages", "chrome-devtools"),
		];
		const mcpManager = createFakeMcpManager(
			inheritedTools,
			new Map([
				["grafana", "Prefer summary-oriented Grafana tools first."],
				["chrome-devtools", "Validate visible UI outcomes after each action."],
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
			mcpAllowlist: ["grafana"],
			mcpManager,
			customTools: inheritedTools,
		});

		expect(session.getActiveToolNames()).toContain("mcp_grafana_list_datasources");
		expect(session.getActiveToolNames()).not.toContain("mcp_chrome_devtools_list_pages");
		expect(session.systemPrompt).toContain("## MCP Server Instructions");
		expect(session.systemPrompt).toContain("### grafana");
		expect(session.systemPrompt).toContain("Prefer summary-oriented Grafana tools first.");
		expect(session.systemPrompt).not.toContain("### chrome-devtools");
	});
});
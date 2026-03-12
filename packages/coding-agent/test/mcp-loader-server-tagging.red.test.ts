import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import * as mcpConfig from "@oh-my-pi/pi-coding-agent/mcp/config";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { Type } from "@sinclair/typebox";

function createMockMcpTool(name: string, serverName: string): CustomTool {
	return {
		name,
		label: name,
		description: `${serverName} tool`,
		parameters: Type.Object({}),
		renderCall: () => "",
		renderResult: () => "",
		execute: async () => ({
			content: [{ type: "text" as const, text: "ok" }],
			details: { serverName, mcpToolName: name },
		}),
		mcpServerName: serverName,
		mcpToolName: name,
	} as any;
}

describe("Phase 3 RED: MCP loader server tagging", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("includes source serverName metadata on loaded MCP tools", async () => {
		const tool = createMockMcpTool("mcp_grafana_list_datasources", "grafana");
		vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockResolvedValue({
			tools: [tool as any],
			errors: new Map(),
			connectedServers: ["grafana"],
			exaApiKeys: [],
		});

		const result = await discoverAndLoadMCPTools(process.cwd(), { cacheStorage: null });
		expect(result.tools).toHaveLength(1);
		expect((result.tools[0] as unknown as { serverName?: string }).serverName).toBe("grafana");
	});

	it("filters disallowed MCP servers before connect orchestration", async () => {
		const discoveredConfigs = {
			augment: { command: "augment-server" },
			grafana: { command: "grafana-server" },
			"chrome-devtools": { command: "chrome-server" },
		};
		const discoveredSources = {
			augment: { provider: "mcp-json", providerName: "MCP JSON", path: "/tmp/.mcp.json", level: "project" },
			grafana: { provider: "mcp-json", providerName: "MCP JSON", path: "/tmp/.mcp.json", level: "project" },
			"chrome-devtools": {
				provider: "mcp-json",
				providerName: "MCP JSON",
				path: "/tmp/.mcp.json",
				level: "project",
			},
		};
		vi.spyOn(mcpConfig, "loadAllMCPConfigs").mockResolvedValue({
			configs: discoveredConfigs as any,
			sources: discoveredSources as any,
			exaApiKeys: [],
		});

		const scenarios: Array<{ allowedServerNames: string[]; expectedServerNames: string[] }> = [
			{ allowedServerNames: [], expectedServerNames: [] },
			{ allowedServerNames: ["augment"], expectedServerNames: ["augment"] },
			{ allowedServerNames: ["augment", "chrome-devtools"], expectedServerNames: ["augment", "chrome-devtools"] },
		];

		for (const scenario of scenarios) {
			const manager = new MCPManager(process.cwd());
			const connectSpy = vi.spyOn(manager, "connectServers").mockResolvedValue({
				tools: [],
				errors: new Map(),
				connectedServers: scenario.expectedServerNames,
				exaApiKeys: [],
			});

			await manager.discoverAndConnect({ allowedServerNames: scenario.allowedServerNames } as any);

			const [receivedConfigs = {}, receivedSources = {}] = connectSpy.mock.calls[0] ?? [];
			expect(Object.keys(receivedConfigs as Record<string, unknown>).sort()).toEqual(
				[...scenario.expectedServerNames].sort(),
			);
			expect(Object.keys(receivedSources as Record<string, unknown>).sort()).toEqual(
				[...scenario.expectedServerNames].sort(),
			);
		}
	});
});

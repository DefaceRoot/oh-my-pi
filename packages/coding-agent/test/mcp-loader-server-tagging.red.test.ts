import { afterEach, describe, expect, it, vi } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

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
});

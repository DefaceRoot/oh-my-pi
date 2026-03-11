import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface MCPConfigFile {
	mcpServers?: Record<
		string,
		{
			args?: string[];
		}
	>;
}

function hasBrowserIsolationArgs(args: string[]): boolean {
	return args.includes("--isolated") || args.includes("--user-data-dir") || args.some(arg => arg.startsWith("--user-data-dir="));
}

describe("RED: Chrome DevTools MCP launch isolation", () => {
	it("requires explicit browser-profile isolation for chrome-devtools server", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const mcpConfigPath = path.join(repoRoot, "agent", "mcp.json");
		const config = (await Bun.file(mcpConfigPath).json()) as MCPConfigFile;
		const chromeDevtools = config.mcpServers?.["chrome-devtools"];

		expect(chromeDevtools).toBeDefined();
		const args = chromeDevtools?.args ?? [];
		expect(hasBrowserIsolationArgs(args)).toBe(true);
	});
});

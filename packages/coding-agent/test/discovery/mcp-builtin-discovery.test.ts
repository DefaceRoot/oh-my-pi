import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";

function getNativeMcpProvider() {
	const capability = getCapability<MCPServer>(mcpCapability.id);
	expect(capability).toBeDefined();

	const provider = capability?.providers.find(candidate => candidate.id === "native");
	expect(provider).toBeDefined();

	return provider!;
}

async function loadNativeMcpServers(cwd: string, home: string) {
	const provider = getNativeMcpProvider();
	const ctx: LoadContext = { cwd, home, repoRoot: cwd };
	return await provider.load(ctx);
}

describe("builtin MCP discovery", () => {
	let tempRoot: string;
	let homeDir: string;
	let projectDir: string;
	let originalRefApiKey: string | undefined;

	beforeEach(() => {
		clearFsCache();
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-builtin-mcp-"));
		homeDir = path.join(tempRoot, "home");
		projectDir = path.join(tempRoot, "project");
		fs.mkdirSync(homeDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });

		originalRefApiKey = Bun.env.REF_API_KEY;
		delete Bun.env.REF_API_KEY;
	});

	afterEach(() => {
		clearFsCache();
		if (originalRefApiKey === undefined) {
			delete Bun.env.REF_API_KEY;
		} else {
			Bun.env.REF_API_KEY = originalRefApiKey;
		}
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	test("includes bundled ref server when config files are absent", async () => {
		const result = await loadNativeMcpServers(projectDir, homeDir);
		const refServer = result.items.find(server => server.name === "ref");

		expect(refServer).toBeDefined();
		expect(refServer?.url).toBe(`https://api.ref.tools/mcp?apiKey=\${REF_API_KEY}`);
		expect(refServer?._source.provider).toBe("native");
		expect(refServer?._source.level).toBe("user");
	});

	test("uses config file ref server instead of bundled ref server", async () => {
		const configPath = path.join(projectDir, ".omp", "mcp.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					ref: {
						type: "http",
						url: "https://custom.ref.example/mcp",
						timeout: 45000,
					},
				},
			}),
		);

		const result = await loadNativeMcpServers(projectDir, homeDir);
		const refServers = result.items.filter(server => server.name === "ref");

		expect(refServers).toHaveLength(1);
		expect(refServers[0]?.url).toBe("https://custom.ref.example/mcp");
		expect(refServers[0]?.timeout).toBe(45000);
		expect(refServers[0]?._source.path).toBe(path.resolve(configPath));
	});

	test("expands REF_API_KEY in bundled ref url", async () => {
		Bun.env.REF_API_KEY = "ref-api-key-test";

		const result = await loadNativeMcpServers(projectDir, homeDir);
		const refServer = result.items.find(server => server.name === "ref");

		expect(refServer).toBeDefined();
		expect(refServer?.url).toBe("https://api.ref.tools/mcp?apiKey=ref-api-key-test");
	});
});

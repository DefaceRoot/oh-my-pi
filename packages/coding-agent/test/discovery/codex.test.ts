import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

async function loadCodexMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["codex"],
	});
	return result.items;
}

function getServerByName(servers: MCPServer[], name: string): MCPServer {
	const server = servers.find(candidate => candidate.name === name);
	if (!server) {
		throw new Error(`Expected MCP server ${name} to be discovered`);
	}
	return server;
}

describe("codex config.toml MCP env expansion", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	const originalEnv = {
		PI_GRAFANA_HOST: process.env.PI_GRAFANA_HOST,
		PI_GRAFANA_TENANT: process.env.PI_GRAFANA_TENANT,
		PI_GRAFANA_API_KEY: process.env.PI_GRAFANA_API_KEY,
		PI_GRAFANA_BEARER: process.env.PI_GRAFANA_BEARER,
		PI_GRAFANA_COMMAND: process.env.PI_GRAFANA_COMMAND,
		PI_GRAFANA_CWD: process.env.PI_GRAFANA_CWD,
	};

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-project-"));
		await fs.mkdir(path.join(tempDir, ".codex"), { recursive: true });

		process.env.PI_GRAFANA_HOST = "grafana.internal.example";
		process.env.PI_GRAFANA_TENANT = "tenant-a";
		process.env.PI_GRAFANA_API_KEY = "grafana-api-key";
		process.env.PI_GRAFANA_BEARER = "grafana-bearer-token";
		process.env.PI_GRAFANA_COMMAND = "/usr/local/bin/grafana-mcp";
		process.env.PI_GRAFANA_CWD = "/var/run/grafana-mcp";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		await fs.rm(tempHomeDir, { recursive: true, force: true });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("expands Grafana MCP server values from codex config.toml", async () => {
		await fs.writeFile(
			path.join(tempDir, ".codex", "config.toml"),
			`[mcp_servers.grafana]
url = "https://\${PI_GRAFANA_HOST}/api/mcp"
tool_timeout_sec = 12
http_headers = { "X-Grafana-Url" = "https://\${PI_GRAFANA_HOST}", "X-Tenant" = "\${PI_GRAFANA_TENANT}" }
env_http_headers = { "X-API-Key" = "PI_GRAFANA_API_KEY" }
bearer_token_env_var = "PI_GRAFANA_BEARER"

[mcp_servers.grafana_cli]
command = "\${PI_GRAFANA_COMMAND}"
args = ["serve", "--host=https://\${PI_GRAFANA_HOST}", "--tenant=\${PI_GRAFANA_TENANT}"]
env = { GRAFANA_TENANT = "\${PI_GRAFANA_TENANT}" }
env_vars = ["PI_GRAFANA_API_KEY"]
cwd = "\${PI_GRAFANA_CWD}"
`,
		);

		const servers = await loadCodexMcpConfig(tempDir);
		const grafana = getServerByName(servers, "grafana");
		const grafanaCli = getServerByName(servers, "grafana_cli");

		expect(grafana.url).toBe("https://grafana.internal.example/api/mcp");
		expect(grafana.headers).toEqual({
			"X-Grafana-Url": "https://grafana.internal.example",
			"X-Tenant": "tenant-a",
			"X-API-Key": "grafana-api-key",
			Authorization: "Bearer grafana-bearer-token",
		});
		expect(grafana.transport).toBe("http");
		expect(grafana.timeout).toBe(12_000);

		expect(grafanaCli.command).toBe("/usr/local/bin/grafana-mcp");
		expect(grafanaCli.args).toEqual(["serve", "--host=https://grafana.internal.example", "--tenant=tenant-a"]);
		expect(grafanaCli.env).toEqual({
			GRAFANA_TENANT: "tenant-a",
			PI_GRAFANA_API_KEY: "grafana-api-key",
		});
		expect(grafanaCli.cwd).toBe("/var/run/grafana-mcp");
		expect(grafanaCli.transport).toBe("stdio");
	});
});

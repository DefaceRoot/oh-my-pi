import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { RolesConfig } from "../src/config/roles-config";

describe("RolesConfig tool override accessors", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-tool-overrides-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
		await fs.writeFile(
			rolesPath,
			`roles:
  default:
    tools:
      - read
      - ask
    mcp:
      - augment
      - grafana
    skills: all
subagents:
  _default:
    mcp:
      - augment
  designer:
    mcp:
      - augment
      - chrome-devtools
`,
			"utf8",
		);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("round-trips disabled MCP tools for roles and subagents", () => {
		const rolesConfig = new RolesConfig(rolesPath);

		rolesConfig.setDisabledToolsForRole("default", ["mcp_grafana_list_datasources"]);
		rolesConfig.setDisabledToolsForSubagent("designer", ["mcp_chrome_devtools_click"]);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getDisabledToolsForRole("default")).toEqual(["mcp_grafana_list_datasources"]);
		expect(fresh.getDisabledToolsForSubagent("designer")).toEqual(["mcp_chrome_devtools_click"]);
		expect(fresh.getMcpForRole("default")).toEqual(["augment", "grafana"]);
		expect(fresh.getMcpForSubagent("designer")).toEqual(["augment", "chrome-devtools"]);
	});

	test("clearing disabled tools removes inert overrides", () => {
		const rolesConfig = new RolesConfig(rolesPath);
		rolesConfig.setDisabledToolsForRole("default", ["mcp_grafana_list_datasources"]);
		rolesConfig.setDisabledToolsForSubagent("designer", ["mcp_chrome_devtools_click"]);

		rolesConfig.setDisabledToolsForRole("default", []);
		rolesConfig.setDisabledToolsForSubagent("designer", []);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getDisabledToolsForRole("default")).toEqual([]);
		expect(fresh.getDisabledToolsForSubagent("designer")).toEqual([]);
		expect(fresh.getFullConfig().roles.default?.mcp).toEqual(["augment", "grafana"]);
		expect(fresh.getFullConfig().subagents.designer?.mcp).toEqual(["augment", "chrome-devtools"]);
		expect(fresh.getFullConfig().subagents.designer?.disabledTools).toBeUndefined();
	});
});

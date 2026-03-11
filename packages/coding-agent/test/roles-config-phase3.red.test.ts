import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { _testExports as askModePolicy } from "../../../agent/extensions/ask-mode/index.ts";

type RolesConfigContract = {
	getMcpForRole(role: string): string[] | Promise<string[]>;
	getMcpForSubagent(agentName: string): string[] | Promise<string[]>;
};

type RolesConfigModuleContract = {
	RolesConfig: new (configPath?: string) => RolesConfigContract;
};

async function loadRolesConfigModule(): Promise<RolesConfigModuleContract> {
	return (await import("../src/config/roles-config")) as RolesConfigModuleContract;
}

async function resolveArray(value: string[] | Promise<string[]>): Promise<string[]> {
	return await Promise.resolve(value);
}

describe("Phase 3 RED: RolesConfig MCP behavior", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-config-phase3-red-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const writeRoles = async (content: string) => {
		await fs.writeFile(rolesPath, content, "utf8");
	};

	it("keeps augment always enabled even when omitted from role/subagent config", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - grafana
    skills: none
subagents:
  designer:
    mcp:
      - chrome-devtools
  _default:
    mcp:
      - better-context
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getMcpForRole("default"))).toEqual(["augment", "grafana"]);
		expect(await resolveArray(rolesConfig.getMcpForSubagent("designer"))).toEqual(["augment", "chrome-devtools"]);
	});

	it("persists role MCP selections for /model flow", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: none
subagents:
  _default:
    mcp:
      - augment
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath) as RolesConfigContract & {
			setMcpForRole?: (role: string, servers: string[]) => void | Promise<void>;
		};

		expect(typeof rolesConfig.setMcpForRole).toBe("function");
		if (typeof rolesConfig.setMcpForRole !== "function") return;

		await rolesConfig.setMcpForRole("default", ["augment", "grafana"]);

		const reloadedConfig = new RolesConfig(rolesPath);
		expect(await resolveArray(reloadedConfig.getMcpForRole("default"))).toEqual(["augment", "grafana"]);
	});
});

const repoRolesPath = path.resolve(import.meta.dir, "../../../agent/roles.yml");

describe("repository roles MCP alignment with enforced ask/implementation policy", () => {
	it("keeps implement role BTCA access aligned with implementation policy", async () => {
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(repoRolesPath);
		const implementMcp = await resolveArray(rolesConfig.getMcpForRole("implement"));

		expect(implementMcp).toContain("better-context");
	});

	it("keeps ask subagent MCP split aligned with ask-mode policy", async () => {
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(repoRolesPath);
		const askExploreAllowsAugment =
			askModePolicy.shouldBlockTool(
				{ toolName: "mcp_augment_codebase_retrieval" },
				askModePolicy.isAskContext({ role: "default", agent: "ask-explore" }),
			) === undefined;
		const askResearchAllowsAugment =
			askModePolicy.shouldBlockTool(
				{ toolName: "mcp_augment_codebase_retrieval" },
				askModePolicy.isAskContext({ role: "default", agent: "ask-research" }),
			) === undefined;

		expect(await resolveArray(rolesConfig.getMcpForSubagent("ask-explore"))).toEqual(
			askExploreAllowsAugment ? ["augment"] : [],
		);
		expect(await resolveArray(rolesConfig.getMcpForSubagent("ask-research"))).toEqual(
			askResearchAllowsAugment ? ["augment"] : [],
		);
	});
});

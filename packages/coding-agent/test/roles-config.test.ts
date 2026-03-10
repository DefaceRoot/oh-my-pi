import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

type RolesConfigContract = {
	getToolsForRole(role: string): string[] | Promise<string[]>;
	getMcpForRole(role: string): string[] | Promise<string[]>;
	getSkillCategoriesForRole(role: string): string[] | Promise<string[]>;
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

describe("RolesConfig (Phase 1 RED)", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-config-red-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const writeRoles = async (content: string) => {
		await fs.writeFile(rolesPath, content, "utf8");
	};

	it("loads a valid roles.yml config", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - grep
    mcp:
      - augment
    skills:
      categories:
        - workflow
  ask:
    tools:
      - read
      - fetch
    mcp:
      - augment
    skills: none
subagents:
  _default:
    mcp:
      - augment
  research:
    mcp:
      - augment
      - better-context
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getToolsForRole("default"))).toEqual(["read", "grep"]);
		expect(await resolveArray(rolesConfig.getMcpForRole("default"))).toEqual(["augment"]);
		expect(await resolveArray(rolesConfig.getSkillCategoriesForRole("default"))).toEqual(["workflow"]);
	});

	it("falls back to hardcoded defaults when roles.yml is missing", async () => {
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getToolsForRole("default"))).toEqual(
			expect.arrayContaining(["read", "write", "edit", "task", "resolve"]),
		);
		expect(await resolveArray(rolesConfig.getMcpForRole("default"))).toEqual(["augment"]);
		expect(await resolveArray(rolesConfig.getMcpForSubagent("totally-unknown-subagent"))).toEqual(["augment"]);
	});

	it("returns role-specific tool allowlists for multiple roles", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - write
    mcp:
      - augment
    skills: all
  orchestrator:
    tools:
      - read
      - task
      - ask
    mcp:
      - augment
    skills:
      categories:
        - workflow
  ask:
    tools:
      - read
      - fetch
      - ask
    mcp:
      - augment
    skills: none
subagents:
  _default:
    mcp:
      - augment
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getToolsForRole("default"))).toEqual(["read", "write"]);
		expect(await resolveArray(rolesConfig.getToolsForRole("orchestrator"))).toEqual(["read", "task", "ask"]);
		expect(await resolveArray(rolesConfig.getToolsForRole("ask"))).toEqual(["read", "fetch", "ask"]);
	});

	it("returns subagent MCP allowlists with named and _default fallback", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  designer:
    mcp:
      - augment
      - chrome-devtools
  grafana:
    mcp:
      - augment
      - grafana
  _default:
    mcp:
      - augment
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getMcpForSubagent("designer"))).toEqual(["augment", "chrome-devtools"]);
		expect(await resolveArray(rolesConfig.getMcpForSubagent("grafana"))).toEqual(["augment", "grafana"]);
		expect(await resolveArray(rolesConfig.getMcpForSubagent("lint"))).toEqual(["augment"]);
	});

	it("resolves configured skill categories per role", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      categories:
        - implementation
        - frontend
  plan:
    tools:
      - read
    mcp:
      - augment
    skills:
      categories:
        - planning
        - workflow
  ask:
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
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getSkillCategoriesForRole("default"))).toEqual(["implementation", "frontend"]);
		expect(await resolveArray(rolesConfig.getSkillCategoriesForRole("plan"))).toEqual(["planning", "workflow"]);
		expect(await resolveArray(rolesConfig.getSkillCategoriesForRole("ask"))).toEqual([]);
	});
});

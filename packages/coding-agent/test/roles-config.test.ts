import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

type RolesConfigContract = {
	getToolsForRole(role: string): string[] | Promise<string[]>;
	setToolsForRole(role: string, tools: string[]): void;
	getMcpForRole(role: string): string[] | Promise<string[]>;
	getMcpForSubagent(agentName: string): string[] | Promise<string[]>;
	// V2 accessors
	getSkillConfigForRole(role: string): { auto: string[]; frontmatter: string[] } | undefined;
	setSkillConfigForRole(role: string, config: { auto: string[]; frontmatter: string[] }): void;
	getSkillConfigForSubagent(agent: string): { auto: string[]; frontmatter: string[] } | undefined;
	setSkillConfigForSubagent(agent: string, config: { auto: string[]; frontmatter: string[] }): void;
	getToolsForSubagent(agent: string): string[] | null;
	setToolsForSubagent(agent: string, config: { inherit?: string; add?: string[]; remove?: string[] }): void;
	setMcpForSubagent(agent: string, servers: string[]): void;
	setConfigForAgent(agentName: string, config: Record<string, unknown>): void;
	// Fallback accessors
	getFallbackForRole(role: string): string | null;
	setFallbackForRole(role: string, fallback: string | null): void;
	getFallbackForSubagent(agent: string): string | null;
	setFallbackForSubagent(agent: string, fallback: string | null): void;
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

	it("resolves role MCP allowlists from subagent entries when role config is absent", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  explore:
    mcp:
      - augment
      - better-context
  ask-explore:
    mcp: []
  _default:
    mcp:
      - augment
`);

		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(await resolveArray(rolesConfig.getMcpForRole("explore"))).toEqual(["augment", "better-context"]);
		expect(await resolveArray(rolesConfig.getMcpForRole("ask-explore"))).toEqual([]);
		expect(await resolveArray(rolesConfig.getMcpForRole("unknown-role"))).toEqual(["augment"]);
	});
});

describe("RolesConfig V2 accessors", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-config-v2-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const writeRoles = async (content: string) => {
		await fs.writeFile(rolesPath, content, "utf8");
	};

	it("getSkillConfigForRole returns undefined for V1 format", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  plan:
    tools:
      - read
    mcp:
      - augment
    skills:
      categories:
        - planning
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// V1 "all" string
		expect(rolesConfig.getSkillConfigForRole("default")).toBeUndefined();
		// V1 categories object
		expect(rolesConfig.getSkillConfigForRole("plan")).toBeUndefined();
	});

	it("getSkillConfigForRole returns SkillConfig for V2 format", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      auto:
        - frontend-design
      frontmatter:
        - brainstorming
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		const skillConfig = rolesConfig.getSkillConfigForRole("default");
		expect(skillConfig).toBeDefined();
		expect(skillConfig?.auto).toEqual(["frontend-design"]);
		expect(skillConfig?.frontmatter).toEqual(["brainstorming"]);
	});

	it("V2 SkillConfig round-trip via setSkillConfigForRole and getSkillConfigForRole", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// Write V2 skills to the default role
		rolesConfig.setSkillConfigForRole("default", { auto: ["simplify", "polish"], frontmatter: ["brainstorming"] });

		// Read back from a fresh instance (proves persistence)
		const fresh = new RolesConfig(rolesPath);
		const result = fresh.getSkillConfigForRole("default");
		expect(result).toBeDefined();
		expect(result?.auto).toEqual(["simplify", "polish"]);
		expect(result?.frontmatter).toEqual(["brainstorming"]);
	});

	it("getToolsForSubagent with inherit resolution", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - write
      - bash
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  custom-agent:
    mcp:
      - augment
    tools:
      inherit: default
      add:
        - task
      remove:
        - bash
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// null when no tools config
		expect(rolesConfig.getToolsForSubagent("_default")).toBeNull();

		// resolved: [read, write, bash] + task - bash = [read, write, task]
		const resolved = rolesConfig.getToolsForSubagent("custom-agent");
		expect(resolved).toBeDefined();
		expect(resolved).toContain("read");
		expect(resolved).toContain("write");
		expect(resolved).toContain("task");
		expect(resolved).not.toContain("bash");
	});

	it("getToolsForSubagent falls back to default role when inherit is missing", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  minimal-agent:
    mcp:
      - augment
    tools:
      remove:
        - grep
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// No inherit specified — defaults to "default" role
		const resolved = rolesConfig.getToolsForSubagent("minimal-agent");
		expect(resolved).toContain("read");
		expect(resolved).not.toContain("grep");
	});

	it("setMcpForSubagent persistence", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  my-agent:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		rolesConfig.setMcpForSubagent("my-agent", ["ref", "better-context"]);

		// Fresh instance reads persisted value
		const fresh = new RolesConfig(rolesPath);
		const servers = fresh.getMcpForSubagent("my-agent");
		expect(servers).toContain("augment");
		expect(servers).toContain("ref");
		expect(servers).toContain("better-context");
	});
	it("setConfigForAgent routes to roles section when name exists in roles", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  custom-role:
    tools:
      - read
      - bash
    mcp:
      - augment
    skills: none
subagents:
  _default:
    mcp:
      - augment
  new-agent:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// custom-role is a role entry — setConfigForAgent writes to roles
		rolesConfig.setConfigForAgent("custom-role", { mcp: ["ref"] });
		const fresh = new RolesConfig(rolesPath);
		// getMcpForRole reads roles section first
		expect(fresh.getMcpForRole("custom-role")).toContain("ref");

		// new-agent is in subagents only — setConfigForAgent writes to subagents
		rolesConfig.setConfigForAgent("new-agent", { mcp: ["better-context"] });
		const fresh2 = new RolesConfig(rolesPath);
		expect(fresh2.getMcpForSubagent("new-agent")).toContain("better-context");

		// brand-new name — goes to subagents by default
		rolesConfig.setConfigForAgent("brand-new", { mcp: ["ref"] });
		const fresh3 = new RolesConfig(rolesPath);
		expect(fresh3.getMcpForSubagent("brand-new")).toContain("ref");
	});
});

describe("RolesConfig fallback accessors", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-config-fallback-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const writeRoles = async (content: string) => {
		await fs.writeFile(rolesPath, content, "utf8");
	};

	it("getFallbackForRole returns null when not configured", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		expect(rolesConfig.getFallbackForRole("default")).toBeNull();
		expect(rolesConfig.getFallbackForRole("nonexistent")).toBeNull();
	});

	it("setFallbackForRole persists and getFallbackForRole round-trips", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		rolesConfig.setFallbackForRole("default", "openai/gpt-4o");

		// Verify via fresh instance (proves persistence)
		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getFallbackForRole("default")).toBe("openai/gpt-4o");
	});

	it("setFallbackForRole clears fallback when passed null", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
    fallback: openai/gpt-4o
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(rolesConfig.getFallbackForRole("default")).toBe("openai/gpt-4o");
		rolesConfig.setFallbackForRole("default", null);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getFallbackForRole("default")).toBeNull();
	});

	it("getFallbackForSubagent returns null when not configured", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  research:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		expect(rolesConfig.getFallbackForSubagent("research")).toBeNull();
		expect(rolesConfig.getFallbackForSubagent("nonexistent")).toBeNull();
	});

	it("setFallbackForSubagent persists and getFallbackForSubagent round-trips", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  research:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		rolesConfig.setFallbackForSubagent("research", "anthropic/claude-haiku");

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getFallbackForSubagent("research")).toBe("anthropic/claude-haiku");
	});

	it("setFallbackForSubagent clears fallback when passed null", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  research:
    mcp:
      - augment
    fallback: openai/gpt-4o
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		expect(rolesConfig.getFallbackForSubagent("research")).toBe("openai/gpt-4o");
		rolesConfig.setFallbackForSubagent("research", null);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getFallbackForSubagent("research")).toBeNull();
	});

	it("schema accepts fallback field in roles and subagents", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
    fallback: anthropic/claude-haiku
subagents:
  _default:
    mcp:
      - augment
  research:
    mcp:
      - augment
    fallback: openai/gpt-4o
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		expect(rolesConfig.getFallbackForRole("default")).toBe("anthropic/claude-haiku");
		expect(rolesConfig.getFallbackForSubagent("research")).toBe("openai/gpt-4o");
	});

	it("getFallbackForRole does not inherit fallback from the default role", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
    fallback: openai/gpt-4o
  orchestrator:
    tools:
      - read
      - task
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);

		// default role has fallback configured
		expect(rolesConfig.getFallbackForRole("default")).toBe("openai/gpt-4o");
		// orchestrator role has no fallback — must NOT inherit from default
		expect(rolesConfig.getFallbackForRole("orchestrator")).toBeNull();
		// unknown role — must NOT inherit from default
		expect(rolesConfig.getFallbackForRole("nonexistent")).toBeNull();
	});
});

describe("RolesConfig tools accessors", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-roles-config-tools-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const writeRoles = async (content: string) => {
		await fs.writeFile(rolesPath, content, "utf8");
	};

	it("getToolsForRole returns default tools when role does not exist", async () => {
		const { RolesConfig } = await loadRolesConfigModule();
		// No file — uses hardcoded defaults
		const rolesConfig = new RolesConfig(rolesPath);
		const tools = rolesConfig.getToolsForRole("totally-unknown-role");
		expect(tools).toContain("read");
		expect(tools).toContain("write");
	});

	it("setToolsForRole / getToolsForRole round-trip with persistence", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		rolesConfig.setToolsForRole("default", ["read", "grep", "bash"]);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getToolsForRole("default")).toEqual(["read", "grep", "bash"]);
	});

	it("setToolsForRole creates a new role entry when role does not exist", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		rolesConfig.setToolsForRole("custom-role", ["read", "write", "task"]);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getToolsForRole("custom-role")).toEqual(["read", "write", "task"]);
	});

	it("getToolsForSubagent returns null for subagent with no tools config", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  no-tools-agent:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		// Subagent exists but has no tools field — null signals "use agent defaults"
		expect(rolesConfig.getToolsForSubagent("no-tools-agent")).toBeNull();
		// Unknown subagent — also null
		expect(rolesConfig.getToolsForSubagent("completely-unknown")).toBeNull();
	});

	it("getToolsForSubagent returns empty array for tools:[] (distinct from null)", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  empty-tools-agent:
    mcp:
      - augment
    tools: []
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		const result = rolesConfig.getToolsForSubagent("empty-tools-agent");
		// [] is not null — caller knows tools are explicitly restricted to nothing
		expect(result).not.toBeNull();
		expect(result).toEqual([]);
	});

	it("getToolsForSubagent subagent-to-subagent inheritance applies add/remove", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - write
      - bash
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  base-agent:
    mcp:
      - augment
    tools:
      - read
      - write
  derived-agent:
    mcp:
      - augment
    tools:
      inherit: base-agent
      add:
        - task
      remove:
        - write
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		const result = rolesConfig.getToolsForSubagent("derived-agent");
		expect(result).not.toBeNull();
		expect(result).toContain("read");
		expect(result).toContain("task");
		expect(result).not.toContain("write");
	});

	it("circular reference detection: self-referencing inherit breaks cycle", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - write
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  cycle-agent:
    mcp:
      - augment
    tools:
      inherit: cycle-agent
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		// cycle-agent inherits from itself; cycle must break to default role tools
		const result = rolesConfig.getToolsForSubagent("cycle-agent");
		expect(result).not.toBeNull();
		expect(result).toContain("read");
		expect(result).toContain("write");
	});

	it("circular reference detection: mutual reference between two subagents", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  agent-a:
    mcp:
      - augment
    tools:
      inherit: agent-b
      add:
        - bash
  agent-b:
    mcp:
      - augment
    tools:
      inherit: agent-a
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		// Mutual reference must not infinite-loop; bash added after cycle breaks
		const result = rolesConfig.getToolsForSubagent("agent-a");
		expect(result).not.toBeNull();
		expect(result).toContain("bash");
	});

	it("unknown inherit name falls back to default role tools", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - grep
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  bad-inherit-agent:
    mcp:
      - augment
    tools:
      inherit: nonexistent-role-or-agent
      add:
        - bash
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		const result = rolesConfig.getToolsForSubagent("bad-inherit-agent");
		expect(result).not.toBeNull();
		// Falls back to default role, then applies add
		expect(result).toContain("read");
		expect(result).toContain("grep");
		expect(result).toContain("bash");
	});

	it("setToolsForSubagent / getToolsForSubagent round-trip with ToolsInheritConfig", async () => {
		await writeRoles(`roles:
  default:
    tools:
      - read
      - write
    mcp:
      - augment
    skills: all
subagents:
  _default:
    mcp:
      - augment
  my-agent:
    mcp:
      - augment
`);
		const { RolesConfig } = await loadRolesConfigModule();
		const rolesConfig = new RolesConfig(rolesPath);
		rolesConfig.setToolsForSubagent("my-agent", { inherit: "default", add: ["task"], remove: ["write"] });

		// Verify via fresh instance (proves persistence)
		const fresh = new RolesConfig(rolesPath);
		const result = fresh.getToolsForSubagent("my-agent");
		expect(result).not.toBeNull();
		expect(result).toContain("read");
		expect(result).toContain("task");
		expect(result).not.toContain("write");
	});
});

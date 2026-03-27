import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_ROLES_CONFIG,
	RolesConfig,
	type SkillConfig,
} from "@oh-my-pi/pi-coding-agent/config/roles-config";
import {
	loadSkillsWithConfig,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "../src/system-prompt";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSkill(
	name: string,
	mode: "auto" | "frontmatter" = "auto",
	content = `# ${name}\n\nFull content for ${name}.`,
): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: `/tmp/skills/${name}`,
		source: "test",
		mode,
		content,
	};
}

/** Construct the minimal tool map expected by buildSystemPrompt for a known main role. */
function createRoleTools(
	role: "default" | "orchestrator" | "plan" | "ask",
): Map<string, SystemPromptToolMetadata> {
	const roleTools = (DEFAULT_ROLES_CONFIG.roles[role] as { tools: string[] }).tools;
	return new Map(roleTools.map(name => [name, { label: name, description: `${name} test tool` }]));
}

// Reusable YAML stubs for roles.yml
const ROLES_YML_BASE = `\
roles:
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
`;

// ─── Test 1: Skill mode filtering pipeline ──────────────────────────────────

describe("agent config E2E: skill mode filtering pipeline", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-agent-config-e2e-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("loads auto skills from V2 role config via RolesConfig → loadSkillsWithConfig", async () => {
		await fs.writeFile(
			rolesPath,
			`\
roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      auto:
        - brainstorming
        - simplify
      frontmatter: []
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);

		const rolesConfig = new RolesConfig(rolesPath);
		const skillConfig = rolesConfig.getSkillConfigForRole("default");
		expect(skillConfig).toBeDefined();

		const allSkills = [makeSkill("brainstorming"), makeSkill("simplify"), makeSkill("commit-hygiene")];
		const result = await loadSkillsWithConfig(allSkills, skillConfig!);

		expect(result).toHaveLength(2);
		expect(result.find(s => s.name === "brainstorming")?.mode).toBe("auto");
		expect(result.find(s => s.name === "simplify")?.mode).toBe("auto");
		// commit-hygiene is absent from config → must be excluded
		expect(result.find(s => s.name === "commit-hygiene")).toBeUndefined();
	});

	it("loads frontmatter skills from V2 role config", async () => {
		await fs.writeFile(
			rolesPath,
			`\
roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      auto: []
      frontmatter:
        - commit-hygiene
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);

		const rolesConfig = new RolesConfig(rolesPath);
		const skillConfig = rolesConfig.getSkillConfigForRole("default");
		expect(skillConfig).toBeDefined();

		const allSkills = [makeSkill("brainstorming"), makeSkill("commit-hygiene")];
		const result = await loadSkillsWithConfig(allSkills, skillConfig!);

		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("commit-hygiene");
		expect(result[0]?.mode).toBe("frontmatter");
	});

	it("returns mixed auto and frontmatter modes from V2 config", async () => {
		await fs.writeFile(
			rolesPath,
			`\
roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      auto:
        - brainstorming
      frontmatter:
        - commit-hygiene
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);

		const rolesConfig = new RolesConfig(rolesPath);
		const skillConfig = rolesConfig.getSkillConfigForRole("default")!;

		const allSkills = [makeSkill("brainstorming"), makeSkill("commit-hygiene"), makeSkill("simplify")];
		const result = await loadSkillsWithConfig(allSkills, skillConfig);

		expect(result).toHaveLength(2);
		expect(result.find(s => s.name === "brainstorming")?.mode).toBe("auto");
		expect(result.find(s => s.name === "commit-hygiene")?.mode).toBe("frontmatter");
		// simplify absent from config → excluded
		expect(result.find(s => s.name === "simplify")).toBeUndefined();
	});
});

// ─── Test 2: System prompt rendering ────────────────────────────────────────

describe("agent config E2E: system prompt dual skill sections", () => {
	it("auto skills appear in '# Skills' section only", async () => {
		const skills = [makeSkill("brainstorming", "auto"), makeSkill("commit-hygiene", "frontmatter")];
		const prompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		const skillsIdx = prompt.indexOf("# Skills");
		const availableIdx = prompt.indexOf("# Available Skills");
		expect(skillsIdx).toBeGreaterThan(-1);
		expect(availableIdx).toBeGreaterThan(-1);

		// brainstorming must appear between the two section headers
		const skillsSection = prompt.slice(skillsIdx, availableIdx);
		expect(skillsSection).toContain("## brainstorming");
		expect(skillsSection).not.toContain("## commit-hygiene");
	});

	it("frontmatter skills appear in '# Available Skills' section only", async () => {
		const skills = [makeSkill("brainstorming", "auto"), makeSkill("commit-hygiene", "frontmatter")];
		const prompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		const availableIdx = prompt.indexOf("# Available Skills");
		expect(availableIdx).toBeGreaterThan(-1);

		// commit-hygiene must appear after the Available Skills header
		const afterAvailable = prompt.slice(availableIdx);
		expect(afterAvailable).toContain("## commit-hygiene");

		// and must NOT appear before it
		const beforeAvailable = prompt.slice(0, availableIdx);
		expect(beforeAvailable).not.toContain("## commit-hygiene");
	});

	it("omits '# Available Skills' section when there are no frontmatter skills", async () => {
		const skills = [makeSkill("brainstorming", "auto")];
		const prompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		expect(prompt).not.toContain("# Available Skills");
		expect(prompt).toContain("## brainstorming");
	});

	it("frontmatter skill does not appear in auto section even when auto section is present", async () => {
		const skills = [makeSkill("commit-hygiene", "frontmatter")];
		const prompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		// commit-hygiene is frontmatter — must not appear before Available Skills header
		expect(prompt).toContain("# Available Skills");
		const availableIdx = prompt.indexOf("# Available Skills");
		const beforeAvailable = prompt.slice(0, availableIdx);
		expect(beforeAvailable).not.toContain("## commit-hygiene");
	});
});

// ─── Test 3: Config persistence round-trip ──────────────────────────────────

describe("agent config E2E: config persistence round-trip", () => {
	let tempDir: string;
	let rolesPath: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-agent-config-persist-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		rolesPath = path.join(tempDir, "roles.yml");
		await fs.writeFile(rolesPath, ROLES_YML_BASE, "utf8");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("role skill config survives a fresh RolesConfig instance", () => {
		const config = new RolesConfig(rolesPath);
		config.setSkillConfigForRole("default", {
			auto: ["brainstorming", "simplify"],
			frontmatter: ["commit-hygiene"],
		});

		// A fresh instance reads from disk — must see the persisted data
		const fresh = new RolesConfig(rolesPath);
		const result = fresh.getSkillConfigForRole("default");

		expect(result).toBeDefined();
		expect(result?.auto).toEqual(["brainstorming", "simplify"]);
		expect(result?.frontmatter).toEqual(["commit-hygiene"]);
	});

	it("subagent skill config survives a fresh RolesConfig instance", () => {
		const config = new RolesConfig(rolesPath);
		config.setSkillConfigForSubagent("implement", { auto: ["simplify"], frontmatter: [] });

		const fresh = new RolesConfig(rolesPath);
		const result = fresh.getSkillConfigForSubagent("implement");

		expect(result).toBeDefined();
		expect(result?.auto).toEqual(["simplify"]);
		expect(result?.frontmatter).toEqual([]);
	});

	it("MCP config persists alongside skill config without conflict", () => {
		const config = new RolesConfig(rolesPath);
		config.setSkillConfigForRole("default", { auto: ["brainstorming"], frontmatter: [] });
		config.setMcpForSubagent("implement", ["augment", "better-context"]);

		const fresh = new RolesConfig(rolesPath);
		expect(fresh.getSkillConfigForRole("default")?.auto).toEqual(["brainstorming"]);
		expect(fresh.getMcpForSubagent("implement")).toContain("better-context");
	});
});

// ─── Test 4: mcp-filter V2 dual skill section filtering ────────────────────

/**
 * Invokes the real mcp-filter extension's before_agent_start handler against
 * the given system prompt and returns the filtered result.
 * Exercising the production code ensures regressions in the extension are caught.
 */
async function applyMcpFilterBeforeAgentStart(systemPrompt: string): Promise<string> {
	type HandlerFn = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
	const { default: mcpFilterExtension } = await import("../../../agent/extensions/mcp-filter/index");
	const handlers = new Map<string, HandlerFn[]>();
	mcpFilterExtension({
		on(event: string, handler: HandlerFn) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		logger: { debug() {} },
	} as unknown as Parameters<typeof mcpFilterExtension>[0]);

	const before = handlers.get("before_agent_start")?.[0];
	if (!before) throw new Error("before_agent_start handler not registered");

	const result = await before(
		{ type: "before_agent_start", prompt: "diagnose", systemPrompt },
		{ cwd: process.cwd(), sessionManager: { getEntries: () => [] } },
	) as { systemPrompt?: string } | undefined;
	return result?.systemPrompt ?? systemPrompt;
}

describe("agent config E2E: mcp-filter V2 dual skill section filtering", () => {
	const hadOriginalEnvAgentDir = Object.hasOwn(process.env, "PI_CODING_AGENT_DIR");
	const originalEnvAgentDir = process.env.PI_CODING_AGENT_DIR;
	let testAgentDir = "";

	beforeAll(async () => {
		testAgentDir = path.join(os.tmpdir(), `pi-e2e-mcp-filter-${Snowflake.next()}`);
		await fs.mkdir(testAgentDir, { recursive: true });
		// V2 skill config: default role has auto=['brainstorming'] and frontmatter=['commit-hygiene'].
		// Skills absent from either list (e.g. simplify) should be stripped by the extension.
		await fs.writeFile(
			path.join(testAgentDir, "roles.yml"),
			`\
roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills:
      auto:
        - brainstorming
      frontmatter:
        - commit-hygiene
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = testAgentDir;
	});

	afterAll(async () => {
		if (hadOriginalEnvAgentDir) {
			process.env.PI_CODING_AGENT_DIR = originalEnvAgentDir ?? "";
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (testAgentDir) {
			await fs.rm(testAgentDir, { recursive: true, force: true });
		}
	});

	it("V2 config: unlisted auto skill is stripped from # Skills section", async () => {
		// simplify is auto-mode but NOT in the V2 auto config → extension must remove it
		const skills = [
			makeSkill("brainstorming", "auto"),
			makeSkill("simplify", "auto"),
		];
		const rawPrompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		const filtered = await applyMcpFilterBeforeAgentStart(rawPrompt);

		// brainstorming is in V2 auto list → must survive
		expect(filtered).toContain("## brainstorming");
		// simplify is NOT in V2 auto list → must be removed
		expect(filtered).not.toContain("## simplify");
	});

	it("V2 config: unlisted frontmatter skill is stripped from # Available Skills section", async () => {
		// simplify is frontmatter-mode but NOT in the V2 frontmatter config → extension must remove it
		const skills = [
			makeSkill("commit-hygiene", "frontmatter"),
			makeSkill("simplify", "frontmatter"),
		];
		const rawPrompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		const filtered = await applyMcpFilterBeforeAgentStart(rawPrompt);

		// commit-hygiene is in V2 frontmatter list → must survive
		const availableIdx = filtered.indexOf("# Available Skills");
		expect(availableIdx).toBeGreaterThan(-1);
		const afterAvailable = filtered.slice(availableIdx);
		expect(afterAvailable).toContain("## commit-hygiene");
		// simplify is NOT in V2 frontmatter list → must be removed
		expect(afterAvailable).not.toContain("## simplify");
	});

	it("V2 config: auto and frontmatter sections are filtered independently", async () => {
		// brainstorming (auto) + commit-hygiene (frontmatter) are in config;
		// simplify (auto) + polish (frontmatter) are not — both must be stripped
		const skills = [
			makeSkill("brainstorming", "auto"),
			makeSkill("simplify", "auto"),
			makeSkill("commit-hygiene", "frontmatter"),
			makeSkill("polish", "frontmatter"),
		];
		const rawPrompt = await buildSystemPrompt({
			mode: "default",
			cwd: os.tmpdir(),
			tools: createRoleTools("default"),
			skills,
			rules: [],
		});

		const filtered = await applyMcpFilterBeforeAgentStart(rawPrompt);

		const skillsIdx = filtered.indexOf("# Skills");
		const availableIdx = filtered.indexOf("# Available Skills");

		const skillsSection = availableIdx > 0 ? filtered.slice(skillsIdx, availableIdx) : filtered.slice(skillsIdx);
		expect(skillsSection).toContain("## brainstorming");
		expect(skillsSection).not.toContain("## simplify");

		const afterAvailable = filtered.slice(availableIdx);
		expect(afterAvailable).toContain("## commit-hygiene");
		expect(afterAvailable).not.toContain("## polish");
	});
});

// ─── Test 5: Edge cases ──────────────────────────────────────────────────────

describe("agent config E2E: edge cases", () => {
	const baseSkills = [
		makeSkill("brainstorming"),
		makeSkill("commit-hygiene"),
		makeSkill("simplify"),
	];

	it("unknown skill name in config is silently excluded", async () => {
		const config: SkillConfig = { auto: ["unknown-xyz"], frontmatter: ["also-unknown"] };
		const result = await loadSkillsWithConfig(baseSkills, config);
		expect(result).toHaveLength(0);
	});

	it("empty skills config disables all skills", async () => {
		const config: SkillConfig = { auto: [], frontmatter: [] };
		const result = await loadSkillsWithConfig(baseSkills, config);
		expect(result).toHaveLength(0);
	});

	it("auto mode takes precedence when skill appears in both lists", async () => {
		const config: SkillConfig = { auto: ["brainstorming"], frontmatter: ["brainstorming"] };
		const result = await loadSkillsWithConfig(baseSkills, config);
		expect(result).toHaveLength(1);
		expect(result[0]?.mode).toBe("auto");
	});

	it("V1 'all' role config signals pass-through via undefined return from getSkillConfigForRole", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-edge-all-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(rolesPath, ROLES_YML_BASE, "utf8"); // uses skills: all
			const rolesConfig = new RolesConfig(rolesPath);

			// V1 "all" → undefined signals the caller to pass all skills through unfiltered
			expect(rolesConfig.getSkillConfigForRole("default")).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("V1 'none' role config is migrated to all-disabled V2 config", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-edge-none-"));
		const rolesPath = path.join(tempDir, "roles.yml");
		try {
			await fs.writeFile(
				rolesPath,
				`\
roles:
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
`,
				"utf8",
			);
			const rolesConfig = new RolesConfig(rolesPath);
			const skillConfig = rolesConfig.getSkillConfigForRole("default");

			// V1 "none" → migrated to empty V2 config (all skills disabled)
			expect(skillConfig).toBeDefined();
			expect(skillConfig?.auto).toEqual([]);
			expect(skillConfig?.frontmatter).toEqual([]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

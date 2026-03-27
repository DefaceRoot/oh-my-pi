import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type Skill } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

function makeSkill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: `/tmp/skills/${name}`,
		source: "custom",
		mode: "auto",
		content: `# ${name}\n\nFull content for ${name}.`,
	};
}

describe("createAgentSession subagent skill filtering", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-subagent-skills-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const createSkillFilteredSession = async (
		rolesYml: string,
		options: { startupRole?: string; role?: "explore" } = {},
	) => {
		fs.writeFileSync(path.join(tempDir, "roles.yml"), rolesYml, "utf8");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", options.startupRole ?? "default");

		return await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [makeSkill("default-only-skill"), makeSkill("explore-only-skill"), makeSkill("unused-skill")],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			...(options.role ? ({ role: options.role } as const) : {}),
		});
	};

	test("prefers subagent skill config for an explicit subagent role override", async () => {
		const { session } = await createSkillFilteredSession(
			[
				"roles:",
				"  default:",
				"    tools:",
				"      - read",
				"    mcp:",
				"      - augment",
				"    skills:",
				"      auto:",
				"        - default-only-skill",
				"      frontmatter: []",
				"subagents:",
				"  _default:",
				"    mcp:",
				"      - augment",
				"  explore:",
				"    mcp:",
				"      - augment",
				"    skills:",
				"      auto:",
				"        - explore-only-skill",
				"      frontmatter: []",
			].join("\n"),
			{ role: "explore" },
		);

		expect(session.systemPrompt).toContain("skill://explore-only-skill");
		expect(session.systemPrompt).not.toContain("skill://default-only-skill");
		expect(session.systemPrompt).not.toContain("skill://unused-skill");
	});

	test("falls back to default role skill config when a subagent override is absent", async () => {
		const { session } = await createSkillFilteredSession(
			[
				"roles:",
				"  default:",
				"    tools:",
				"      - read",
				"    mcp:",
				"      - augment",
				"    skills:",
				"      auto:",
				"        - default-only-skill",
				"      frontmatter: []",
				"subagents:",
				"  _default:",
				"    mcp:",
				"      - augment",
				"  explore:",
				"    mcp:",
				"      - augment",
			].join("\n"),
			{ role: "explore" },
		);

		expect(session.systemPrompt).toContain("skill://default-only-skill");
		expect(session.systemPrompt).not.toContain("skill://explore-only-skill");
		expect(session.systemPrompt).not.toContain("skill://unused-skill");
	});
});

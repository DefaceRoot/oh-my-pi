import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type MCPManager, type Skill } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

function createCustomTool(name: string, mcpServerName?: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name} ok` }] }),
		...(mcpServerName ? { mcpServerName, mcpToolName: name } : {}),
	};
}

function createFakeMcpManager(
	tools: Array<ReturnType<typeof createCustomTool>>,
	instructions: ReadonlyMap<string, string>,
): MCPManager {
	return {
		getTools: () => tools as never,
		getServerInstructions: (allowedServerNames?: readonly string[]) => {
			if (!allowedServerNames) return new Map(instructions);
			const allowed = new Set(allowedServerNames);
			return new Map(Array.from(instructions.entries()).filter(([name]) => allowed.has(name)));
		},
		getConnectedServers: () => Array.from(instructions.keys()),
		getServerPrompts: () => [],
		setOnToolsChanged: () => {},
		setOnPromptsChanged: () => {},
		setOnResourcesChanged: () => {},
	} as unknown as MCPManager;
}

describe("createAgentSession MCP proxy tool exposure", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-subagent-mcp-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("includes allowed MCP proxy tools in subagent tool list and prompt", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
				createCustomTool("helper"),
			],
		});

		const activeToolNames = session.getActiveToolNames();
		expect(activeToolNames).toContain("read");
		expect(activeToolNames).toContain("helper");
		expect(activeToolNames).toContain("mcp_augment_codebase_retrieval");
		expect(activeToolNames).toContain("mcp_grafana_list_datasources");
		expect(activeToolNames.filter(name => name.startsWith("mcp_")).sort()).toEqual([
			"mcp_augment_codebase_retrieval",
			"mcp_grafana_list_datasources",
		]);
		expect(session.systemPrompt).toContain("mcp_augment_codebase_retrieval");
		expect(session.systemPrompt).toContain("mcp_grafana_list_datasources");
	});

	test("uses role-based MCP defaults for subagent runtime roles", async () => {
		fs.writeFileSync(
			path.join(tempDir, "roles.yml"),
			`roles:
  default:
    tools:
      - read
    mcp:
      - augment
    skills: all
  explore:
    tools:
      - read
    mcp:
      - augment
      - better-context
    skills: all
subagents:
  _default:
    mcp:
      - augment
`,
			"utf8",
		);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_better_context_ask", "better-context"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
			],
			...({ role: "explore" } as any),
		});

		expect(
			session
				.getActiveToolNames()
				.filter(name => name.startsWith("mcp_"))
				.sort(),
		).toEqual(["mcp_augment_codebase_retrieval", "mcp_better_context_ask"]);
		expect(session.systemPrompt).toContain("mcp_better_context_ask");
		expect(session.systemPrompt).not.toContain("mcp_grafana_list_datasources");
	});

	test("keeps MCP proxy tools out of sessions with an explicit empty allowlist", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			mcpAllowlist: [],
			toolNames: ["read"],
			customTools: [
				createCustomTool("mcp_augment_codebase_retrieval", "augment"),
				createCustomTool("mcp_grafana_list_datasources", "grafana"),
				createCustomTool("helper"),
			],
		});

		const activeToolNames = session.getActiveToolNames();
		expect(activeToolNames).toContain("read");
		expect(activeToolNames).toContain("helper");
		expect(activeToolNames.filter(name => name.startsWith("mcp_")).sort()).toEqual([]);
		expect(session.systemPrompt).not.toContain("mcp_augment_codebase_retrieval");
		expect(session.systemPrompt).not.toContain("mcp_grafana_list_datasources");
	});

	test("injects inherited MCP server instructions for allowlisted subagent tools", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const inheritedTools = [
			createCustomTool("mcp_grafana_list_datasources", "grafana"),
			createCustomTool("mcp_chrome_devtools_list_pages", "chrome-devtools"),
		];
		const mcpManager = createFakeMcpManager(
			inheritedTools,
			new Map([
				["grafana", "Prefer summary-oriented Grafana tools first."],
				["chrome-devtools", "Validate visible UI outcomes after each action."],
			]),
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			mcpAllowlist: ["grafana"],
			mcpManager,
			customTools: inheritedTools,
		});

		expect(session.getActiveToolNames()).toContain("mcp_grafana_list_datasources");
		expect(session.getActiveToolNames()).not.toContain("mcp_chrome_devtools_list_pages");
		expect(session.systemPrompt).toContain("## MCP Server Instructions");
		expect(session.systemPrompt).toContain("### grafana");
		expect(session.systemPrompt).toContain("Prefer summary-oriented Grafana tools first.");
		expect(session.systemPrompt).not.toContain("### chrome-devtools");
	});

	test("records specialized subagent runtime roles in new sessions", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
			taskDepth: 1,
			toolNames: ["read"],
			...({ role: "code-reviewer" } as any),
		});

		expect(session.sessionManager.getLastModelChangeRole()).toBe("code-reviewer");
	});
});

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

	const makeSkill = (name: string): Skill => ({
		name,
		description: `${name} description`,
		filePath: `/tmp/skills/${name}/SKILL.md`,
		baseDir: `/tmp/skills/${name}`,
		source: "custom",
		mode: "auto",
		content: `# ${name}\n\nFull content for ${name}.`,
	});

	const createSkillFilteredSession = async (rolesYml: string) => {
		fs.writeFileSync(path.join(tempDir, "roles.yml"), rolesYml, "utf8");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "explore");

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
		});
	};

	test("prefers subagent skill config over default role config when building the system prompt", async () => {
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
		);

		expect(session.systemPrompt).toContain("skill://explore-only-skill");
		expect(session.systemPrompt).not.toContain("skill://default-only-skill");
		expect(session.systemPrompt).not.toContain("skill://unused-skill");
	});

	test("falls back to default role skill config when subagent config is absent", async () => {
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
		);

		expect(session.systemPrompt).toContain("skill://default-only-skill");
		expect(session.systemPrompt).not.toContain("skill://explore-only-skill");
		expect(session.systemPrompt).not.toContain("skill://unused-skill");
	});
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

type HandlerMap = Map<string, Array<(event: any, ctx: any) => any>>;

const hadOriginalEnvAgentDir = Object.prototype.hasOwnProperty.call(process.env, "PI_CODING_AGENT_DIR");
const originalEnvAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalResolvedAgentDir = getAgentDir();

const ROLES_YAML = `roles:
  default:
    tools:
      - read
    mcp:
      - augment
      - chrome-devtools
    skills: all
subagents:
  ask-explore:
    mcp: []
  _default:
    mcp:
      - augment
`;

let testAgentDir = "";

async function createRegisteredHandlers(): Promise<HandlerMap> {
	const { default: mcpFilterExtension } = await import("../../../../../agent/extensions/mcp-filter/index");
	const handlers: HandlerMap = new Map();
	mcpFilterExtension({
		on(event: string, handler: (event: any, ctx: any) => any) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		logger: {
			debug() {},
		},
	} as any);
	return handlers;
}

async function runBeforeAgentStart(handlers: HandlerMap, systemPrompt: string): Promise<void> {
	const before = handlers.get("before_agent_start")?.[0];
	if (!before) throw new Error("before_agent_start handler not registered");
	await before(
		{ type: "before_agent_start", prompt: "diagnose", systemPrompt },
		{ cwd: process.cwd(), sessionManager: { getEntries: () => [] } },
	);
}

describe("Phase 7 RED: mcp-filter roles config source of truth", () => {
	beforeAll(async () => {
		testAgentDir = path.join(os.tmpdir(), `pi-mcp-filter-roles-red-${Snowflake.next()}`);
		await fs.mkdir(testAgentDir, { recursive: true });
		await fs.writeFile(path.join(testAgentDir, "roles.yml"), ROLES_YAML, "utf8");
		setAgentDir(testAgentDir);
		process.env.PI_CODING_AGENT_DIR = testAgentDir;
	});

	afterAll(async () => {
		setAgentDir(originalResolvedAgentDir);
		if (hadOriginalEnvAgentDir) {
			process.env.PI_CODING_AGENT_DIR = originalEnvAgentDir ?? "";
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (testAgentDir) {
			await fs.rm(testAgentDir, { recursive: true, force: true });
		}
	});

	it("allows chrome-devtools for default role when enabled in roles config", async () => {
		const handlers = await createRegisteredHandlers();
		await runBeforeAgentStart(handlers, "BASE SYSTEM PROMPT");

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const result = await toolCall({ toolName: "mcp_chrome_devtools_list_pages" }, {});

		expect(result).toBeUndefined();
	});

	it("blocks better-context for default role when omitted from roles config", async () => {
		const handlers = await createRegisteredHandlers();
		await runBeforeAgentStart(handlers, "BASE SYSTEM PROMPT");

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const result = await toolCall({ toolName: "mcp_better_context_ask" }, {});

		expect(result).toEqual({
			block: true,
			reason: "This MCP tool is not available for this agent role.",
		});
	});

	it("keeps ask-explore restricted when roles config has empty allowlist", async () => {
		const handlers = await createRegisteredHandlers();
		await runBeforeAgentStart(handlers, "name: ask-explore\nYou are operating on a delegated sub-task.");

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const result = await toolCall({ toolName: "mcp_chrome_devtools_click" }, {});

		expect(result).toEqual({
			block: true,
			reason: "MCP tools are not available for this agent role.",
		});
	});
});

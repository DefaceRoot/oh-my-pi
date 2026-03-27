import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

type HandlerMap = Map<string, Array<(event: any, ctx: any) => any>>;

const hadOriginalEnvAgentDir = Object.hasOwn(process.env, "PI_CODING_AGENT_DIR");
const originalEnvAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalResolvedAgentDir = getAgentDir();

const ROLES_YAML = `roles:
  default:
    tools:
      - read
    mcp:
      - augment
      - chrome-devtools
    disabledTools:
      - mcp_chrome_devtools_click
    skills: all
subagents:
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
		logger: { debug() {} },
	} as any);
	return handlers;
}

describe("mcp-filter disabled MCP tools", () => {
	beforeAll(async () => {
		testAgentDir = path.join(os.tmpdir(), `pi-mcp-filter-disabled-${Snowflake.next()}`);
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

	test("strips disabled tools from prompt blocks and blocks exact tool calls", async () => {
		const handlers = await createRegisteredHandlers();
		const before = handlers.get("before_agent_start")?.[0];
		if (!before) throw new Error("before_agent_start handler not registered");

		const result = await before(
			{
				type: "before_agent_start",
				prompt: "diagnose",
				systemPrompt:
					'<function>{"name":"mcp_chrome_devtools_click","description":"click","parameters":{}}</function>\n' +
					'<function>{"name":"mcp_chrome_devtools_list_pages","description":"list","parameters":{}}</function>\n',
			},
			{ cwd: process.cwd(), sessionManager: { getEntries: () => [] } },
		);

		expect(result?.systemPrompt).not.toContain("mcp_chrome_devtools_click");
		expect(result?.systemPrompt).toContain("mcp_chrome_devtools_list_pages");

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const toolCtx = { cwd: process.cwd(), sessionManager: { getEntries: () => [] } };
		expect(await toolCall({ toolName: "mcp_chrome_devtools_click" }, toolCtx)).toEqual({
			block: true,
			reason: "This MCP tool is not available for this agent role.",
		});
		expect(await toolCall({ toolName: "mcp_chrome_devtools_list_pages" }, toolCtx)).toBeUndefined();
	});
});

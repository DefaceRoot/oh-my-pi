import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "../../config/prompt-templates";
import { parseFrontmatter } from "../../utils/frontmatter";
import subagentSystemPromptTemplate from "../../prompts/system/subagent-system-prompt.md" with { type: "text" };
import mcpFilterExtension from "../../../../../agent/extensions/mcp-filter/index";

const REPO_ROOT = new URL("../../../../../", import.meta.url);

type HandlerMap = Map<string, Array<(event: any, ctx: any) => any>>;

function createRegisteredHandlers(): HandlerMap {
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

async function renderSubagentPrompt(agentName: string): Promise<string> {
	const content = await Bun.file(new URL(`agent/agents/${agentName}.md`, REPO_ROOT)).text();
	const { body } = parseFrontmatter(content, { location: agentName, level: "fatal" });
	return renderPromptTemplate(subagentSystemPromptTemplate, {
		base: "BASE SYSTEM PROMPT",
		agent: body,
		worktree: "",
		contextFile: undefined,
		outputSchema: undefined,
	});
}

async function runBeforeAgentStart(handlers: HandlerMap, systemPrompt: string): Promise<void> {
	const before = handlers.get("before_agent_start")?.[0];
	if (!before) throw new Error("before_agent_start handler not registered");
	await before(
		{ type: "before_agent_start", prompt: "diagnose", systemPrompt },
		{ sessionManager: { getEntries: () => [] } },
	);
}

describe("mcp-filter agent role detection", () => {
	it("allows Grafana MCP tools for grafana subagent prompts", async () => {
		const handlers = createRegisteredHandlers();
		await runBeforeAgentStart(handlers, await renderSubagentPrompt("grafana"));

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const result = await toolCall({ toolName: "mcp_grafana_list_datasources" }, {});

		expect(result).toBeUndefined();
	});

	it("blocks MCP tools for ask-explore subagent prompts", async () => {
		const handlers = createRegisteredHandlers();
		await runBeforeAgentStart(handlers, await renderSubagentPrompt("ask-explore"));

		const toolCall = handlers.get("tool_call")?.[0];
		if (!toolCall) throw new Error("tool_call handler not registered");
		const result = await toolCall({ toolName: "mcp_augment_codebase_retrieval" }, {});

		expect(result).toEqual({
			block: true,
			reason: "MCP tools are not available for this agent role.",
		});
	});
});

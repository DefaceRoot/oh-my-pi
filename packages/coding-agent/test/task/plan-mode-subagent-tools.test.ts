import { describe, expect, it } from "bun:test";
import { PLAN_MODE_SUBAGENT_TOOLS } from "../../src/task/plan-mode-tools";

describe("PLAN_MODE_SUBAGENT_TOOLS", () => {
	it("keeps delegated plan-mode subagents read-only but capable of structural and deep research", () => {
		expect(PLAN_MODE_SUBAGENT_TOOLS).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"lsp",
			"fetch",
			"web_search",
			"web_search_deep",
			"web_search_code_context",
			"web_search_crawl",
			"ast_grep",
		]);
	});
});

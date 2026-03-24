export const PLAN_MODE_SUBAGENT_TOOLS = [
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
] as const;

/**
 * Plan-mode verification needs to write artifacts beside the plan without opening the full repo for writes.
 */
export const PLAN_MODE_PLAN_VERIFIER_TOOLS = [
	"read",
	"grep",
	"find",
	"lsp",
	"fetch",
	"web_search",
	"web_search_deep",
	"web_search_code_context",
	"web_search_crawl",
	"ast_grep",
	"write",
] as const;

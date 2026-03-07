import { describe, expect, it } from "bun:test";
import { enrichModelThinking } from "@oh-my-pi/pi-ai/model-thinking";
import { type RequestBody, transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { parseCodexError } from "@oh-my-pi/pi-ai/providers/openai-codex/response-handler";
import type { Model } from "@oh-my-pi/pi-ai/types";

const DEFAULT_PROMPT_PREFIX =
	"You are an expert coding assistant. You help users with coding tasks by reading files, executing commands";

function createCodexModel(id: string): Model<"openai-codex-responses"> {
	return enrichModelThinking({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("openai-codex request transformer", () => {
	it("filters item_reference and strips ids", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
			input: [
				{
					type: "message",
					role: "developer",
					id: "sys-1",
					content: [{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }],
				},
				{
					type: "message",
					role: "user",
					id: "user-1",
					content: [{ type: "input_text", text: "hello" }],
				},
				{ type: "item_reference", id: "ref-1" },
				{ type: "function_call_output", call_id: "missing", name: "tool", output: "result" },
			],
			tools: [{ type: "function", name: "tool", description: "", parameters: {} }],
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {});

		expect(transformed.store).toBe(false);
		expect(transformed.stream).toBe(true);
		expect(transformed.include).toEqual(["reasoning.encrypted_content"]);

		const input = transformed.input || [];
		expect(input.some(item => item.type === "item_reference")).toBe(false);
		expect(input.some(item => "id" in item)).toBe(false);
		const first = input[0];
		expect(first?.type).toBe("message");
		expect(first?.role).toBe("developer");
		expect(first?.content).toEqual([{ type: "input_text", text: `${DEFAULT_PROMPT_PREFIX}...` }]);

		const orphaned = input.find(item => item.type === "message" && item.role === "assistant");
		expect(orphaned?.content).toMatch(/Previous tool result/);
	});
});

describe("openai-codex reasoning effort validation", () => {
	it("clamps gpt-5.1 xhigh to high when metadata excludes xhigh", async () => {
		const body: RequestBody = { model: "gpt-5.1", input: [] };
		const transformed = await transformRequestBody(body, createCodexModel(body.model), { reasoningEffort: "xhigh" });
		expect(transformed.reasoning).toEqual({ effort: "high", summary: "detailed" });
	});

	it("clamps unsupported Codex mini efforts to the nearest supported level", async () => {
		const body: RequestBody = { model: "gpt-5.1-codex-mini", input: [] };

		const low = await transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "low" });
		expect(low.reasoning).toEqual({ effort: "medium", summary: "detailed" });

		const xhigh = await transformRequestBody({ ...body }, createCodexModel(body.model), { reasoningEffort: "xhigh" });
		expect(xhigh.reasoning).toEqual({ effort: "high", summary: "detailed" });
	});

	it("keeps xhigh for gpt-5.4-codex where the model supports it", async () => {
		const body: RequestBody = { model: "gpt-5.4-codex", input: [] };
		const transformed = await transformRequestBody(body, createCodexModel(body.model), { reasoningEffort: "xhigh" });
		expect(transformed.reasoning).toEqual({ effort: "xhigh", summary: "detailed" });
	});
});

describe("openai-codex error parsing", () => {
	it("produces friendly usage-limit messages and rate limits", async () => {
		const resetAt = Math.floor(Date.now() / 1000) + 600;
		const response = new Response(
			JSON.stringify({
				error: { code: "usage_limit_reached", plan_type: "Plus", resets_at: resetAt },
			}),
			{
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "99",
					"x-codex-primary-window-minutes": "60",
					"x-codex-primary-reset-at": String(resetAt),
				},
			},
		);

		const info = await parseCodexError(response);
		expect(info.friendlyMessage?.toLowerCase()).toContain("usage limit");
		expect(info.rateLimits?.primary?.used_percent).toBe(99);
	});
});

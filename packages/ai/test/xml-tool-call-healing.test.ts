import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Model, Tool, ToolCall } from "../src/types";
import { modelMayLeakXmlToolCalls } from "../src/utils/stream-markup-healing";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

interface SseToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
	content?: string;
	tool_calls?: SseToolCallDelta[];
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: SseChoiceDelta;
		finish_reason?: "stop" | "tool_calls" | "length" | "content_filter" | null;
	}>;
}

function sseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function mockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): typeof fetch {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => sseResponse(events);
	return Object.assign(fn, { preconnect: originalFetch.preconnect });
}

function baseContext(tools?: Tool[]): Context {
	return {
		messages: [{ role: "user", content: "run pwd", timestamp: Date.now() }],
		...(tools ? { tools } : {}),
	};
}

function bareXmlTools(): Tool[] {
	return [
		{
			name: "find",
			description: "Find files",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					pattern: { type: "string" },
				},
				required: ["path", "pattern"],
			},
		},
		{
			name: "read",
			description: "Read files",
			parameters: {
				type: "object",
				properties: {
					limit: { type: "number" },
					paths: { type: "array", items: { type: "string" } },
				},
				required: ["limit", "paths"],
			},
		},
	];
}

function xmlLeakModel(): Model<"openai-completions"> {
	return getBundledModel("cerebras", "zai-glm-4.6");
}

function deepSeekLeakModel(): Model<"openai-completions"> {
	return getBundledModel("opencode-go", "deepseek-v4-flash");
}

function chunk(model: string, delta: SseChoiceDelta, finish: SseChunk["choices"][0]["finish_reason"] = null): SseChunk {
	return {
		id: "chatcmpl-xml-healing-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function resultText(result: AssistantMessage): string {
	const textBlocks = result.content.filter(
		(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
	);
	return textBlocks.map(block => block.text).join("");
}

function resultToolCalls(result: AssistantMessage): ToolCall[] {
	return result.content.filter((block): block is ToolCall => block.type === "toolCall");
}

describe("OpenAI-completions XML/Claude-style tool-call healing", () => {
	const model = xmlLeakModel();

	it("gates XML healing to known Z.AI/Cerebras GLM model IDs", () => {
		expect(modelMayLeakXmlToolCalls("cerebras", "zai-glm-4.7")).toBe(true);
		expect(modelMayLeakXmlToolCalls("cerebras", "llama-4")).toBe(false);
		expect(modelMayLeakXmlToolCalls("other", "some-glm-model")).toBe(false);
		expect(modelMayLeakXmlToolCalls("other", "foo-z-ai-glm-bar")).toBe(false);

		expect(modelMayLeakXmlToolCalls("opencode-go", "deepseek-v4-flash")).toBe(true);
		expect(modelMayLeakXmlToolCalls("anything", "deepseek-v4-pro")).toBe(true);
	});
	it("strips <claude_internal><function_calls> envelopes from visible text and synthesizes a tool call", async () => {
		const leaked =
			"<claude_internal><function_calls>" +
			'<invoke name="bash"><parameter name="command">pwd</parameter></invoke>' +
			"</function_calls></claude_internal>";

		global.fetch = mockFetch([
			chunk(model.id, { content: "Running now: " }),
			chunk(model.id, { content: leaked }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("Running now: ");
		expect(text).not.toContain("<claude_internal>");
		expect(text).not.toContain("<function_calls>");
		expect(text).not.toContain("<invoke");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toEqual({ command: "pwd" });
	});

	it("heals a split <claude_internal><function_calls><invoke ...> envelope across chunk boundaries", async () => {
		const leaked =
			"<claude_internal><function_calls>" +
			'<invoke name="bash"><parameter name="command">pwd</parameter></invoke>' +
			"</function_calls></claude_internal>";
		const splitToken = '<invoke name="bash">';
		const first = leaked.slice(0, leaked.indexOf(splitToken) + "<inv".length);
		const second = leaked.slice(first.length);
		expect(first.endsWith("<inv")).toBe(true);
		expect(first + second).toBe(leaked);

		global.fetch = mockFetch([
			chunk(model.id, { content: first }),
			chunk(model.id, { content: second }),
			chunk(model.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toEqual({ command: "pwd" });
	});

	it("heals DeepSeek V4 bare tool-name XML envelopes from one chunk", async () => {
		const deepSeekModel = deepSeekLeakModel();
		const leaked = "<find>\n<path>x</path>\n<pattern>*</pattern>\n</find>";

		global.fetch = mockFetch([
			chunk(deepSeekModel.id, { content: leaked }),
			chunk(deepSeekModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(deepSeekModel, baseContext(bareXmlTools()), {
			apiKey: "test-key",
		}).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("find");
		expect(toolCalls[0].arguments).toEqual({ path: "x", pattern: "*" });
	});

	it("heals DeepSeek V4 bare tool-name XML envelopes split across chunks", async () => {
		const deepSeekModel = deepSeekLeakModel();

		global.fetch = mockFetch([
			chunk(deepSeekModel.id, { content: "<find>\n<pa" }),
			chunk(deepSeekModel.id, { content: "th>x</path>\n<pattern>*</pattern>\n</fi" }),
			chunk(deepSeekModel.id, { content: "nd>" }),
			chunk(deepSeekModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(deepSeekModel, baseContext(bareXmlTools()), {
			apiKey: "test-key",
		}).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("find");
		expect(toolCalls[0].arguments).toEqual({ path: "x", pattern: "*" });
	});

	it("coerces DeepSeek V4 bare XML numeric and structured parameters", async () => {
		const deepSeekModel = deepSeekLeakModel();
		const leaked = '<read>\n<limit>40</limit>\n<paths>["a.ts","b.ts"]</paths>\n</read>';

		global.fetch = mockFetch([
			chunk(deepSeekModel.id, { content: leaked }),
			chunk(deepSeekModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(deepSeekModel, baseContext(bareXmlTools()), {
			apiKey: "test-key",
		}).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ limit: 40, paths: ["a.ts", "b.ts"] });
	});

	it("passes unmatched DeepSeek V4 bare XML tags through unchanged", async () => {
		const deepSeekModel = deepSeekLeakModel();
		const prose = "Keep this literal XML: <random>\n<path>x</path>\n</random>";

		global.fetch = mockFetch([
			chunk(deepSeekModel.id, { content: prose }),
			chunk(deepSeekModel.id, {}, "stop"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(deepSeekModel, baseContext(bareXmlTools()), {
			apiKey: "test-key",
		}).result();

		expect(resultText(result)).toBe(prose);
		expect(resultToolCalls(result)).toHaveLength(0);
	});

	it("heals <tool_call><tool_name> envelopes into one tool call", async () => {
		const leaked =
			"<tool_call>" +
			"<tool_name>bash</tool_name>" +
			'<tool_parameters>{"command":"pwd"}</tool_parameters>' +
			"</tool_call>";

		global.fetch = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).toBe("");
		expect(text).not.toContain("<tool_call>");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toEqual({ command: "pwd" });
	});

	it("passes XML-looking prose that is not a known complete envelope through unchanged", async () => {
		const prose = 'Explain this literal XML: <invoke name="bash">pwd';

		global.fetch = mockFetch([chunk(model.id, { content: prose }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);

		expect(text).toBe(prose);
		expect(result.content.some(block => block.type === "toolCall")).toBe(false);
		expect(result.stopReason).toBe("stop");
	});

	it("preserves literal prose ending with an unconfirmed partial XML opening prefix at final flush", async () => {
		const prose = "Explain <tool_ca";

		global.fetch = mockFetch([chunk(model.id, { content: prose }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();

		expect(resultText(result)).toBe(prose);
		expect(resultToolCalls(result)).toHaveLength(0);
		expect(result.stopReason).toBe("stop");
	});

	it("drops incomplete recognized <invoke> envelopes that already include <parameter>", async () => {
		const leaked = '<invoke name="bash"><parameter name="command">pwd';

		global.fetch = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);

		expect(text).toBe("");
		expect(text).not.toContain("<invoke");
		expect(resultToolCalls(result)).toHaveLength(0);
		expect(result.stopReason).toBe("stop");
	});
	it("strips leaked XML when structured delta.tool_calls are present and does not duplicate calls", async () => {
		const leaked =
			"<tool_call>" +
			"<tool_name>bash</tool_name>" +
			'<tool_parameters>{"command":"pwd"}</tool_parameters>' +
			"</tool_call>";

		global.fetch = mockFetch([
			chunk(model.id, {
				content: leaked,
				tool_calls: [
					{
						index: 0,
						id: "call_structured_xml_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"pwd"}' },
					},
				],
			}),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		const text = resultText(result);
		const toolCalls = resultToolCalls(result);

		expect(text).not.toContain("<tool_call>");
		expect(text).not.toContain("<tool_name>");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].id).toBe("call_structured_xml_1");
		expect(toolCalls[0].name).toBe("bash");
		expect(toolCalls[0].arguments).toEqual({ command: "pwd" });
		expect(result.stopReason).toBe("toolUse");
	});

	it("promotes healed calls to stopReason=toolUse only when provider finish_reason is stop", async () => {
		const leaked =
			"<tool_call>" +
			"<tool_name>bash</tool_name>" +
			'<tool_parameters>{"command":"pwd"}</tool_parameters>' +
			"</tool_call>";

		global.fetch = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);
		const healedStop = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(resultToolCalls(healedStop)).toHaveLength(1);
		expect(healedStop.stopReason).toBe("toolUse");

		global.fetch = mockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "content_filter"), "[DONE]"]);
		const healedError = await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key" }).result();
		expect(resultToolCalls(healedError)).toHaveLength(1);
		expect(healedError.stopReason).toBe("error");
		expect(healedError.errorMessage).toContain("content_filter");
	});
});

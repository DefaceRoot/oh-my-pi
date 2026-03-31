import { describe, expect, it } from "bun:test";
import { getTemperatureBounds } from "@oh-my-pi/pi-ai";

describe("getTemperatureBounds", () => {
	describe("known applicable APIs", () => {
		it("returns 0\u20131 for anthropic-messages", () => {
			const result = getTemperatureBounds("anthropic-messages");
			expect(result).toEqual({ applicable: true, min: 0, max: 1 });
		});

		it("returns 0\u20132 for openai-responses", () => {
			const result = getTemperatureBounds("openai-responses");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20132 for openai-completions", () => {
			const result = getTemperatureBounds("openai-completions");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20132 for azure-openai-responses", () => {
			const result = getTemperatureBounds("azure-openai-responses");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20131 for bedrock-converse-stream", () => {
			const result = getTemperatureBounds("bedrock-converse-stream");
			expect(result).toEqual({ applicable: true, min: 0, max: 1 });
		});

		it("returns 0\u20132 for google-generative-ai", () => {
			const result = getTemperatureBounds("google-generative-ai");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20132 for google-gemini-cli", () => {
			const result = getTemperatureBounds("google-gemini-cli");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20132 for google-vertex", () => {
			const result = getTemperatureBounds("google-vertex");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});

		it("returns 0\u20132 for cursor-agent", () => {
			const result = getTemperatureBounds("cursor-agent");
			expect(result).toEqual({ applicable: true, min: 0, max: 2 });
		});
	});

	describe("non-applicable API", () => {
		it("returns applicable:false for openai-codex-responses (reasoning-only)", () => {
			const result = getTemperatureBounds("openai-codex-responses");
			expect(result).toEqual({ applicable: false });
		});
	});

	describe("unknown and extension APIs", () => {
		it("returns applicable:false for unknown extension API strings", () => {
			expect(getTemperatureBounds("vertex-claude-api")).toEqual({ applicable: false });
			expect(getTemperatureBounds("some-custom-provider")).toEqual({ applicable: false });
		});

		it("returns applicable:false for prototype-property strings", () => {
			expect(getTemperatureBounds("toString")).toEqual({ applicable: false });
			expect(getTemperatureBounds("__proto__")).toEqual({ applicable: false });
			expect(getTemperatureBounds("constructor")).toEqual({ applicable: false });
			expect(getTemperatureBounds("hasOwnProperty")).toEqual({ applicable: false });
		});
	});
});

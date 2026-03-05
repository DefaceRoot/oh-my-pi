import { describe, expect, it } from "bun:test";
import { MODEL_ROLE_IDS, MODEL_ROLES } from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";

const availableModels = [
	{
		provider: "openai-codex",
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-codex-responses",
		reasoning: true,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
];
describe("ask role in model registry", () => {
	it("ask role is present in MODEL_ROLES", () => {
		expect(MODEL_ROLES.ask).toBeDefined();
		expect(MODEL_ROLES.ask.description).toBe("Model for Ask Agent (read-only research mode)");
	});

	it("ask role appears in role list used by /model picker", () => {
		expect(MODEL_ROLE_IDS).toContain("ask");
	});

	it("falls back to default role model when ask role is not configured", () => {
		const settings = {
			getModelRole: (role: string) => (role === "default" ? "openai-codex/gpt-5.3-codex" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/ask", availableModels, { settings });

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.3-codex");
	});
});

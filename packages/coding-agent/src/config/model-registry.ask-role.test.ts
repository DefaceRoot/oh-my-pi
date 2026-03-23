import { describe, expect, it } from "bun:test";
import {
	MODEL_ROLE_CATEGORIES,
	MODEL_ROLE_IDS,
	MODEL_ROLE_IDS_BY_CATEGORY,
	MODEL_ROLES,
	type ModelRoleCategory,
} from "./model-registry";
import { resolveModelRoleValue } from "./model-resolver";

const availableModels = [
	{
		provider: "openai-codex",
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-codex-responses",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"] as ("image" | "text")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
];
describe("model roles in model registry", () => {
	it("ask role is present in MODEL_ROLES", () => {
		expect(MODEL_ROLES.ask).toBeDefined();
		expect(MODEL_ROLES.ask.description).toBe("Model for Ask Agent (read-only research mode)");
	});

	it("ask role appears in role list used by /model picker", () => {
		expect(MODEL_ROLE_IDS).toContain("ask");
	});

	it("grafana role is present in MODEL_ROLES", () => {
		expect(MODEL_ROLES.grafana).toBeDefined();
		expect(MODEL_ROLES.grafana.description).toBe("Model for Grafana monitoring subagent");
	});

	it("grafana role appears in role list used by /model picker", () => {
		expect(MODEL_ROLE_IDS).toContain("grafana");
	});

	it("debug role is present in MODEL_ROLES with captain category", () => {
		expect(MODEL_ROLES.debug).toBeDefined();
		expect(MODEL_ROLES.debug.tag).toBe("DEBUG");
		expect(MODEL_ROLES.debug.category).toBe("captain");
	});

	it("debug role appears in role list used by /model picker", () => {
		expect(MODEL_ROLE_IDS).toContain("debug");
	});

	it("every MODEL_ROLES entry has a valid category", () => {
		const validCategories: ModelRoleCategory[] = ["core", "captain", "crew"];
		for (const role of MODEL_ROLE_IDS) {
			const info = MODEL_ROLES[role];
			expect(validCategories).toContain(info.category);
		}
	});

	it("MODEL_ROLE_CATEGORIES defines all three tiers", () => {
		expect(MODEL_ROLE_CATEGORIES.core).toBeDefined();
		expect(MODEL_ROLE_CATEGORIES.captain).toBeDefined();
		expect(MODEL_ROLE_CATEGORIES.crew).toBeDefined();
		expect(MODEL_ROLE_CATEGORIES.core.label).toBe("Core");
		expect(MODEL_ROLE_CATEGORIES.captain.label).toBe("Captains");
		expect(MODEL_ROLE_CATEGORIES.crew.label).toBe("Crew");
	});

	it("MODEL_ROLE_IDS_BY_CATEGORY groups all roles without loss", () => {
		const allGrouped = [
			...MODEL_ROLE_IDS_BY_CATEGORY.core,
			...MODEL_ROLE_IDS_BY_CATEGORY.captain,
			...MODEL_ROLE_IDS_BY_CATEGORY.crew,
		];
		expect(allGrouped.sort()).toEqual([...MODEL_ROLE_IDS].sort());
	});

	it("core category contains the four user-facing roles", () => {
		expect(MODEL_ROLE_IDS_BY_CATEGORY.core).toEqual(["default", "ask", "orchestrator", "plan"]);
	});

	it("captain category contains domain specialists", () => {
		expect(MODEL_ROLE_IDS_BY_CATEGORY.captain).toContain("implement");
		expect(MODEL_ROLE_IDS_BY_CATEGORY.captain).toContain("designer");
		expect(MODEL_ROLE_IDS_BY_CATEGORY.captain).toContain("debug");
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

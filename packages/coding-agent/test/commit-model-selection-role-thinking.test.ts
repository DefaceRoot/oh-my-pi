import { describe, expect, it } from "bun:test";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { resolveCommitRoleModel, resolvePrimaryModel } from "../src/commit/model-selection";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
		setModelRole(role: string, value: string) {
			modelRoles[role] = value;
		},
		get(path: string) {
			if (path === "modelRoles") return modelRoles;
			return undefined;
		},
	} as never;
}

describe("commit role thinking selection", () => {
	it("uses explicit thinking for the commit role", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:low`,
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getApiKey: async () => "test-key",
		};

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(commitModel.id);
		expect(primary.thinkingLevel).toBe(Effort.Low);
	});

	it("falls back to the explore role when the commit role key is unavailable", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:low`,
			explore: "pi/default:minimal",
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getApiKey: async (model: { id: string }) => (model.id === defaultModel.id ? "explore-key" : undefined),
		};

		const resolved = await resolveCommitRoleModel(settings, registry, commitModel, "fallback-key");
		expect(resolved.model.id).toBe(defaultModel.id);
		expect(resolved.apiKey).toBe("explore-key");
		expect(resolved.thinkingLevel).toBe(Effort.Minimal);
	});
});

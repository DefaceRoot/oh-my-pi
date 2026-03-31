import { describe, expect, it } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function getAnthropicModelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

describe("Settings model role resolution", () => {
	it("falls back to an available model when a configured alias is temporarily unresolved", () => {
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const defaultModel = getAnthropicModelOrThrow("claude-opus-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);
		settings.setModelRole("explore", "pi/task");
		const modelRegistry = {
			getAvailable: () => [],
			getAll: () => [fallbackModel, defaultModel],
		} as unknown as ModelRegistry;

		expect(settings.getResolvedModelRoles(modelRegistry)).toMatchObject({
			default: `${defaultModel.provider}/${defaultModel.id}`,
			explore: `${fallbackModel.provider}/${fallbackModel.id}`,
		});
	});
});

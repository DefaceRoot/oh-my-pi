import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
}

function getAnthropicModelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

async function createSelectorFixture() {
	const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
	const planModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

	const settings = Settings.isolated({
		modelRoles: {
			default: `${defaultModel.provider}/${defaultModel.id}`,
			plan: `${planModel.provider}/${planModel.id}:high`,
		},
	});

	const modelRegistry = {
		getAll: () => [defaultModel, planModel],
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const onSelect = vi.fn();
	const setModelRoleSpy = vi.spyOn(settings, "setModelRole");

	const selector = new ModelSelectorComponent(
		ui,
		defaultModel,
		settings,
		modelRegistry,
		[
			{ model: defaultModel, thinkingLevel: "off" },
			{ model: planModel, thinkingLevel: "off" },
		],
		onSelect,
		() => {},
	);

	await Bun.sleep(0);
	return { selector, onSelect, setModelRoleSpy };
}

describe("Phase 3 RED: /model MCP step", () => {
	beforeAll(() => {
		initTheme();
	});

	test("requires MCP selection before finalizing role assignment", async () => {
		const { selector, onSelect, setModelRoleSpy } = await createSelectorFixture();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(normalizeRenderedText(selector.render(220).join("\n"))).toContain("Thinking for: Default (claude-sonnet-4-6)");

		selector.handleInput("\n");
		const afterThinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(afterThinkingRendered).toContain("MCP");
		expect(setModelRoleSpy).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledTimes(0);
	});
});

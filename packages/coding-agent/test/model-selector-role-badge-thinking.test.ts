import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return (
		text
			// strip ANSI escapes
			.replace(/\x1b\[[0-9;]*m/g, "")
			// collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

function getAnthropicModelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

interface SelectorFixture {
	selector: ModelSelectorComponent;
	onSelect: ReturnType<typeof vi.fn>;
	defaultModel: Model;
	planModel: Model;
	settings: Settings;
	setModelRoleSpy: ReturnType<typeof vi.spyOn>;
}

async function createSelectorFixture(options?: { temporaryOnly?: boolean }): Promise<SelectorFixture> {
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
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;
	const onSelect: ReturnType<typeof vi.fn> = vi.fn();
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
		options,
	);

	await Bun.sleep(0);

	return { selector, onSelect, defaultModel, planModel, settings, setModelRoleSpy };
}

describe("ModelSelector role-first persistent flow", () => {
	beforeAll(() => {
		initTheme();
	});

	test("renders role list with assigned provider/model and thinking labels", async () => {
		const { selector } = await createSelectorFixture();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("Model Roles");
		expect(rendered).toMatch(/DEFAULT\s+Default.*anthropic\/claude-sonnet-4-5.*\(inherit\)/);
		expect(rendered).toMatch(/PLAN\s+Architect.*anthropic\/claude-sonnet-4-6.*\(high\)/);
	});

	test("enter on a role opens model browsing scoped to that role", async () => {
		const { selector } = await createSelectorFixture();

		selector.handleInput("\n");
		const browsingRendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(browsingRendered).toContain("Editing Default");
		expect(browsingRendered).toContain("Current: anthropic/claude-sonnet-4-5 (inherit)");
		expect(browsingRendered).toContain("claude-sonnet-4-5");
		expect(browsingRendered).toContain("claude-sonnet-4-6");
		expect(browsingRendered).toContain("tab/←/→ providers up/down models enter choose esc back");
	});

	test("model selection keeps the entered role and does not reprompt for role", async () => {
		const { selector, onSelect, planModel, setModelRoleSpy } = await createSelectorFixture();

		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		const thinkingRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(thinkingRendered).toContain("Thinking for: Default (claude-sonnet-4-6)");

		selector.handleInput("\n");
		const postSelectionRendered = normalizeRenderedText(selector.render(220).join("\n"));

		expect(postSelectionRendered).toContain("Model Roles");
		expect(postSelectionRendered).toMatch(/DEFAULT\s+Default.*anthropic\/claude-sonnet-4-6.*\(inherit\)/);
		expect(setModelRoleSpy).toHaveBeenCalledWith("default", "anthropic/claude-sonnet-4-6");

		expect(onSelect).toHaveBeenCalledTimes(1);
		const [selectedModel, selectedRole] = onSelect.mock.calls[0] ?? [];
		expect(selectedModel).toBe(planModel);
		expect(selectedRole).toBe("default");
	});

	test("temporary-only selector remains direct model-first selection", async () => {
		const { selector, onSelect, defaultModel, planModel, setModelRoleSpy } = await createSelectorFixture({
			temporaryOnly: true,
		});

		const initialRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(initialRendered).toContain("Providers:");
		expect(initialRendered).toContain("tab/←/→ providers up/down models enter select esc cancel");

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(setModelRoleSpy).not.toHaveBeenCalled();
		const [selectedModel, selectedRole, selectedThinking] = onSelect.mock.calls[0] ?? [];
		expect(selectedRole).toBeNull();
		expect(selectedThinking).toBeUndefined();
		expect([defaultModel.id, planModel.id]).toContain(selectedModel?.id);
	});
});
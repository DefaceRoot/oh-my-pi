import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	AdvancedConfigPanel,
	type AdvancedConfigPanelCallbacks,
	type AdvancedConfigPanelOptions,
} from "../src/modes/components/agent-config/advanced-config-panel";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

function renderText(panel: AdvancedConfigPanel, width = 120): string {
	return Bun.stripANSI(panel.render(width).join("\n"));
}

function createPanel(
	overrides: Partial<Omit<AdvancedConfigPanelOptions, "callbacks">> = {},
	callbacks: Partial<AdvancedConfigPanelCallbacks> = {},
) {
	const onConfigChange = vi.fn();
	const onClose = vi.fn();
	const panel = new AdvancedConfigPanel({
		advancedConfig: null,
		availableThinkingLevels: [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High],
		globalValues: {
			thinkingLevel: ThinkingLevel.High,
			maxRecursionDepth: 2,
			compactionStrategy: "context-full",
			temperature: -1,
		},
		callbacks: {
			onConfigChange: callbacks.onConfigChange ?? onConfigChange,
			onClose: callbacks.onClose ?? onClose,
		},
		...overrides,
	});
	return { panel, onConfigChange, onClose };
}

describe("AdvancedConfigPanel", () => {
	test("renders inherited fields using global values", () => {
		const { panel } = createPanel();
		const rendered = renderText(panel);

		expect(rendered).toContain("Thinking Level");
		expect(rendered).toContain("global");
		expect(rendered).toContain("high");
		expect(rendered).toContain("Max Task Recursion");
		expect(rendered).toContain("Compaction Strategy");
		expect(rendered).toContain("context-full");
	});

	test("cycles thinking level overrides from the selected row", () => {
		const { panel, onConfigChange } = createPanel();

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ thinkingLevel: ThinkingLevel.Off });
		expect(renderText(panel)).toContain("off");
	});

	test("enters edit mode for numeric fields and saves typed values", () => {
		const { panel, onConfigChange } = createPanel();

		panel.handleInput("j");
		panel.handleInput("\n");
		panel.handleInput("5");
		panel.handleInput("\n");

		expect(onConfigChange).toHaveBeenCalledWith({ maxRecursionDepth: 5 });
		expect(renderText(panel)).toContain("5");
	});

	test("resets the selected override back to global", () => {
		const { panel, onConfigChange } = createPanel({
			advancedConfig: {
				compactionStrategy: "handoff",
			},
		});

		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput("r");

		expect(onConfigChange).toHaveBeenCalledWith(null);
		expect(renderText(panel)).toContain("context-full");
		expect(renderText(panel)).toContain("global");
	});

	test("rejects invalid numeric drafts instead of silently rewriting them", () => {
		const { panel, onConfigChange } = createPanel();

		panel.handleInput("j");
		panel.handleInput("\n");
		panel.handleInput("1");
		panel.handleInput("e");
		panel.handleInput("3");
		panel.handleInput("\n");

		expect(onConfigChange).not.toHaveBeenCalled();
		expect(renderText(panel)).toContain("must be an integer");
	});

	test("resets numeric fields to global while edit mode is active", () => {
		const { panel, onConfigChange } = createPanel({
			advancedConfig: {
				maxRecursionDepth: 5,
			},
		});

		panel.handleInput("j");
		panel.handleInput("\n");
		panel.handleInput("r");

		expect(onConfigChange).toHaveBeenCalledWith(null);
		expect(renderText(panel)).toContain("global");
		expect(renderText(panel)).toContain("2");
	});

	test("normalizes invalid persisted numeric overrides back to global state", () => {
		const { panel, onConfigChange } = createPanel({
			advancedConfig: {
				maxRecursionDepth: -2,
				temperature: -5,
			},
		});

		const rendered = renderText(panel);
		expect(rendered).not.toContain("-2");
		expect(rendered).not.toContain("-5");
		expect(rendered).toContain("global");

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ thinkingLevel: ThinkingLevel.Off });
	});
});

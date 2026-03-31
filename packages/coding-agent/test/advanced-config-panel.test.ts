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
				memoriesEnabled: false,
				grepContextBefore: 0,
				grepContextAfter: 0,
				compactionThresholdPercent: -1,
				compactionThresholdTokens: -1,
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

	describe("compaction threshold fields", () => {
		// FIELD_ORDER: index 3 = compactionThresholdPercent, index 4 = compactionThresholdTokens

		test("renders threshold fields with global default labels", () => {
			const { panel } = createPanel();
			const rendered = renderText(panel);
			expect(rendered).toContain("Compaction Threshold %");
			expect(rendered).toContain("Compaction Token Limit");
			expect(rendered).toContain("default (-1)");
		});

		test("renders explicit override values for threshold fields", () => {
			const { panel } = createPanel({
				advancedConfig: {
					compactionThresholdPercent: 80,
					compactionThresholdTokens: 200000,
				},
			});
			const rendered = renderText(panel);
			expect(rendered).toContain("80%");
			expect(rendered).toContain("200000");
			const lines = rendered.split("\n");
			const percentLine = lines.find(l => l.includes("Compaction Threshold %"));
			const tokensLine = lines.find(l => l.includes("Compaction Token Limit"));
			expect(percentLine).not.toContain("global");
			expect(tokensLine).not.toContain("global");
		});

		test("edits and saves compactionThresholdPercent", () => {
			const { panel, onConfigChange } = createPanel();
			// navigate to index 3: thinkingLevel(0) -> maxRecursionDepth(1) -> compactionStrategy(2) -> compactionThresholdPercent(3)
			panel.handleInput("j");
			panel.handleInput("j");
			panel.handleInput("j");
			panel.handleInput("\n");
			panel.handleInput("8");
			panel.handleInput("0");
			panel.handleInput("\n");
			expect(onConfigChange).toHaveBeenCalledWith({ compactionThresholdPercent: 80 });
			expect(renderText(panel)).toContain("80%");
		});

		test("edits and saves compactionThresholdTokens", () => {
			const { panel, onConfigChange } = createPanel();
			// navigate to index 4
			for (let i = 0; i < 4; i++) panel.handleInput("j");
			panel.handleInput("\n");
			for (const ch of "200000") panel.handleInput(ch);
			panel.handleInput("\n");
			expect(onConfigChange).toHaveBeenCalledWith({ compactionThresholdTokens: 200000 });
			expect(renderText(panel)).toContain("200000");
		});

		test("accepts -1 sentinel for threshold percent", () => {
			const { panel, onConfigChange } = createPanel();
			for (let i = 0; i < 3; i++) panel.handleInput("j");
			panel.handleInput("\n");
			panel.handleInput("-");
			panel.handleInput("1");
			panel.handleInput("\n");
			expect(onConfigChange).toHaveBeenCalledWith({ compactionThresholdPercent: -1 });
			expect(renderText(panel)).toContain("default (-1)");
		});

		test("rejects fractional threshold percent values", () => {
			const { panel, onConfigChange } = createPanel();
			for (let i = 0; i < 3; i++) panel.handleInput("j");
			panel.handleInput("\n");
			for (const ch of "80.5") panel.handleInput(ch);
			panel.handleInput("\n");
			expect(onConfigChange).not.toHaveBeenCalled();
			expect(renderText(panel)).toContain("must be an integer");
		});

		test("resets threshold percent to global", () => {
			const { panel, onConfigChange } = createPanel({
				advancedConfig: {
					compactionThresholdPercent: 80,
					compactionThresholdTokens: 200000,
				},
			});
			for (let i = 0; i < 3; i++) panel.handleInput("j");
			panel.handleInput("r");
			expect(onConfigChange).toHaveBeenCalledWith({ compactionThresholdTokens: 200000 });
			const lines = renderText(panel).split("\n");
			const percentLine = lines.find(l => l.includes("Compaction Threshold %"));
			expect(percentLine).toContain("global");
		});

		test("normalizes invalid persisted threshold values back to global", () => {
			const { panel } = createPanel({
				advancedConfig: {
					compactionThresholdPercent: 1.5 as unknown as number,
					compactionThresholdTokens: -2,
				},
			});
			const lines = renderText(panel).split("\n");
			const percentLine = lines.find(l => l.includes("Compaction Threshold %"));
			const tokensLine = lines.find(l => l.includes("Compaction Token Limit"));
			expect(percentLine).toContain("global");
			expect(tokensLine).toContain("global");
		});
	});
});

// =============================================================================
// Temperature bounds validation
// =============================================================================

import type { AdvancedConfigPanelGlobalValues } from "../src/modes/components/agent-config/advanced-config-panel";

const TEMP_GLOBAL_BASE: AdvancedConfigPanelGlobalValues = {
	maxRecursionDepth: 2,
	compactionStrategy: "handoff",
	temperature: -1,
	memoriesEnabled: false,
	grepContextBefore: 0,
	grepContextAfter: 0,
	compactionThresholdPercent: -1,
	compactionThresholdTokens: -1,
};

function makeTempPanel(modelApi?: string): {
	panel: AdvancedConfigPanel;
	changes: Array<import("../src/config/roles-config").AdvancedConfig | null>;
} {
	const changes: Array<import("../src/config/roles-config").AdvancedConfig | null> = [];
	const panel = new AdvancedConfigPanel({
		advancedConfig: null,
		globalValues: { ...TEMP_GLOBAL_BASE, modelApi },
		callbacks: { onConfigChange: cfg => changes.push(cfg) },
	});
	return { panel, changes };
}

/** FIELD_ORDER index for temperature is 5 — navigate from index 0. */
function goToTemp(panel: AdvancedConfigPanel): void {
	for (let i = 0; i < 5; i++) panel.handleInput("j");
}

function enterTemp(panel: AdvancedConfigPanel, value: string): void {
	panel.handleInput("\n"); // begin edit
	for (const ch of value) panel.handleInput(ch);
	panel.handleInput("\n"); // commit
}

function submitTemp(panel: AdvancedConfigPanel, value: string): void {
	goToTemp(panel);
	enterTemp(panel, value);
}

function getTempError(panel: AdvancedConfigPanel): string | undefined {
	return panel.render(120).find(
		l => l.includes("must be a number") || l.includes("out of range") || l.includes("does not support"),
	);
}

describe("AdvancedConfigPanel temperature — sentinel -1", () => {
	test("-1 is always valid regardless of modelApi", () => {
		const { panel, changes } = makeTempPanel("anthropic-messages");
		submitTemp(panel, "-1");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(-1);
	});

	test("-1 is valid even for openai-codex-responses", () => {
		const { panel, changes } = makeTempPanel("openai-codex-responses");
		submitTemp(panel, "-1");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(-1);
	});
});

describe("AdvancedConfigPanel temperature — anthropic-messages", () => {
	test("accepts 0.5 (within 0–1)", () => {
		const { panel, changes } = makeTempPanel("anthropic-messages");
		submitTemp(panel, "0.5");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(0.5);
	});

	test("accepts 1.0 (at the upper bound)", () => {
		const { panel, changes } = makeTempPanel("anthropic-messages");
		submitTemp(panel, "1");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(1);
	});

	test("rejects 1.5 (above anthropic max of 1)", () => {
		const { panel } = makeTempPanel("anthropic-messages");
		submitTemp(panel, "1.5");
		const err = getTempError(panel);
		expect(err).toBeDefined();
		expect(err).toContain("out of range");
	});
});

describe("AdvancedConfigPanel temperature — openai-responses", () => {
	test("accepts 2.0 (at the upper bound)", () => {
		const { panel, changes } = makeTempPanel("openai-responses");
		submitTemp(panel, "2");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(2);
	});

	test("rejects 2.5 (above openai max of 2)", () => {
		const { panel } = makeTempPanel("openai-responses");
		submitTemp(panel, "2.5");
		const err = getTempError(panel);
		expect(err).toBeDefined();
		expect(err).toContain("out of range");
	});
});

describe("AdvancedConfigPanel temperature — openai-codex-responses", () => {
	test("rejects any non-(-1) value", () => {
		const { panel } = makeTempPanel("openai-codex-responses");
		submitTemp(panel, "1.0");
		const err = getTempError(panel);
		expect(err).toBeDefined();
		expect(err).toContain("does not support");
	});

	test("rejects 0 (no temperature supported)", () => {
		const { panel } = makeTempPanel("openai-codex-responses");
		submitTemp(panel, "0");
		const err = getTempError(panel);
		expect(err).toBeDefined();
	});
});

describe("AdvancedConfigPanel temperature — unknown API falls back to 0–2", () => {
	test("accepts 1.5 when modelApi is unknown", () => {
		const { panel, changes } = makeTempPanel("some-unknown-api");
		submitTemp(panel, "1.5");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.temperature).toBe(1.5);
	});
});

describe("AdvancedConfigPanel temperature — stale override cleared on model switch", () => {
	test("clears out-of-bounds temperature when modelApi switches to anthropic", () => {
		const { panel, changes } = makeTempPanel("openai-responses");
		// Set temperature to 1.5 (valid for openai)
		submitTemp(panel, "1.5");
		expect(changes).toHaveLength(1);
		// Switch to anthropic — 1.5 is now out of bounds; update() should clear it
		panel.update({
			advancedConfig: { temperature: 1.5 },
			globalValues: { ...TEMP_GLOBAL_BASE, modelApi: "anthropic-messages" },
		});
		// The clear emits an immediate config change
		expect(changes).toHaveLength(2);
		expect(changes[1]?.temperature).toBeUndefined();
	});

	test("preserves valid temperature when modelApi switches to a compatible provider", () => {
		const { panel, changes } = makeTempPanel("anthropic-messages");
		submitTemp(panel, "0.7");
		expect(changes).toHaveLength(1);
		// Switch to openai — 0.7 is still within 0–2; no clear emitted
		panel.update({
			advancedConfig: { temperature: 0.7 },
			globalValues: { ...TEMP_GLOBAL_BASE, modelApi: "openai-responses" },
		});
		expect(changes).toHaveLength(1); // no extra emit
	});
});

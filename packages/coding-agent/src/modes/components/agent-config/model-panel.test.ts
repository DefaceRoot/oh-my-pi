import { beforeAll, describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { setThemeInstance, type Theme } from "../../theme/theme";
import { ModelPanel, type ModelPanelCallbacks, type ModelPanelOptions } from "./model-panel";

// ---------------------------------------------------------------------------
// Theme setup
// ---------------------------------------------------------------------------

/**
 * Minimal passthrough theme for unit tests — avoids native color/ANSI
 * initialization while keeping rendered text readable and assertable.
 */
const passthroughTheme: Theme = {
	fg: (_color: unknown, text: string) => text,
	bg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
	overlaySurface: (text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	getColorMode: () => "truecolor" as const,
	getThinkingBorderColor: () => (s: string) => s,
	getBashModeBorderColor: () => (s: string) => s,
	getPythonModeBorderColor: () => (s: string) => s,
	getSymbol: () => "",
	getSymbolForThinkingLevel: () => "",
	getPreviewThemeColors: () => ({}),
} as unknown as Theme;

beforeAll(() => {
	setThemeInstance(passthroughTheme);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(
	overrides: Partial<Omit<ModelPanelOptions, "callbacks">> = {},
	callbacks: Partial<ModelPanelCallbacks> = {},
): ModelPanel {
	return new ModelPanel({
		currentModelLabel: "provider/test-model",
		currentModelSourceLabel: "agent assignment",
		primaryModelKey: "provider/test-model",
		currentFallbackLabel: "none",
		overrideLabel: "no override",
		globalDefaultLabel: "none",
		clearOptionLabel: "No fallback",
		availableModelKeys: ["provider/test-model", "provider/other-model"],
		selectedFallbackKey: null,
		callbacks: {
			onSelectPrimary: () => {},
			onSelectFallback: () => {},
			...callbacks,
		},
		...overrides,
	});
}

function renderJoined(panel: ModelPanel, width = 80): string {
	return panel.render(width).join("\n");
}

// ---------------------------------------------------------------------------
// Thinking level display
// ---------------------------------------------------------------------------

describe("ModelPanel – thinking level display", () => {
	test("shows em-dash when primary thinking level is unset", () => {
		const panel = makePanel();
		const output = renderJoined(panel);
		// Primary section header should contain the dash placeholder.
		expect(output).toContain("[thinking: —]");
	});

	test("shows em-dash for both sections when neither thinking level is set", () => {
		const panel = makePanel();
		const output = renderJoined(panel);
		const occurrences = output.split("[thinking: —]").length - 1;
		expect(occurrences).toBe(2);
	});

	test("shows level label when primaryThinkingLevel is set to Medium", () => {
		const panel = makePanel({ primaryThinkingLevel: ThinkingLevel.Medium });
		const output = renderJoined(panel);
		expect(output).toContain("[thinking: medium]");
	});

	test("shows level label when fallbackThinkingLevel is set to High", () => {
		const panel = makePanel({ fallbackThinkingLevel: ThinkingLevel.High });
		const output = renderJoined(panel);
		expect(output).toContain("[thinking: high]");
	});

	test("shows Off level label when thinking level is Off", () => {
		const panel = makePanel({ primaryThinkingLevel: ThinkingLevel.Off });
		const output = renderJoined(panel);
		expect(output).toContain("[thinking: off]");
	});
});

// ---------------------------------------------------------------------------
// l / L key — cycle thinking level
// ---------------------------------------------------------------------------

describe("ModelPanel – l key cycles thinking level", () => {
	test("l key while on fallback target (default) calls onCycleFallbackThinkingLevel", () => {
		// Default #activeTarget is "fallback".
		let fallbackCalled = 0;
		let primaryCalled = 0;
		const panel = makePanel(
			{},
			{
				onCycleFallbackThinkingLevel: () => {
					fallbackCalled += 1;
				},
				onCyclePrimaryThinkingLevel: () => {
					primaryCalled += 1;
				},
			},
		);

		panel.handleInput("l");

		expect(fallbackCalled).toBe(1);
		expect(primaryCalled).toBe(0);
	});

	test("l key while on primary target (after t) calls onCyclePrimaryThinkingLevel", () => {
		let fallbackCalled = 0;
		let primaryCalled = 0;
		const panel = makePanel(
			{},
			{
				onCyclePrimaryThinkingLevel: () => {
					primaryCalled += 1;
				},
				onCycleFallbackThinkingLevel: () => {
					fallbackCalled += 1;
				},
			},
		);

		panel.handleInput("t"); // switch to primary
		panel.handleInput("l");

		expect(primaryCalled).toBe(1);
		expect(fallbackCalled).toBe(0);
	});

	test("uppercase L triggers onCycleFallbackThinkingLevel on fallback target", () => {
		let fallbackCalled = 0;
		const panel = makePanel(
			{},
			{
				onCycleFallbackThinkingLevel: () => {
					fallbackCalled += 1;
				},
			},
		);

		panel.handleInput("L");

		expect(fallbackCalled).toBe(1);
	});

	test("uppercase L triggers onCyclePrimaryThinkingLevel on primary target", () => {
		let primaryCalled = 0;
		const panel = makePanel(
			{},
			{
				onCyclePrimaryThinkingLevel: () => {
					primaryCalled += 1;
				},
			},
		);

		panel.handleInput("t"); // switch to primary
		panel.handleInput("L");

		expect(primaryCalled).toBe(1);
	});

	test("l key with no callbacks registered does not throw", () => {
		const panel = makePanel();
		expect(() => panel.handleInput("l")).not.toThrow();
	});
});


function enterSearch(panel: ModelPanel, query: string): void {
	panel.handleInput("/");
	for (const char of query) {
		panel.handleInput(char);
	}
}

describe("ModelPanel – search filtering", () => {
	test("shows the empty state when the query matches nothing", () => {
		const panel = makePanel();
		panel.handleInput("t");
		enterSearch(panel, "zzz");
		const output = renderJoined(panel);

		expect(output).toContain("Search (editing)");
		expect(output).toContain("No matching models.");
		expect(output).not.toContain("provider/other-model");
	});

	test("keeps the fallback clear entry visible while filtering", () => {
		const panel = makePanel();
		enterSearch(panel, "zzz");

		const output = renderJoined(panel);

		expect(output).toContain("No matching models.");
		expect(output).toContain("No fallback");
	});
	test("escape clears the query without closing the panel", () => {
		let closeCalled = 0;
		const panel = makePanel({}, { onClose: () => { closeCalled += 1; } });

		panel.handleInput("t");
		enterSearch(panel, "zzz");
		panel.handleInput("\x1b");

		const output = renderJoined(panel);

		expect(closeCalled).toBe(0);
		expect(output).toContain("Search (/ to edit)");
		expect(output).not.toContain("No matching models.");
		expect(output).toContain("provider/other-model");
	});
});

describe("ModelPanel – escape handling", () => {
	test("escape closes the panel when not filtering", () => {
		let closeCalled = 0;
		const panel = makePanel({}, { onClose: () => { closeCalled += 1; } });

		panel.handleInput("\x1b");

		expect(closeCalled).toBe(1);
	});
});
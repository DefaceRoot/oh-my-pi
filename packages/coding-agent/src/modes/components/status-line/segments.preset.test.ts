import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "../../../modes/theme/theme";
import type { AgentSession } from "../../../session/agent-session";
import type { SegmentContext } from "./segments";
import { renderSegment } from "./segments";

function createContext(options: {
	activePreset?: string | null;
	isModified?: boolean;
} = {}): SegmentContext {
	const session = {
		sessionManager: { getLastModelChangeRole: () => "default" },
		state: { model: null, thinkingLevel: "off" },
		settings: { getModelRole: () => undefined },
		isFastModeEnabled: () => false,
	} as unknown as AgentSession;

	return {
		session,
		width: 120,
		options: {},
		planMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: true,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		presets:
			options.activePreset !== undefined
				? options.activePreset === null
					? null
					: {
							activePreset: options.activePreset,
							isModified: options.isModified ?? false,
						}
				: null,
	};
}

describe("status-line preset segment", () => {
	beforeAll(() => {
		initTheme();
	});

	it("is not visible when no active preset", () => {
		const ctx = createContext({ activePreset: null });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("is not visible when presets context is null", () => {
		const ctx = createContext();
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("renders active preset name in accent color", () => {
		const ctx = createContext({ activePreset: "MyPreset" });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("MyPreset");
		expect(rendered.content).toBe(theme.fg("accent", "MyPreset"));
	});

	it("appends '*' when preset is modified", () => {
		const ctx = createContext({ activePreset: "MyPreset", isModified: true });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("MyPreset*");
		expect(rendered.content).toBe(theme.fg("accent", "MyPreset*"));
	});

	it("does not append '*' when preset is not modified", () => {
		const ctx = createContext({ activePreset: "MyPreset", isModified: false });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).not.toContain("*");
	});

	it("truncates long preset names to 18 chars with ellipsis", () => {
		const longName = "AVeryLongPresetNameThatExceedsLimit";
		const ctx = createContext({ activePreset: longName });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		// 18 chars total: 17 chars of name + '…' (slice(0, 17) + ellipsis)
		expect(rendered.content).toContain("AVeryLongPresetNa\u2026");
		expect(rendered.content).not.toContain(longName);
	});

	it("truncated modified preset shows '*' after ellipsis", () => {
		const longName = "AVeryLongPresetNameThatExceedsLimit";
		const ctx = createContext({ activePreset: longName, isModified: true });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("AVeryLongPresetNa\u2026*");
	});

	it("does not truncate names at exactly 18 chars", () => {
		const exactName = "ExactlyEighteenChs"; // 18 chars
		const ctx = createContext({ activePreset: exactName });
		const rendered = renderSegment("preset", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(exactName);
		expect(rendered.content).not.toContain("…");
	});
});

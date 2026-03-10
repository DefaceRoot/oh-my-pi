import { beforeAll, describe, expect, test } from "bun:test";
import {
	buildTokenGauge,
	SubagentDetailPane,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-detail-pane";
import type { SubagentViewRef } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function renderText(pane: SubagentDetailPane, width = 80): string {
	return Bun.stripANSI(pane.render(width).join("\n"));
}

function renderGaugeText(tokens: number, capacity: number | undefined): string {
	return Bun.stripANSI(buildTokenGauge(tokens, capacity));
}

function makeFullRef(overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id: "abc-research-001",
		agent: "research",
		description: "Research best practices for TUI modal design",
		model: "claude-sonnet-4-20250514",
		tokens: 12_450,
		tokenCapacity: 200_000,
		status: "running",
		thinkingLevel: "medium",
		startedAt: Date.now() - 134_000,
		elapsedMs: 134_000,
		lastUpdatedMs: Date.now() - 2_000,
		sessionId: "abc123-def456-ghi789-jkl012",
		parentAgentName: "orchestrator",
		depth: 2,
		assignmentPreview:
			"Research best practices for TUI\nmodal design patterns from mature\ntools like lazygit, k9s, btop.\nFocus on split-pane layouts.",
		...overrides,
	};
}

describe("SubagentDetailPane", () => {
	beforeAll(() => {
		initTheme();
	});

	describe("identity section", () => {
		test("renders agent name in bold accent", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Agent: research");
		});

		test("renders status with glyph and uppercase label", () => {
			const pane = new SubagentDetailPane(makeFullRef({ status: "running" }));
			const text = renderText(pane);
			expect(text).toContain("● RUNNING");
		});

		test("renders all status variants", () => {
			const statuses = [
				{ status: "running" as const, expected: "● RUNNING" },
				{ status: "completed" as const, expected: "◉ COMPLETED" },
				{ status: "failed" as const, expected: "✗ FAILED" },
				{ status: "pending" as const, expected: "◌ PENDING" },
				{ status: "cancelled" as const, expected: "⊘ CANCELLED" },
			];

			for (const { status, expected } of statuses) {
				const pane = new SubagentDetailPane(makeFullRef({ status }));
				const text = renderText(pane);
				expect(text).toContain(expected);
			}
		});

		test("renders description when present", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Research best practices for TUI modal design");
		});

		test("falls back to id when agent name is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ agent: undefined }));
			const text = renderText(pane);
			expect(text).toContain("Agent: abc-research-001");
		});
	});

	describe("model section", () => {
		test("renders model name", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("claude-sonnet-4-20250514");
		});

		test("renders thinking level", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Thinking: medium");
		});

		test("omits model section entirely when both model and thinkingLevel are missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ model: undefined, thinkingLevel: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Model");
			expect(text).not.toContain("Thinking:");
		});
	});

	describe("token gauge section", () => {
		test("renders gauge bar with percentage when capacity is set", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: 12_450, tokenCapacity: 200_000 }));
			const text = renderText(pane);
			expect(text).toContain("Tokens");
			expect(text).toContain("12.4k / 200.0k");
			expect(text).toContain("%");
		});

		test("renders just token count when capacity is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: 5000, tokenCapacity: undefined }));
			const text = renderText(pane);
			expect(text).toContain("5.0k");
			expect(text).not.toContain("░");
		});

		test("omits token section when tokens are undefined", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Tokens");
		});
	});

	describe("token gauge boundary cases", () => {
		test("0% gauge — all empty blocks", () => {
			const gauge = renderGaugeText(0, 200_000);
			// 0 tokens means ratio=0, filled=0
			expect(gauge).toContain("░░░░░░░░░░░░░░░░");
			expect(gauge).toContain("0.0%");
			expect(gauge).toContain("0 / 200.0k");
		});

		test("50% gauge — half filled, half empty", () => {
			const gauge = renderGaugeText(100_000, 200_000);
			expect(gauge).toContain("████████░░░░░░░░");
			expect(gauge).toContain("50.0%");
			expect(gauge).toContain("100.0k / 200.0k");
		});

		test("100% gauge — all filled blocks", () => {
			const gauge = renderGaugeText(200_000, 200_000);
			expect(gauge).toContain("████████████████");
			expect(gauge).not.toContain("░");
			expect(gauge).toContain("100.0%");
		});

		test("exceeds capacity — clamped to 100%", () => {
			const gauge = renderGaugeText(300_000, 200_000);
			expect(gauge).toContain("████████████████");
			expect(gauge).toContain("100.0%");
		});

		test("zero capacity — falls back to plain count", () => {
			const gauge = renderGaugeText(5000, 0);
			expect(gauge).toContain("5.0k");
			expect(gauge).not.toContain("░");
			expect(gauge).not.toContain("█");
		});

		test("small token count — uses raw number, not k suffix", () => {
			const gauge = renderGaugeText(42, 1000);
			expect(gauge).toContain("42 / 1.0k");
		});

		test("million-scale tokens — uses M suffix", () => {
			const gauge = renderGaugeText(1_500_000, 2_000_000);
			expect(gauge).toContain("1.5M / 2.0M");
		});
	});

	describe("timing section", () => {
		test("renders elapsed duration in mm:ss", () => {
			const pane = new SubagentDetailPane(makeFullRef({ elapsedMs: 134_000 }));
			const text = renderText(pane);
			expect(text).toContain("Elapsed:");
			expect(text).toContain("02:14");
		});

		test("renders started time", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Started:");
		});

		test("renders age", () => {
			const pane = new SubagentDetailPane(makeFullRef({ lastUpdatedMs: Date.now() - 120_000 }));
			const text = renderText(pane);
			expect(text).toContain("Age:");
			expect(text).toContain("2m ago");
		});

		test("omits timing section when all timing fields are missing", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({ elapsedMs: undefined, startedAt: undefined, lastUpdatedMs: undefined }),
			);
			const text = renderText(pane);
			expect(text).not.toContain("Timing");
			expect(text).not.toContain("Elapsed:");
		});
	});

	describe("session context section", () => {
		test("renders session ID truncated to 16 chars", () => {
			const pane = new SubagentDetailPane(makeFullRef({ sessionId: "abc123-def456-ghi789-jkl012" }));
			const text = renderText(pane);
			expect(text).toContain("ID:");
			expect(text).toContain("abc123-def456-gh...");
		});

		test("renders short session ID untruncated", () => {
			const pane = new SubagentDetailPane(makeFullRef({ sessionId: "abc123" }));
			const text = renderText(pane);
			expect(text).toContain("abc123");
			expect(text).not.toContain("...");
		});

		test("renders parent agent name", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Parent:");
			expect(text).toContain("orchestrator");
		});

		test("renders depth", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Depth:");
			expect(text).toContain("2");
		});

		test("omits session section when all context fields are missing", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({ sessionId: undefined, parentAgentName: undefined, depth: undefined }),
			);
			const text = renderText(pane);
			expect(text).not.toContain("Session");
			expect(text).not.toContain("Parent:");
			expect(text).not.toContain("Depth:");
		});
	});

	describe("assignment preview section", () => {
		test("renders assignment with separator border", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Assignment");
			expect(text).toContain("Research best practices for TUI");
			expect(text).toContain("tools like lazygit, k9s, btop.");
		});

		test("omits assignment section when preview is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Assignment");
		});

		test("truncates to 8 lines", () => {
			const longAssignment = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: longAssignment }));
			const text = renderText(pane);
			expect(text).toContain("Line 8");
			expect(text).not.toContain("Line 9");
		});
	});

	describe("no agent selected state", () => {
		test("renders fallback message when ref is undefined", () => {
			const pane = new SubagentDetailPane(undefined);
			const text = renderText(pane);
			expect(text).toContain("No agent selected");
		});

		test("renders fallback after setRef(undefined)", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setRef(undefined);
			const text = renderText(pane);
			expect(text).toContain("No agent selected");
		});
	});

	describe("full metadata rendering", () => {
		test("renders all sections for a fully-populated ref", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);

			// Identity
			expect(text).toContain("Agent: research");
			expect(text).toContain("● RUNNING");
			expect(text).toContain("Research best practices for TUI modal design");

			// Model
			expect(text).toContain("claude-sonnet-4-20250514");
			expect(text).toContain("Thinking: medium");

			// Tokens
			expect(text).toContain("Tokens");
			expect(text).toContain("12.4k / 200.0k");

			// Timing
			expect(text).toContain("Elapsed:");
			expect(text).toContain("02:14");

			// Session
			expect(text).toContain("Parent:");
			expect(text).toContain("orchestrator");
			expect(text).toContain("Depth:");

			// Assignment
			expect(text).toContain("Assignment");
			expect(text).toContain("Research best practices for TUI");
		});

		test("renders gracefully with minimal ref (only id)", () => {
			const pane = new SubagentDetailPane({ id: "minimal-agent" });
			const text = renderText(pane);
			expect(text).toContain("Agent: minimal-agent");
			// No sections should throw or render broken
			expect(text).not.toContain("undefined");
			expect(text).not.toContain("NaN");
		});
	});

	describe("setRef updates content", () => {
		test("transitions between refs correctly", () => {
			const pane = new SubagentDetailPane(makeFullRef({ agent: "explore" }));
			let text = renderText(pane);
			expect(text).toContain("Agent: explore");

			pane.setRef(makeFullRef({ agent: "lint", status: "failed" }));
			text = renderText(pane);
			expect(text).toContain("Agent: lint");
			expect(text).toContain("✗ FAILED");
			expect(text).not.toContain("Agent: explore");
		});
	});

	describe("scrolling", () => {
		test("scrollBy moves viewport when content exceeds available height", () => {
			const longAssignment = Array.from({ length: 10 }, (_, i) => `Assignment line ${i + 1}`).join("\n");
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: longAssignment }));

			// Set a small available height to force scrolling
			pane.setAvailableHeight(5);
			const initialLines = pane.render(80);
			expect(initialLines.length).toBe(5);

			// Scroll down
			pane.scrollBy(3);
			const scrolledLines = pane.render(80);
			expect(scrolledLines.length).toBe(5);

			// The content should have shifted
			const initialText = Bun.stripANSI(initialLines.join("\n"));
			const scrolledText = Bun.stripANSI(scrolledLines.join("\n"));
			expect(scrolledText).not.toBe(initialText);
		});

		test("scrollBy clamps to valid range", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setAvailableHeight(5);

			// Scroll way past the end
			pane.scrollBy(999);
			const lines = pane.render(80);
			expect(lines.length).toBe(5);

			// Scroll way before the start
			pane.scrollBy(-999);
			const linesAfter = pane.render(80);
			expect(linesAfter.length).toBe(5);
		});

		test("setRef resets scroll offset", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setAvailableHeight(5);
			pane.render(80);
			pane.scrollBy(5);

			// Set a new ref — scroll should reset
			pane.setRef(makeFullRef({ agent: "different" }));
			const lines = pane.render(80);
			const text = Bun.stripANSI(lines.join("\n"));
			expect(text).toContain("Agent: different");
		});
	});
});

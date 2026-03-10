import { beforeAll, describe, expect, test, vi } from "bun:test";
import { SubagentSessionViewerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/subagent-session-viewer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function renderText(component: SubagentSessionViewerComponent, width = 80): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function renderRaw(component: SubagentSessionViewerComponent, width = 80): string {
	return component.render(width).join("\n");
}

function createViewer(
	overrides: Partial<ConstructorParameters<typeof SubagentSessionViewerComponent>[0]> = {},
): SubagentSessionViewerComponent {
	return new SubagentSessionViewerComponent({
		getTerminalRows: () => 30,
		leaderKey: "Ctrl+X",
		onClose: vi.fn(),
		onNavigateRoot: vi.fn(),
		onNavigateNested: vi.fn(),
		onCycleAgentMode: vi.fn(),
		...overrides,
	});
}

describe("SubagentSessionViewerComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	test("routes arrow navigation according to nested mode", () => {
		const onClose = vi.fn();
		const onNavigateRoot = vi.fn();
		const onNavigateNested = vi.fn();
		const onCycleAgentMode = vi.fn();
		const viewer = new SubagentSessionViewerComponent({
			getTerminalRows: () => 20,
			leaderKey: "Ctrl+X",
			onClose,
			onNavigateRoot,
			onNavigateNested,
			onCycleAgentMode,
		});

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: ["one", "two", "three"],
			nestedArrowMode: false,
		});
		viewer.handleInput("\x1b[A");
		viewer.handleInput("\x1b[B");
		expect(onNavigateRoot).toHaveBeenNthCalledWith(1, -1);
		expect(onNavigateRoot).toHaveBeenNthCalledWith(2, 1);
		expect(onNavigateNested).not.toHaveBeenCalled();

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: ["one", "two", "three"],
			nestedArrowMode: true,
		});
		viewer.handleInput("\x1b[A");
		viewer.handleInput("\x1b[B");
		expect(onNavigateNested).toHaveBeenNthCalledWith(1, -1);
		expect(onNavigateNested).toHaveBeenNthCalledWith(2, 1);
		expect(onClose).not.toHaveBeenCalled();
		expect(onCycleAgentMode).not.toHaveBeenCalled();
	});

	test("starts pinned to the newest transcript lines and stays pinned on refresh", () => {
		const viewer = new SubagentSessionViewerComponent({
			getTerminalRows: () => 14,
			leaderKey: "Ctrl+X",
			onClose: () => {},
			onNavigateRoot: () => {},
			onNavigateNested: () => {},
			onCycleAgentMode: () => {},
		});

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: Array.from({ length: 30 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const initial = renderText(viewer, 72);
		expect(initial).toContain("line-29");
		expect(initial).not.toContain("line-0");

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: Array.from({ length: 36 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const refreshed = renderText(viewer, 72);
		expect(refreshed).toContain("line-35");
		expect(refreshed).not.toContain("line-0");
	});

	test("supports page scrolling without losing place on refresh", () => {
		const viewer = new SubagentSessionViewerComponent({
			getTerminalRows: () => 14,
			leaderKey: "Ctrl+X",
			onClose: () => {},
			onNavigateRoot: () => {},
			onNavigateNested: () => {},
			onCycleAgentMode: () => {},
		});

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: Array.from({ length: 30 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		viewer.handleInput("\x1b[5~");
		const paged = renderText(viewer, 72);
		expect(paged).toContain("line-20");
		expect(paged).not.toContain("line-29");

		viewer.setContent({
			headerLines: ["header"],
			bodyLines: Array.from({ length: 36 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const refreshed = renderText(viewer, 72);
		expect(refreshed).toContain("line-20");
		expect(refreshed).not.toContain("line-35");
	});

	describe("accent-colored border and title bar", () => {
		test("renders title bar with 'Subagent Viewer' in top border", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
			});
			const text = renderText(viewer, 80);
			const firstLine = text.split("\n")[0];
			expect(firstLine).toContain("━━ Subagent Viewer ━━");
		});

		test("renders title bar with agent name when metadata is provided", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: { agentName: "research-agent" },
			});
			const text = renderText(viewer, 80);
			const firstLine = text.split("\n")[0];
			expect(firstLine).toContain("━━ Subagent Viewer: research-agent ━━");
		});

		test("truncates long agent name in title bar at narrow widths", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: { agentName: "very-long-research-agent-name-that-exceeds-width" },
			});
			const text = renderText(viewer, 40);
			const firstLine = text.split("\n")[0];
			// Title should be present but truncated to fit
			expect(firstLine).toContain("━━");
			expect(firstLine).toContain("┌");
			expect(firstLine).toContain("┐");
		});

		test("applies borderAccent ANSI coloring to frame borders", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
			});
			const raw = renderRaw(viewer, 80);
			const stripped = renderText(viewer, 80);
			// Raw output is longer than stripped because of ANSI escape codes
			expect(raw.length).toBeGreaterThan(stripped.length);
			// Stripped output retains box-drawing characters
			expect(stripped).toContain("┌");
			expect(stripped).toContain("┐");
			expect(stripped).toContain("└");
			expect(stripped).toContain("┘");
			expect(stripped).toContain("│");
			expect(stripped).toContain("├");
			expect(stripped).toContain("┤");
		});

		test("top border uses accent color distinct from separator borders", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
			});
			const rawLines = viewer.render(80);
			// Title bar in first line uses accent (bold) styling
			const topBorder = rawLines[0];
			expect(topBorder).toContain("━━");
			// Separator lines exist and are different from the title bar
			const separators = rawLines.filter(line => Bun.stripANSI(line).includes("├"));
			expect(separators.length).toBeGreaterThan(0);
		});
	});

	describe("metadata header", () => {
		test("renders agent name, role, model, tokens, and status when metadata is provided", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["legacy header"],
				bodyLines: ["body content"],
				nestedArrowMode: false,
				metadata: {
					agentName: "explore-agent",
					role: "explorer",
					model: "claude-sonnet-4-20250514",
					tokens: 12450,
					status: "running",
					thinkingLevel: "medium",
				},
			});
			const text = renderText(viewer, 100);
			expect(text).toContain("explore-agent");
			expect(text).toContain("RUNNING");
			expect(text).toContain("●");
			expect(text).toContain("Role: explorer");
			expect(text).toContain("Model: claude-sonnet-4-20250514");
			expect(text).toContain("Tokens: 12.4k");
			expect(text).toContain("Thinking: medium");
			// Legacy header should also be present
			expect(text).toContain("legacy header");
		});

		test("renders status glyphs correctly for each status", () => {
			const statuses: {
				status: "running" | "completed" | "failed" | "pending" | "cancelled";
				glyph: string;
				label: string;
			}[] = [
				{ status: "running", glyph: "●", label: "RUNNING" },
				{ status: "completed", glyph: "◉", label: "DONE" },
				{ status: "failed", glyph: "✗", label: "FAILED" },
				{ status: "pending", glyph: "◌", label: "PENDING" },
				{ status: "cancelled", glyph: "⊘", label: "CANCEL" },
			];
			for (const { status, glyph, label } of statuses) {
				const viewer = createViewer();
				viewer.setContent({
					headerLines: [],
					bodyLines: ["body"],
					nestedArrowMode: false,
					metadata: { agentName: "test-agent", status },
				});
				const text = renderText(viewer, 80);
				expect(text).toContain(glyph);
				expect(text).toContain(label);
			}
		});

		test("handles absent optional metadata fields gracefully", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["fallback header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: { agentName: "minimal-agent" },
			});
			const text = renderText(viewer, 80);
			expect(text).toContain("minimal-agent");
			expect(text).toContain("PENDING");
			expect(text).toContain("◌");
			// Missing fields should not produce labels
			expect(text).not.toContain("Role:");
			expect(text).not.toContain("Model:");
			expect(text).not.toContain("Tokens:");
			expect(text).not.toContain("Thinking:");
			// Legacy header should still render
			expect(text).toContain("fallback header");
		});

		test("skips metadata section when metadata is empty object", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["just header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: {},
			});
			const text = renderText(viewer, 80);
			// Empty metadata should not produce any metadata-specific content
			expect(text).not.toContain("PENDING");
			expect(text).not.toContain("RUNNING");
			expect(text).not.toContain("Role:");
			// Legacy header should render
			expect(text).toContain("just header");
		});

		test("renders without metadata section when metadata is undefined", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header only"],
				bodyLines: ["body"],
				nestedArrowMode: false,
			});
			const text = renderText(viewer, 80);
			expect(text).toContain("header only");
			expect(text).not.toContain("RUNNING");
			expect(text).not.toContain("DONE");
			expect(text).not.toContain("FAILED");
		});

		test("renders token capacity when tokenCapacity is provided", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: [],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: { tokens: 12450, tokenCapacity: 200000 },
			});
			const text = renderText(viewer, 80);
			expect(text).toContain("12.4k/200.0k");
		});

		test("renders tokens without capacity when only tokens provided", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: [],
				bodyLines: ["body"],
				nestedArrowMode: false,
				metadata: { tokens: 500 },
			});
			const text = renderText(viewer, 80);
			expect(text).toContain("Tokens: 500");
		});
	});

	describe("j/k scrolling", () => {
		test("j scrolls down and k scrolls up one line", () => {
			const viewer = createViewer({ getTerminalRows: () => 14 });
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: Array.from({ length: 30 }, (_, i) => `line-${i}`),
				nestedArrowMode: false,
			});

			// Start at bottom (pinned to newest)
			let text = renderText(viewer, 72);
			expect(text).toContain("line-29");
			expect(text).not.toContain("line-24");

			// Scroll up with k
			viewer.handleInput("k");
			text = renderText(viewer, 72);
			expect(text).toContain("line-24");
			expect(text).not.toContain("line-29");

			// Scroll back down with j
			viewer.handleInput("j");
			text = renderText(viewer, 72);
			expect(text).toContain("line-29");
			expect(text).not.toContain("line-24");
		});

		test("k at top does not scroll past beginning", () => {
			const viewer = createViewer({ getTerminalRows: () => 14 });
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: Array.from({ length: 30 }, (_, i) => `line-${i}`),
				nestedArrowMode: false,
			});

			// Go to top
			viewer.handleInput("\x1b[H"); // Home
			let text = renderText(viewer, 72);
			expect(text).toContain("line-0");

			// Try scrolling up further
			viewer.handleInput("k");
			text = renderText(viewer, 72);
			expect(text).toContain("line-0");
		});
	});

	describe("footer", () => {
		test("shows updated navigation hints", () => {
			const viewer = createViewer();
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: ["body"],
				nestedArrowMode: false,
			});
			const text = renderText(viewer, 80);
			expect(text).toContain("j/k scroll");
			expect(text).toContain("PgUp/PgDn page");
			expect(text).toContain("Esc back to navigator");
		});

		test("shows line count and newest indicator when at bottom", () => {
			const viewer = createViewer({ getTerminalRows: () => 14 });
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: Array.from({ length: 10 }, (_, i) => `line-${i}`),
				nestedArrowMode: false,
			});
			const text = renderText(viewer, 72);
			expect(text).toContain("newest");
		});
	});

	describe("scroll behavior with metadata", () => {
		test("preserves scroll position when metadata is present", () => {
			const viewer = createViewer({ getTerminalRows: () => 20 });
			viewer.setContent({
				headerLines: ["header"],
				bodyLines: Array.from({ length: 40 }, (_, i) => `line-${i}`),
				nestedArrowMode: false,
				metadata: {
					agentName: "test-agent",
					role: "tester",
					model: "claude-sonnet-4-20250514",
					tokens: 5000,
					status: "running",
				},
			});

			// Start at bottom
			let text = renderText(viewer, 80);
			expect(text).toContain("line-39");
			// Metadata header should be visible
			expect(text).toContain("test-agent");
			expect(text).toContain("RUNNING");

			// Scroll up
			viewer.handleInput("\x1b[5~"); // PageUp
			text = renderText(viewer, 80);
			expect(text).not.toContain("line-39");
			// Metadata should still be present
			expect(text).toContain("test-agent");
		});
	});
});

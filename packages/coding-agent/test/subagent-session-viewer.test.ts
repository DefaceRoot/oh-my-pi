import { beforeAll, describe, expect, test, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SubagentSessionViewerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/subagent-session-viewer";

function renderText(component: SubagentSessionViewerComponent, width = 80): string {
	return Bun.stripANSI(component.render(width).join("\n"));
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
});

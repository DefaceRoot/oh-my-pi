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

type ViewerTestContent = {
	headerLines: string[];
	bodyLines: string[];
	nestedArrowMode: boolean;
	metadata?: Parameters<SubagentSessionViewerComponent["setContent"]>[0]["metadata"];
};

function setViewerContent(viewer: SubagentSessionViewerComponent, content: ViewerTestContent): void {
	viewer.setContent({
		headerLines: content.headerLines,
		renderTranscriptLines: () => content.bodyLines,
		nestedArrowMode: content.nestedArrowMode,
		metadata: content.metadata,
	});
}

describe("SubagentSessionViewerComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	test("routes arrow navigation according to nested mode", () => {
		const onNavigateRoot = vi.fn();
		const onNavigateNested = vi.fn();
		const viewer = createViewer({ onNavigateRoot, onNavigateNested });

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["one", "two", "three"],
			nestedArrowMode: false,
		});
		viewer.handleInput("\x1b[A");
		viewer.handleInput("\x1b[B");
		expect(onNavigateRoot).toHaveBeenNthCalledWith(1, -1);
		expect(onNavigateRoot).toHaveBeenNthCalledWith(2, 1);
		expect(onNavigateNested).not.toHaveBeenCalled();

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["one", "two", "three"],
			nestedArrowMode: true,
		});
		viewer.handleInput("\x1b[A");
		viewer.handleInput("\x1b[B");
		expect(onNavigateNested).toHaveBeenNthCalledWith(1, -1);
		expect(onNavigateNested).toHaveBeenNthCalledWith(2, 1);
	});

	test("stays pinned to tail only when already at bottom", () => {
		const viewer = createViewer({ getTerminalRows: () => 14 });

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: Array.from({ length: 30 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const initial = renderText(viewer, 72);
		expect(initial).toContain("line-29");
		expect(initial).toContain("FOLLOWING TAIL");

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: Array.from({ length: 36 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const refreshedAtTail = renderText(viewer, 72);
		expect(refreshedAtTail).toContain("line-35");
		expect(refreshedAtTail).toContain("FOLLOWING TAIL");

		viewer.handleInput("\x1b[5~");
		const paused = renderText(viewer, 72);
		expect(paused).toContain("TAIL PAUSED");
		expect(paused).not.toContain("line-35");

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: Array.from({ length: 40 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		const refreshedPaused = renderText(viewer, 72);
		expect(refreshedPaused).toContain("TAIL PAUSED");
		expect(refreshedPaused).not.toContain("line-39");
	});

	test("supports Home/End and j/k scrolling", () => {
		const viewer = createViewer({ getTerminalRows: () => 14 });
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: Array.from({ length: 30 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});

		viewer.handleInput("k");
		let text = renderText(viewer, 72);
		expect(text).toContain("TAIL PAUSED");

		viewer.handleInput("j");
		text = renderText(viewer, 72);
		expect(text).toContain("FOLLOWING TAIL");

		viewer.handleInput("\x1b[H");
		text = renderText(viewer, 72);
		expect(text).toContain("line-0");
		expect(text).toContain("TAIL PAUSED");

		viewer.handleInput("\x1b[F");
		text = renderText(viewer, 72);
		expect(text).toContain("line-29");
		expect(text).toContain("FOLLOWING TAIL");
	});

	test("uses opaque overlay surface background", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
		});
		const rawLines = viewer.render(80);
		expect(rawLines.length).toBeGreaterThan(0);
		for (const line of rawLines) {
			expect(line).toContain("\x1b[48;");
		}
	});

	test("renders metadata hierarchy with icon and label cues", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "explore-agent",
				role: "explorer",
				model: "claude-sonnet-4-20250514",
				tokens: 12450,
				tokenCapacity: 200000,
				status: "running",
				thinkingLevel: "medium",
			},
		});
		const text = renderText(viewer, 100);
		expect(text).toContain("Subagent: explore-agent");
		expect(text).toContain("Status ● RUNNING");
		expect(text).toContain("Role explorer");
		expect(text).toContain("Model claude-sonnet-4-20250514");
		expect(text).toContain("Tokens 12.4k/200.0k");
		expect(text).toContain("Thinking medium");
		expect(text).toContain("session header");
	});

	test("renders cancelled status label consistently", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: { agentName: "agent", status: "cancelled" },
		});
		const text = renderText(viewer, 80);
		expect(text).toContain("⊘ CANCELLED");
	});

	test("passes viewport width into transcript renderer", () => {
		const widthSpy = vi.fn((width: number) => [`width=${width}`]);
		const viewer = createViewer();
		viewer.setContent({
			headerLines: ["header"],
			renderTranscriptLines: widthSpy,
			nestedArrowMode: false,
		});

		const text = renderText(viewer, 72);
		expect(widthSpy).toHaveBeenCalled();
		expect(text).toContain("width=70");
	});

	test("drops non-string transcript rows without crashing", () => {
		const viewer = createViewer();
		viewer.setContent({
			headerLines: ["header"],
			renderTranscriptLines: () => ["safe line", 42 as unknown as string],
			nestedArrowMode: false,
		});
		const text = renderText(viewer, 72);
		expect(text).toContain("safe line");
		expect(text).not.toContain("42");
	});

	test("remains legible at narrow widths", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["line"],
			nestedArrowMode: false,
		});
		const text = renderText(viewer, 24);
		expect(text).toContain("┌");
		expect(text).toContain("│");
		expect(text).toContain("└");
	});
});

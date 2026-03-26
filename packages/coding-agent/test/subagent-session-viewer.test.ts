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
		onStop: vi.fn(),
		...overrides,
	});
}

type ViewerTestContent = {
	headerLines: string[];
	hierarchyLines?: string[];
	bodyLines: string[];
	nestedArrowMode: boolean;
	metadata?: Parameters<SubagentSessionViewerComponent["setContent"]>[0]["metadata"];
};

function setViewerContent(viewer: SubagentSessionViewerComponent, content: ViewerTestContent): void {
	viewer.setContent({
		headerLines: content.headerLines,
		hierarchyLines: content.hierarchyLines,
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

		const hierarchyViewer = createViewer({ getTerminalRows: () => 14 });
		setViewerContent(hierarchyViewer, {
			headerLines: ["header"],
			hierarchyLines: ["  ▸ (21) explore-agent | CodeRabbitReview", "    (20) implement | SomeTask"],
			bodyLines: Array.from({ length: 30 }, (_value, index) => `line-${index}`),
			nestedArrowMode: false,
		});
		hierarchyViewer.handleInput("h");
		const withHierarchy = renderText(hierarchyViewer, 72);
		expect(withHierarchy).toContain("Hierarchy (h close)");
		expect(withHierarchy).toContain("line-29");
		expect(withHierarchy).toContain("FOLLOWING TAIL");
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

	test("renders metadata by default and toggles context and hierarchy panels", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			hierarchyLines: ["  ▸ (21) explore-agent | CodeRabbitReview", "    (20) implement | SomeTask"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "explore-agent",
				role: "explorer",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				tokens: 12450,
				tokenCapacity: 200000,
				status: "running",
				thinkingLevel: "medium",
			} as any,
		});
		let text = renderText(viewer, 100);
		expect(text).toContain("Status ● RUNNING");
		expect(text).toContain("Role explorer");
		expect(text).toContain("Provider anthropic");
		expect(text).toContain("Model claude-sonnet-4-20250514");
		expect(text).toContain("Tokens 12,450");
		expect(text).not.toContain("12.4k/200.0k");
		expect(text).toContain("Thinking medium");
		expect(text).not.toContain("session header");
		expect(text).not.toContain("Hierarchy (h close)");

		viewer.handleInput("m");
		text = renderText(viewer, 100);
		expect(text).toContain("session header");

		viewer.handleInput("h");
		text = renderText(viewer, 100);
		expect(text).toContain("Hierarchy (h close)");
		expect(text).toContain("(21) explore-agent |");
		expect(text).toContain("CodeRabbitReview");
	});

	test("uses pane widths for transcript rendering when hierarchy sidebar toggles", () => {
		const transcriptWidths: number[] = [];
		const viewer = createViewer({ getTerminalRows: () => 24 });
		viewer.setContent({
			headerLines: ["header"],
			hierarchyLines: ["  ▸ (21) explore-agent | CodeRabbitReview"],
			renderTranscriptLines: width => {
				transcriptWidths.push(width);
				return ["body"];
			},
			nestedArrowMode: false,
		});

		viewer.render(80);
		expect(transcriptWidths.at(-1)).toBe(78);

		viewer.handleInput("h");
		viewer.render(80);
		expect(transcriptWidths.at(-1)).toBe(41);

		viewer.render(40);
		expect(transcriptWidths.at(-1)).toBe(24);
	});

	test("renders hierarchy rows beside transcript rows", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			hierarchyLines: ["  ▸ (21) explore-agent | CodeRabbitReview"],
			bodyLines: ["body row"],
			nestedArrowMode: false,
		});
		viewer.handleInput("h");

		const lines = renderText(viewer, 100).split("\n");
		const bodyLineIndex = lines.findIndex(line => line.includes("body row"));
		const hierarchyLineIndex = lines.findIndex(line => line.includes("Hierarchy (h close)"));
		expect(bodyLineIndex).toBeGreaterThanOrEqual(0);
		expect(hierarchyLineIndex).toBe(bodyLineIndex);
	});

	test("renders richer session metadata and stop controls for running subagents", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "plan-verifier",
				subagentId: "22-VerifyPhase07",
				sessionId: "1497dbcec67ecb20",
				role: "plan-verifier",
				provider: "openai-codex",
				model: "gpt-5.4",
				tokens: 20052,
				status: "running",
				thinkingLevel: "high",
				mcpServers: ["augment", "grafana"],
				toolNames: ["read", "grep", "submit_result"],
				canStop: true,
				filesChanged: 3,
				linesAdded: 11,
				linesDeleted: 4,
			},
		});
		const text = renderText(viewer, 120);

		expect(text).toContain("Subagent #22");
		expect(text).toContain("22-VerifyPhase07");
		expect(text).toContain("OMP Session 1497dbcec67ecb20");
		expect(text).toContain("MCP augment, grafana");
		expect(text).toContain("Tools 3");
		expect(text).toContain("S stop");
		expect(text).toContain("◆3");
		expect(text).toContain("+11-4");
	});

	test("renders delegation breadcrumb when a role chain is available", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "lint",
				status: "running",
				delegationChain: ["orchestrator", "implement", "lint"],
			},
		});
		const text = renderText(viewer, 120);
		expect(text).toContain("Delegation orchestrator › implement › lint");
	});

	test("renders used MCP servers separate from configured allowlist", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["session header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "explore-agent",
				status: "running",
				mcpServers: ["augment", "better-context"],
				mcpAllowlist: ["augment"],
			} as any,
		});
		const text = renderText(viewer, 120);
		expect(text).toContain("MCP augment, better-context");
		expect(text).toContain("Allowed MCP augment");
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

	test("renders user stopped status label distinctly", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: { agentName: "agent", status: "user_stopped" },
		});
		const text = renderText(viewer, 80);
		expect(text).toContain("USER STOPPED");
	});

	test("renders elapsed and outcome metadata when available", () => {
		const viewer = createViewer();
		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: {
				agentName: "lint",
				status: "completed",
				elapsedMs: 65_000,
				outcome: {
					status: "pass",
					label: "lint",
					summary: "No lint violations found",
				},
			} as any,
		});

		const text = renderText(viewer, 100);
		expect(text).toContain("Elapsed 1m5s");
		expect(text).toContain("Outcome PASS");
		expect(text).toContain("No lint violations found");
	});

	test("routes stop hotkey only when stop is available", () => {
		const onStop = vi.fn();
		const viewer = createViewer({ onStop });

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: { agentName: "agent", status: "running", canStop: true },
		});
		viewer.handleInput("s");
		expect(onStop).toHaveBeenCalledTimes(1);

		setViewerContent(viewer, {
			headerLines: ["header"],
			bodyLines: ["body"],
			nestedArrowMode: false,
			metadata: { agentName: "agent", status: "completed", canStop: false },
		});
		viewer.handleInput("s");
		expect(onStop).toHaveBeenCalledTimes(1);
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

	test("preserves ANSI styling from rendered transcript rows", () => {
		const viewer = createViewer();
		const transcriptLine = "\x1b[38;5;201mtool call output\x1b[0m";
		viewer.setContent({
			headerLines: ["header"],
			renderTranscriptLines: () => [transcriptLine],
			nestedArrowMode: false,
		});

		const raw = renderRaw(viewer, 80);
		expect(raw).toContain(transcriptLine);
		expect(Bun.stripANSI(raw)).toContain("tool call output");
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

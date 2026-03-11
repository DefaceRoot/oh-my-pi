import { beforeAll, describe, expect, test, vi } from "bun:test";
import { SubagentNavigatorModal } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-navigator-modal";
import type {
	SubagentNavigatorSelection,
	SubagentStatus,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function renderText(modal: SubagentNavigatorModal, width = 120): string {
	return Bun.stripANSI(modal.render(width).join("\n"));
}

function renderLines(modal: SubagentNavigatorModal, width = 120): string[] {
	return modal.render(width).map(line => Bun.stripANSI(line));
}

function renderRawLines(modal: SubagentNavigatorModal, width = 120): string[] {
	return modal.render(width);
}

function typeFilterQuery(modal: SubagentNavigatorModal, query: string): string {
	modal.handleInput("/");
	for (const ch of query) {
		modal.handleInput(ch);
	}
	return renderText(modal, 120);
}

function makeRef(id: string, overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id,
		agent: id.split("-")[0] ?? id,
		model: "claude-sonnet-4-20250514",
		description: `Task for ${id}`,
		tokens: 12_000,
		status: "running" as SubagentStatus,
		lastUpdatedMs: Date.now() - 5_000,
		contextPreview: `Context for ${id}`,
		...overrides,
	};
}

function makeGroup(rootId: string, refs: SubagentViewRef[]): SubagentViewGroup {
	return {
		rootId,
		refs,
		lastUpdatedMs: refs.length > 0 ? Math.max(...refs.map(r => r.lastUpdatedMs ?? 0)) : Date.now(),
	};
}

function createModal(
	groups: SubagentViewGroup[],
	selection?: SubagentNavigatorSelection,
	overrides?: {
		onSelectionChange?: (s: SubagentNavigatorSelection) => void;
		onOpenSelection?: (s: SubagentNavigatorSelection) => void;
		onClose?: () => void;
	},
): SubagentNavigatorModal {
	return new SubagentNavigatorModal(groups, selection, {
		onSelectionChange: overrides?.onSelectionChange ?? vi.fn(),
		onOpenSelection: overrides?.onOpenSelection ?? vi.fn(),
		onClose: overrides?.onClose ?? vi.fn(),
	});
}

function singleGroupSetup(): { groups: SubagentViewGroup[]; refs: SubagentViewRef[] } {
	const refs = [
		makeRef("explore-001", { status: "running" }),
		makeRef("research-002", { status: "completed" }),
		makeRef("lint-003", { status: "failed" }),
	];
	const groups = [makeGroup("explore-001", refs)];
	return { groups, refs };
}

function multiGroupSetup(): { groups: SubagentViewGroup[]; refs: SubagentViewRef[] } {
	const group1Refs = [
		makeRef("explore-001", { status: "running" }),
		makeRef("research-002", { status: "completed", parentId: "explore-001", rootId: "explore-001" }),
	];
	const group2Refs = [
		makeRef("lint-003", { status: "failed" }),
		makeRef("verifier-004", { status: "pending", parentId: "lint-003", rootId: "lint-003" }),
	];
	const groups = [makeGroup("explore-001", group1Refs), makeGroup("lint-003", group2Refs)];
	return { groups, refs: [...group1Refs, ...group2Refs] };
}

describe("SubagentNavigatorModal", () => {
	beforeAll(() => {
		initTheme();
	});

	describe("quick navigator layout", () => {
		test("renders quick-nav columns with numbering and last-active metadata", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 120);

			expect(text).toContain("Subagent Flight Deck");
			expect(text).toContain("#");
			expect(text).toContain("Title");
			expect(text).toContain("Status");
			expect(text).toContain("Role");
			expect(text).toContain("Model");
			expect(text).toContain("Last Active");
			expect(text).toContain("Tokens");
			expect(text).not.toContain("Agent:");
			expect(text).not.toContain("Thinking:");
		});

		test("renders compact title chrome in top border", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const lines = renderLines(modal, 100);

			expect(lines[0]).toContain("Subagent Flight Deck 1/3 active");
			expect(lines[0]).not.toContain(" Subagent Flight Deck (");
		});

		test("applies dark overlay surface to entire modal", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const rawLines = renderRawLines(modal, 100);

			expect(rawLines.length).toBeGreaterThan(3);
			expect(rawLines.every(line => line.includes("\x1b[48;"))).toBe(true);
		});

		test("uses stronger chrome with framed borders and separators", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const lines = renderLines(modal, 100);

			expect(lines[0]).toContain("┌");
			expect(lines[0]).toContain("┐");
			expect(lines[lines.length - 1]).toContain("└");
			expect(lines[lines.length - 1]).toContain("┘");
			expect(lines.some(line => /^│.*│$/.test(line))).toBe(true);
		});
	});

	describe("list rows", () => {
		test("renders index, title, status, role, model, last-active, and tokens", () => {
			const now = Date.now();
			const refs = [
				makeRef("explore-001", {
					description: "Build runbook dashboard",
					agent: "explore",
					model: "claude-sonnet-4-20250514",
					status: "running",
					lastUpdatedMs: now - 12_000,
					tokens: 12_400,
				}),
			];
			const modal = createModal([makeGroup("explore-001", refs)]);
			const lines = renderLines(modal, 120);
			const text = lines.join("\n");

			expect(text).toContain("Build runbook dashboard");
			expect(text).toContain("RUNNING");
			expect(text).toContain("explore");
			expect(text).toContain("claude-sonnet-4-202505");
			expect(text).toContain("12s ago");
			expect(text).toContain("12.4k");
			expect(lines.some(line => /│\s*1\s*│\s*Build runbook dashboard\s*│\s*●\s+RUNNING\s*│\s*explore/.test(line))).toBe(true);
		});

		test("renders color-coded statuses for root and nested rows", () => {
			const refs = [
				makeRef("agent-running", { status: "running" }),
				makeRef("agent-complete", { status: "completed", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-failed", { status: "failed", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-pending", { status: "pending", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-cancelled", { status: "cancelled", parentId: "agent-running", rootId: "agent-running" }),
			];
			const modal = createModal([makeGroup("agent-running", refs)]);
			const rawText = renderRawLines(modal, 140).join("\n");

			expect(rawText).toContain(`${theme.getFgAnsi("success")}RUNNING`);
			expect(rawText).toContain(`${theme.getFgAnsi("accent")}DONE`);
			expect(rawText).toContain(`${theme.getFgAnsi("error")}FAILED`);
			expect(rawText).toContain(`${theme.getFgAnsi("warning")}PENDING`);
			expect(rawText).toContain(`${theme.getFgAnsi("muted")}CANCELED`);
		});


		test("renders missing last-active values as --- without breaking alignment", () => {
			const refs = [makeRef("agent-1", { lastUpdatedMs: undefined, tokens: 42 })];
			const modal = createModal([makeGroup("agent-1", refs)]);
			const lines = renderLines(modal, 120);
			expect(lines.some(line => /│\s*---\s*│\s*42\s*│?$/.test(line))).toBe(true);
		});

		test("renders --- when group recency is ordinal without real timestamps", () => {
			const refs = [makeRef("agent-1", { lastUpdatedMs: undefined, lastSeenOrder: 321, tokens: 42 })];
			const groups: SubagentViewGroup[] = [{ rootId: "agent-1", refs, lastUpdatedMs: 321 }];
			const modal = createModal(groups);
			const lines = renderLines(modal, 120);

			expect(lines.some(line => /│\s*---\s*│\s*42\s*│?$/.test(line))).toBe(true);
		});

		test("title uses description first, then context preview, then id fallback", () => {
			const refs = [
				makeRef("agent-explicit", { description: "Authoritative title", contextPreview: "Fallback context" }),
				makeRef("agent-context-only", { description: undefined, contextPreview: "Context title" }),
				makeRef("agent-fallback-title", { description: undefined, contextPreview: undefined }),
			];
			const modal = createModal([makeGroup("agent-explicit", refs)]);
			const text = renderText(modal, 120);

			expect(text).toContain("Authoritative title");
			expect(text).toContain("Context title");
			expect(text).toContain("fallback title");
		});

		test("renders missing tokens as ---", () => {
			const refs = [makeRef("agent-1", { tokens: undefined })];
			const modal = createModal([makeGroup("agent-1", refs)]);
			const text = renderText(modal, 120);
			expect(text).toContain("---");
		});

		test("keeps rows within target width for long titles and models", () => {
			const refs = [
				makeRef("long-1", {
					description:
						"This is a very long title that should be truncated in the quick navigator row to preserve readability",
					model: "anthropic/claude-sonnet-4-very-long-model-string-that-should-not-break-column-layout",
				}),
			];
			const modal = createModal([makeGroup("long-1", refs)]);
			const lines = renderLines(modal, 72);
			expect(lines.every(line => line.length <= 72)).toBe(true);
		});

		test("shows group separators and nested row marker", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 120);
			const lines = renderLines(modal, 120);
			const separators = lines.filter(line => /^│─+│$/.test(line));

			expect(text).toContain("↳ ");
			expect(separators.length).toBeGreaterThanOrEqual(2);
		});
	});

		test("renders a status summary footer for visible parent and nested agents", () => {
			const refs = [
				makeRef("agent-running", { status: "running" }),
				makeRef("agent-complete", { status: "completed", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-failed-a", { status: "failed", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-failed-b", { status: "failed", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-pending", { status: "pending", parentId: "agent-running", rootId: "agent-running" }),
				makeRef("agent-cancelled", { status: "cancelled", parentId: "agent-running", rootId: "agent-running" }),
			];
			const modal = createModal([makeGroup("agent-running", refs)]);
			const text = renderText(modal, 140);

			expect(text).toContain("1 running");
			expect(text).toContain("1 done");
			expect(text).toContain("2 failed");
			expect(text).toContain("1 pending");
			expect(text).toContain("1 canceled");
		});


	describe("initial selection", () => {
		test("defaults to the most recently active entry when no selection is provided", () => {
			const now = Date.now();
			const refs = [
				makeRef("root-old", { status: "completed", lastUpdatedMs: now - 120_000 }),
				makeRef("child-new", {
					status: "running",
					parentId: "root-old",
					rootId: "root-old",
					lastUpdatedMs: now - 2_000,
				}),
			];
			const modal = createModal([makeGroup("root-old", refs)]);
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });
		});

		test("uses most recently updated entry even when nothing is running", () => {
			const now = Date.now();
			const refs = [
				makeRef("root-old", { status: "completed", lastUpdatedMs: now - 200_000 }),
				makeRef("child-new", {
					status: "failed",
					parentId: "root-old",
					rootId: "root-old",
					lastUpdatedMs: now - 3_000,
				}),
			];
			const modal = createModal([makeGroup("root-old", refs)]);
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });
		});

		test("uses lastSeenOrder fallback for default latest-active selection", () => {
			const refs = [
				makeRef("root-old", { status: "completed", lastUpdatedMs: undefined, lastSeenOrder: 1 }),
				makeRef("child-new", {
					status: "completed",
					parentId: "root-old",
					rootId: "root-old",
					lastUpdatedMs: undefined,
					lastSeenOrder: 9,
				}),
			];
			const groups: SubagentViewGroup[] = [{ rootId: "root-old", refs, lastUpdatedMs: 9 }];
			const modal = createModal(groups);
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });
		});
	});

	describe("keyboard navigation and open behavior", () => {
		test("j/k and arrow keys move selection with wraparound", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 });

			modal.handleInput("j");
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });

			modal.handleInput("\x1b[A");
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: -1 });

			modal.handleInput("k");
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 1 });
		});

		test("Enter emits onOpenSelection for current row", () => {
			const { groups } = singleGroupSetup();
			const onOpenSelection = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onOpenSelection });

			modal.handleInput("\n");
			expect(onOpenSelection).toHaveBeenCalledTimes(1);
			expect(onOpenSelection).toHaveBeenCalledWith({ groupIndex: 0, nestedIndex: -1 });
		});

		test("q, Esc, and Ctrl+X close the navigator", () => {
			const { groups } = singleGroupSetup();
			const onClose = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onClose });

			modal.handleInput("q");
			modal.handleInput("\x1b");
			modal.handleInput("\x18");
			expect(onClose).toHaveBeenCalledTimes(3);
		});

		test("Tab does not switch into a detail pane", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);

			expect(modal.getFocus()).toBe("list");
			modal.handleInput("\t");
			expect(modal.getFocus()).toBe("list");
		});
	});

	describe("filter mode", () => {
		test("/ enters filter mode and prompt is rendered", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("t");
			modal.handleInput("e");

			expect(modal.isFilterMode()).toBe(true);
			expect(renderText(modal, 120)).toContain("/ te");
		});

		test("Enter applies filter and Esc cancels in-progress filter", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("e");
			modal.handleInput("x");
			modal.handleInput("\n");

			expect(modal.isFilterMode()).toBe(false);
			expect(modal.getFilterText()).toBe("ex");
			let text = renderText(modal, 120);
			expect(text).toContain("explore");
			expect(text).not.toContain("research");

			modal.handleInput("/");
			modal.handleInput("x");
			modal.handleInput("y");
			modal.handleInput("z");
			modal.handleInput("\x1b");

			expect(modal.isFilterMode()).toBe(false);
			expect(modal.getFilterText()).toBe("");
			text = renderText(modal, 120);
			expect(text).toContain("explore");
			expect(text).not.toContain("research");

			const cancelFromFullList = createModal(groups);
			cancelFromFullList.handleInput("/");
			cancelFromFullList.handleInput("x");
			cancelFromFullList.handleInput("y");
			cancelFromFullList.handleInput("z");
			cancelFromFullList.handleInput("\x1b");
			const restoredText = renderText(cancelFromFullList, 120);
			expect(restoredText).toContain("explore");
			expect(restoredText).toContain("research");
			expect(restoredText).toContain("lint");
		});

		test("filter can match by status text and description", () => {
			const refs = [
				makeRef("agent-running", { status: "running", description: "Build dashboard" }),
				makeRef("agent-failed", { status: "failed", description: "Run tests" }),
			];
			const modal = createModal([makeGroup("agent-running", refs)]);

			modal.handleInput("/");
			modal.handleInput("f");
			modal.handleInput("a");
			modal.handleInput("i");
			modal.handleInput("l");
			expect(renderText(modal, 120)).toContain("Run tests");

			modal.handleInput("\x1b");
			modal.handleInput("/");
			for (const ch of "dash") {
				modal.handleInput(ch);
			}
			const text = renderText(modal, 120);
			expect(text).toContain("Build dashboard");
		});

		test("filter matches description-backed visible title", () => {
			const refs = [
				makeRef("agent-desc-title", {
					agent: "planner",
					status: "running",
					description: "Description backed title",
				}),
				makeRef("agent-secondary", { agent: "planner", status: "running", description: "Secondary row" }),
			];
			const modal = createModal([makeGroup("agent-desc-title", refs)]);
			const text = typeFilterQuery(modal, "BACKED TITLE");

			expect(text).toContain("Description backed title");
			expect(text).not.toContain("Secondary row");
		});

		test("filter matches context-preview-backed visible title", () => {
			const refs = [
				makeRef("agent-context-title", {
					agent: "planner",
					status: "running",
					description: undefined,
					contextPreview: "Context preview title",
				}),
				makeRef("agent-secondary", { agent: "planner", status: "running", description: "Secondary row" }),
			];
			const modal = createModal([makeGroup("agent-context-title", refs)]);
			const text = typeFilterQuery(modal, "PREVIEW TITLE");

			expect(text).toContain("Context preview title");
			expect(text).not.toContain("Secondary row");
		});

		test("filter matches id-derived fallback visible title", () => {
			const refs = [
				makeRef("agent-fallback-only-title", {
					agent: "planner",
					status: "running",
					description: undefined,
					contextPreview: undefined,
				}),
				makeRef("agent-secondary", { agent: "planner", status: "running", description: "Secondary row" }),
			];
			const modal = createModal([makeGroup("agent-fallback-only-title", refs)]);
			const text = typeFilterQuery(modal, "FALLBACK ONLY TITLE");

			expect(text).toContain("fallback only title");
			expect(text).not.toContain("Secondary row");
		});
	});

	describe("empty state and resilience", () => {
		test("renders empty message with no groups", () => {
			const modal = createModal([]);
			const text = renderText(modal, 120);
			expect(text).toContain("No subagents found");
		});

		test("rendering does not crash at narrow widths", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			expect(() => modal.render(1)).not.toThrow();
			expect(() => modal.render(20)).not.toThrow();
		});

		test("setGroups keeps or overrides selection as requested", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: 0 });
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });

			const updateRefs = [
				makeRef("explore-001", { status: "completed", tokens: 99_000 }),
				makeRef("research-002", { status: "completed" }),
			];
			modal.setGroups([makeGroup("explore-001", updateRefs)]);
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: 0 });

			modal.setGroups(groups, { groupIndex: 1, nestedIndex: -1 });
			expect(modal.getSelection()).toEqual({ groupIndex: 1, nestedIndex: -1 });
		});
	});
});

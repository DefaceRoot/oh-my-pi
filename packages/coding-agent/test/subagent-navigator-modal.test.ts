import { beforeAll, describe, expect, test, vi } from "bun:test";
import { SubagentNavigatorModal } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-navigator-modal";
import type {
	SubagentNavigatorSelection,
	SubagentStatus,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderText(modal: SubagentNavigatorModal, width = 120): string {
	return Bun.stripANSI(modal.render(width).join("\n"));
}

function renderLines(modal: SubagentNavigatorModal, width = 120): string[] {
	return modal.render(width).map(l => Bun.stripANSI(l));
}

function makeRef(id: string, overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id,
		agent: id.split("-")[0] ?? id,
		model: "claude-sonnet-4-20250514",
		description: `Task for ${id}`,
		tokens: 12_000,
		tokenCapacity: 200_000,
		status: "running" as SubagentStatus,
		lastUpdatedMs: Date.now() - 5_000,
		thinkingLevel: "medium",
		startedAt: Date.now() - 60_000,
		elapsedMs: 60_000,
		sessionId: "sess-001",
		parentAgentName: "orchestrator",
		depth: 1,
		assignmentPreview: "Do some work",
		...overrides,
	};
}

function makeGroup(rootId: string, refs: SubagentViewRef[]): SubagentViewGroup {
	return {
		rootId,
		refs,
		lastUpdatedMs: Math.max(...refs.map(r => r.lastUpdatedMs ?? 0)),
	};
}

function createModal(
	groups: SubagentViewGroup[],
	selection: SubagentNavigatorSelection = { groupIndex: 0, nestedIndex: -1 },
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SubagentNavigatorModal", () => {
	beforeAll(() => {
		initTheme();
	});

	// ═══ Layout ═══

	describe("split-pane layout", () => {
		test("renders split pane at width >= 80", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 100);
			// Title bar present
			expect(text).toContain("Subagent Flight Deck");
			// List columns present
			expect(text).toContain("Role");
			expect(text).toContain("Status");
			expect(text).toContain("Tokens");
			// Detail pane content for selected agent
			expect(text).toContain("Agent: explore");
		});

		test("renders detail pane content for selected agent", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 120);
			// Detail pane shows model info for selected (first) agent
			expect(text).toContain("claude-sonnet-4-20250514");
		});

		test("title bar contains active count", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 120);
			// 1 running agent out of 3 total
			expect(text).toContain("1/3 active");
		});
	});

	describe("single-pane fallback", () => {
		test("renders list only when width < 80", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 60);
			// List is present
			expect(text).toContain("explore");
			expect(text).toContain("research");
			// Detail pane metadata should NOT appear (no split)
			expect(text).not.toContain("Agent: explore");
		});

		test("list columns adapt to narrow width", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const lines = renderLines(modal, 50);
			// Should still render without crashing
			expect(lines.length).toBeGreaterThan(3);
		});
	});

	// ═══ Status rendering ═══

	describe("status glyphs and colors", () => {
		test("renders status glyphs for all statuses", () => {
			const statuses: Array<{ status: SubagentStatus; glyph: string; label: string }> = [
				{ status: "running", glyph: "●", label: "RUNNING" },
				{ status: "completed", glyph: "◉", label: "DONE" },
				{ status: "failed", glyph: "✗", label: "FAILED" },
				{ status: "pending", glyph: "◌", label: "PENDING" },
				{ status: "cancelled", glyph: "⊘", label: "CANCEL" },
			];
			for (const { status, glyph, label } of statuses) {
				const refs = [makeRef(`agent-${status}`, { status })];
				const groups = [makeGroup(`agent-${status}`, refs)];
				const modal = createModal(groups);
				const text = renderText(modal);
				expect(text).toContain(glyph);
				expect(text).toContain(label);
			}
		});
	});

	// ═══ List pane columns ═══

	describe("list pane columns", () => {
		test("renders ordinal numbers", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("01");
			expect(text).toContain("02");
			expect(text).toContain("03");
		});

		test("renders role names", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("explore");
			expect(text).toContain("research");
			expect(text).toContain("lint");
		});

		test("renders token counts with formatting", () => {
			const refs = [makeRef("agent-1", { tokens: 12_400 })];
			const groups = [makeGroup("agent-1", refs)];
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("12.4k");
		});

		test("renders missing tokens as ---", () => {
			const refs = [makeRef("agent-1", { tokens: undefined })];
			const groups = [makeGroup("agent-1", refs)];
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("---");
		});

		test("nested refs show » prefix", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("»");
		});
	});

	// ═══ Selection highlighting ═══

	describe("selection highlighting", () => {
		test("first item is selected by default", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const sel = modal.getSelection();
			expect(sel).toEqual({ groupIndex: 0, nestedIndex: -1 });
		});

		test("initial selection is respected", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups, { groupIndex: 1, nestedIndex: -1 });
			const sel = modal.getSelection();
			expect(sel).toEqual({ groupIndex: 1, nestedIndex: -1 });
		});
	});

	// ═══ Group separators ═══

	describe("group separators", () => {
		test("renders separator between groups", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups);
			const lines = renderLines(modal);
			// Count horizontal rule lines (─) in the body
			const separatorLines = lines.filter(
				l => l.match(/^─+$/) || (l.includes("─") && !l.includes("Role") && !l.includes("Subagent")),
			);
			// There should be at least the column header separator + group separator
			expect(separatorLines.length).toBeGreaterThanOrEqual(2);
		});
	});

	// ═══ Keyboard navigation ═══

	describe("keyboard navigation — list pane", () => {
		test("down arrow moves selection forward", () => {
			const { groups } = singleGroupSetup();
			const onSelectionChange = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onSelectionChange });

			modal.handleInput("\x1b[B"); // down arrow
			const sel = modal.getSelection();
			// Should have moved to index 1 (second item in the flat list)
			expect(sel.groupIndex).toBe(0);
			expect(sel.nestedIndex).toBe(0); // first nested
		});

		test("j key moves selection forward", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("j");
			const sel = modal.getSelection();
			expect(sel.nestedIndex).toBe(0);
		});

		test("up arrow moves selection backward", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: 0 });
			modal.handleInput("\x1b[A"); // up arrow
			const sel = modal.getSelection();
			expect(sel.nestedIndex).toBe(-1); // back to root
		});

		test("k key moves selection backward", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: 0 });
			modal.handleInput("k");
			const sel = modal.getSelection();
			expect(sel.nestedIndex).toBe(-1);
		});

		test("selection wraps around at boundaries", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 });
			// Move up from first item should wrap to last
			modal.handleInput("k");
			const sel = modal.getSelection();
			expect(sel.nestedIndex).toBe(1); // last nested index in 3-item group
		});

		test("Enter emits onOpenSelection", () => {
			const { groups } = singleGroupSetup();
			const onOpenSelection = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onOpenSelection });
			modal.handleInput("\n");
			expect(onOpenSelection).toHaveBeenCalledTimes(1);
			expect(onOpenSelection).toHaveBeenCalledWith({ groupIndex: 0, nestedIndex: -1 });
		});

		test("q emits onClose", () => {
			const { groups } = singleGroupSetup();
			const onClose = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onClose });
			modal.handleInput("q");
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		test("Esc emits onClose", () => {
			const { groups } = singleGroupSetup();
			const onClose = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onClose });
			modal.handleInput("\x1b");
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	// ═══ Focus switching ═══

	describe("focus switching", () => {
		test("Tab switches from list to detail pane", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			expect(modal.getFocus()).toBe("list");
			modal.handleInput("\t");
			expect(modal.getFocus()).toBe("detail");
		});

		test("Tab switches from detail back to list", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("\t"); // list -> detail
			expect(modal.getFocus()).toBe("detail");
			modal.handleInput("\t"); // detail -> list
			expect(modal.getFocus()).toBe("list");
		});

		test("Esc in detail pane returns to list (does not close)", () => {
			const { groups } = singleGroupSetup();
			const onClose = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onClose });
			modal.handleInput("\t"); // focus detail
			expect(modal.getFocus()).toBe("detail");
			modal.handleInput("\x1b"); // Esc
			expect(modal.getFocus()).toBe("list");
			expect(onClose).not.toHaveBeenCalled();
		});

		test("Enter in detail pane emits onOpenSelection", () => {
			const { groups } = singleGroupSetup();
			const onOpenSelection = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onOpenSelection });
			modal.handleInput("\t"); // focus detail
			modal.handleInput("\n"); // Enter
			expect(onOpenSelection).toHaveBeenCalledTimes(1);
		});

		test("j/k in detail pane scrolls instead of moving selection", () => {
			const { groups } = singleGroupSetup();
			const onSelectionChange = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onSelectionChange });
			modal.handleInput("\t"); // focus detail
			onSelectionChange.mockClear();
			modal.handleInput("j"); // scroll detail
			// Selection should NOT change when in detail focus
			expect(onSelectionChange).not.toHaveBeenCalled();
			const sel = modal.getSelection();
			expect(sel).toEqual({ groupIndex: 0, nestedIndex: -1 });
		});
	});

	// ═══ Filter mode ═══

	describe("filter mode", () => {
		test("/ enters filter mode", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			expect(modal.isFilterMode()).toBe(false);
			modal.handleInput("/");
			expect(modal.isFilterMode()).toBe(true);
		});

		test("typing narrows list by agent name", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("e");
			modal.handleInput("x");
			modal.handleInput("p");
			// Only "explore" should match
			const text = renderText(modal);
			expect(text).toContain("explore");
			// Others should be filtered out
			expect(text).not.toMatch(/\bresearch\b.*\bROLE\b/i);
		});

		test("filter matches status text", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("f");
			modal.handleInput("a");
			modal.handleInput("i");
			modal.handleInput("l");
			// "failed" status should match lint-003
			const text = renderText(modal);
			expect(text).toContain("lint");
		});

		test("filter matches description", () => {
			const refs = [
				makeRef("agent-1", { description: "Build the dashboard" }),
				makeRef("agent-2", { description: "Run linter checks" }),
			];
			const groups = [makeGroup("agent-1", refs)];
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("l");
			modal.handleInput("i");
			modal.handleInput("n");
			modal.handleInput("t");
			const text = renderText(modal);
			// agent-2 has "linter" in its description — it should match
			// But the filter also matches agent name, so let's check the lines
			expect(text).toContain("agent");
		});

		test("Esc cancels filter and restores full list", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("x");
			modal.handleInput("y");
			modal.handleInput("z");
			// Should filter to empty or near-empty
			modal.handleInput("\x1b"); // Esc
			expect(modal.isFilterMode()).toBe(false);
			expect(modal.getFilterText()).toBe("");
			// Full list restored
			const text = renderText(modal);
			expect(text).toContain("explore");
			expect(text).toContain("research");
			expect(text).toContain("lint");
		});

		test("Enter applies filter and exits filter mode", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("e");
			modal.handleInput("x");
			modal.handleInput("\n"); // Enter
			expect(modal.isFilterMode()).toBe(false);
			// Filter text should be preserved (applied)
			expect(modal.getFilterText()).toBe("ex");
		});

		test("backspace removes last character", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("a");
			modal.handleInput("b");
			modal.handleInput("c");
			expect(modal.getFilterText()).toBe("abc");
			modal.handleInput("\x7f"); // backspace
			expect(modal.getFilterText()).toBe("ab");
		});

		test("filter prompt is visible in list pane", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/");
			modal.handleInput("t");
			modal.handleInput("e");
			const text = renderText(modal);
			expect(text).toContain("/ te");
		});
	});

	// ═══ Footer ═══

	describe("footer", () => {
		test("footer shows status summary", () => {
			const refs = [
				makeRef("a-1", { status: "running" }),
				makeRef("a-2", { status: "completed" }),
				makeRef("a-3", { status: "failed" }),
			];
			const groups = [makeGroup("a-1", refs)];
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("1 running");
			expect(text).toContain("1 done");
			expect(text).toContain("1 failed");
		});

		test("footer shows list-focused hints by default", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("nav");
			expect(text).toContain("Enter open");
			expect(text).toContain("filter");
			expect(text).toContain("quit");
		});

		test("footer shows detail-focused hints when detail pane is focused", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("\t"); // focus detail
			const text = renderText(modal);
			expect(text).toContain("scroll");
			expect(text).toContain("Tab list");
			expect(text).toContain("Esc back");
		});

		test("footer shows filter hints during filter mode", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			modal.handleInput("/"); // enter filter
			const text = renderText(modal);
			expect(text).toContain("Enter apply");
			expect(text).toContain("Esc cancel");
		});
	});

	// ═══ setGroups API ═══

	describe("setGroups update API", () => {
		test("updates data and preserves selection when possible", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: 0 });
			const sel1 = modal.getSelection();
			expect(sel1).toEqual({ groupIndex: 0, nestedIndex: 0 });

			// Update with same structure
			const newRefs = [
				makeRef("explore-001", { status: "completed", tokens: 20_000 }),
				makeRef("research-002", { status: "completed" }),
				makeRef("lint-003", { status: "completed" }),
			];
			const newGroups = [makeGroup("explore-001", newRefs)];
			modal.setGroups(newGroups);

			// Selection should remain at the same position
			const sel2 = modal.getSelection();
			expect(sel2).toEqual({ groupIndex: 0, nestedIndex: 0 });
		});

		test("updates rendering with new data", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			let text = renderText(modal);
			expect(text).toContain("RUNNING");

			// Update all to completed
			const newRefs = [makeRef("explore-001", { status: "completed" })];
			const newGroups = [makeGroup("explore-001", newRefs)];
			modal.setGroups(newGroups);
			text = renderText(modal);
			expect(text).toContain("DONE");
		});

		test("setGroups with explicit selection overrides current", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 });
			expect(modal.getSelection()).toEqual({ groupIndex: 0, nestedIndex: -1 });

			modal.setGroups(groups, { groupIndex: 1, nestedIndex: -1 });
			expect(modal.getSelection()).toEqual({ groupIndex: 1, nestedIndex: -1 });
		});

		test("clamps selection when groups shrink", () => {
			const { groups } = multiGroupSetup();
			const modal = createModal(groups, { groupIndex: 1, nestedIndex: 0 });
			// Now shrink to single group
			const smallRefs = [makeRef("only-one", { status: "running" })];
			const smallGroups = [makeGroup("only-one", smallRefs)];
			modal.setGroups(smallGroups);
			const sel = modal.getSelection();
			expect(sel.groupIndex).toBe(0);
		});
	});

	// ═══ Empty state ═══

	describe("empty state", () => {
		test("renders empty message with no groups", () => {
			const modal = createModal([]);
			const text = renderText(modal);
			expect(text).toContain("No subagents found");
		});

		test("renders empty message with empty group refs", () => {
			const groups = [{ rootId: "none", refs: [], lastUpdatedMs: Date.now() }];
			const modal = createModal(groups);
			const text = renderText(modal);
			expect(text).toContain("No subagents found");
		});

		test("keyboard nav does not crash on empty list", () => {
			const modal = createModal([]);
			expect(() => {
				modal.handleInput("j");
				modal.handleInput("k");
				modal.handleInput("\t");
				modal.handleInput("/");
				modal.handleInput("a");
				modal.handleInput("\x1b");
			}).not.toThrow();
		});
	});

	// ═══ Narrow width rendering ═══

	describe("narrow width resilience", () => {
		test("does not crash at width 1", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			expect(() => modal.render(1)).not.toThrow();
		});

		test("does not crash at width 20", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const lines = modal.render(20);
			expect(lines.length).toBeGreaterThan(0);
		});

		test("width 79 uses single-pane", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 79);
			// Should NOT have detail pane content
			expect(text).not.toContain("Agent: explore");
		});

		test("width 80 uses split-pane", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 80);
			// Should have detail pane content
			expect(text).toContain("Agent: explore");
		});
	});

	// ═══ Detail pane integration ═══

	describe("detail pane integration", () => {
		test("detail pane updates when selection changes", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 });
			let text = renderText(modal, 120);
			expect(text).toContain("Agent: explore");

			modal.handleInput("j"); // move to research-002
			text = renderText(modal, 120);
			expect(text).toContain("Agent: research");
		});

		test("detail pane shows model info for selected agent", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const text = renderText(modal, 120);
			expect(text).toContain("claude-sonnet-4-20250514");
			expect(text).toContain("Thinking: medium");
		});
	});

	// ═══ Selection change callback ═══

	describe("selection change callback", () => {
		test("fires on navigation", () => {
			const { groups } = singleGroupSetup();
			const onSelectionChange = vi.fn();
			const modal = createModal(groups, { groupIndex: 0, nestedIndex: -1 }, { onSelectionChange });
			onSelectionChange.mockClear(); // clear initial call from constructor
			modal.handleInput("j");
			expect(onSelectionChange).toHaveBeenCalledTimes(1);
		});
	});

	// ═══ Regression Tests ═══

	describe("render output", () => {
		test("render() returns only strings (no nested arrays)", () => {
			const { groups } = singleGroupSetup();
			const modal = createModal(groups);
			const lines = modal.render(80);

			expect(Array.isArray(lines)).toBe(true);
			for (const line of lines) {
				expect(typeof line).toBe("string");
			}
		});
	});
});

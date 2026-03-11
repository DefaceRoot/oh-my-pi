import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import { renderSidebar } from "@oh-my-pi/pi-coding-agent/modes/components/sidebar/render";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plain(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

/**
 * Hot-path absence tests for sidebar build and navigator open.
 *
 * Guard against reintroducing synchronous filesystem discovery
 * (`Bun.Glob.prototype.scanSync`, `fs.statSync`) on the sidebar render path
 * and the navigator open path. When the SubagentIndex snapshot is populated,
 * both paths must operate exclusively from the in-memory snapshot.
 */

beforeAll(async () => {
	await initTheme(false);
});

function makeRef(id: string, overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id,
		rootId: id,
		agent: "explore",
		model: "claude-sonnet-4-20250514",
		description: `Task for ${id}`,
		sessionPath: `/tmp/sessions/${id}.jsonl`,
		lastUpdatedMs: Date.now(),
		tokens: 1200,
		status: "completed",
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

function makeSnapshot(refs: SubagentViewRef[], groups: SubagentViewGroup[], version = 1): SubagentIndexSnapshot {
	return { version, updatedAt: Date.now(), refs, groups };
}

/**
 * Build a minimal InteractiveMode instance (via prototype chain) with a
 * populated SubagentIndex snapshot so that hot-path methods draw from
 * the in-memory snapshot rather than falling back to sync filesystem discovery.
 */
function createModeWithSnapshot(refs: SubagentViewRef[], groups: SubagentViewGroup[]): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot(refs, groups);
	mode.subagentViewActiveId = undefined;
	mode.subagentCycleIndex = -1;
	mode.subagentNestedCycleIndex = -1;
	mode.subagentNestedArrowMode = false;
	mode.subagentNavigatorComponent = undefined;
	mode.subagentNavigatorClose = undefined;
	mode.subagentNavigatorOverlay = undefined;
	mode.subagentNavigatorGroups = [];
	mode.subagentSessionViewer = undefined;
	mode.subagentSessionOverlay = undefined;
	mode.subagentCycleSignature = undefined;
	mode.subagentViewRequestToken = 0;
	mode.statusLine = { setHookStatus: vi.fn() };
	mode.ui = {
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	return mode as InteractiveMode;
}

describe("sidebar hot path avoids sync FS when snapshot is populated", () => {
	let statSyncSpy: ReturnType<typeof vi.spyOn>;
	let scanSyncSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		statSyncSpy = vi.spyOn(nodeFs, "statSync").mockImplementation(() => {
			throw new Error("statSync called on hot path — sync FS must not be used when snapshot is populated");
		});
		scanSyncSpy = vi.spyOn(Bun.Glob.prototype, "scanSync" as any).mockImplementation(() => {
			throw new Error("scanSync called on hot path — sync FS must not be used when snapshot is populated");
		});
	});

	afterEach(() => {
		statSyncSpy.mockRestore();
		scanSyncSpy.mockRestore();
	});

	test("buildSidebarSubagents builds parent and child rows from snapshot groups without sync FS", () => {
		const rootRef = makeRef("0-Explore", {
			status: "running",
			tokens: 5600,
			description: "Scan repository for sidebar touchpoints",
			contextPreview: "═══════════Background═══════════",
		});
		const childRef = makeRef("0-Explore.0-Lint", {
			rootId: "0-Explore",
			parentId: "0-Explore",
			depth: 1,
			agent: "lint",
			status: "completed",
			tokens: 1300,
		});
		const siblingRef = makeRef("1-Research", { agent: "research", tokens: 3400, status: "completed" });
		const group1 = makeGroup("0-Explore", [rootRef, childRef]);
		const group2 = makeGroup("1-Research", [siblingRef]);
		const mode = createModeWithSnapshot([rootRef, childRef, siblingRef], [group1, group2]) as any;

		const rows = mode.buildSidebarSubagents();

		expect(rows).toBeDefined();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			kind: "parent",
			id: "0-Explore",
			agentName: "explore",
			status: "running",
			title: "Scan repository for sidebar touchpoints",
			tokens: 5600,
		});
		expect(rows[0]?.title).not.toContain("Background");
		expect(rows[0]?.children).toEqual([
			{ kind: "child", id: "0-Explore.0-Lint", agentName: "lint", status: "completed", tokens: 1300 },
		]);
		expect(rows[1]).toMatchObject({
			kind: "parent",
			id: "1-Research",
			agentName: "research",
			status: "completed",
			tokens: 3400,
		});
		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	test("buildSidebarSubagents output renders grouped parent-child hierarchy with deterministic token labels", () => {
		const failedParent = makeRef("0-Explore", {
			agent: "explore",
			status: "completed",
			tokens: 1999,
			description: "Explore sidebar task",
		});
		const failedChild = makeRef("0-Explore.0-Reviewer", {
			rootId: "0-Explore",
			parentId: "0-Explore",
			depth: 1,
			agent: "code-reviewer",
			status: "failed",
			tokens: 1550,
		});
		const runningParent = makeRef("1-Research", {
			agent: "research",
			status: "running",
			tokens: 1000,
			description: "Parent only row",
		});
		const mode = createModeWithSnapshot(
			[failedParent, failedChild, runningParent],
			[makeGroup("0-Explore", [failedParent, failedChild]), makeGroup("1-Research", [runningParent])],
		) as any;

		const rows = mode.buildSidebarSubagents();
		const rendered = renderSidebar({ width: 120, subagents: rows }).map(plain).join("\n");

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ kind: "parent", id: "0-Explore", status: "failed", tokens: 1999 });
		expect(rows[0]?.children).toEqual([
			{ kind: "child", id: "0-Explore.0-Reviewer", agentName: "code-reviewer", status: "failed", tokens: 1550 },
		]);
		expect(rows[1]).toMatchObject({ kind: "parent", id: "1-Research", status: "running", tokens: 1000 });
		expect(rendered).toContain("Subagents");
		expect(rendered).toContain("✗ explore · 2.0k tok");
		expect(rendered).toContain("└─ ✗ code-reviewer · 1.6k tok");
		expect(rendered).toContain("◐ research · 1.0k tok");
		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	test("buildSidebarSubagents returns undefined for empty snapshot groups without sync FS", () => {
		const mode = createModeWithSnapshot([], []) as any;

		const rows = mode.buildSidebarSubagents();

		expect(rows).toBeUndefined();
		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});
});

describe("navigator open hot path avoids sync FS when snapshot is populated", () => {
	let statSyncSpy: ReturnType<typeof vi.spyOn>;
	let scanSyncSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		statSyncSpy = vi.spyOn(nodeFs, "statSync").mockImplementation(() => {
			throw new Error("statSync called on hot path — sync FS must not be used when snapshot is populated");
		});
		scanSyncSpy = vi.spyOn(Bun.Glob.prototype, "scanSync" as any).mockImplementation(() => {
			throw new Error("scanSync called on hot path — sync FS must not be used when snapshot is populated");
		});
	});

	afterEach(() => {
		statSyncSpy.mockRestore();
		scanSyncSpy.mockRestore();
	});

	test("openSubagentNavigator reads from snapshot groups and creates overlay without sync FS", () => {
		const rootRef = makeRef("0-Worker", { agent: "implement", status: "running" });
		const nestedRef = makeRef("0-Worker.0-Lint", {
			agent: "lint",
			rootId: "0-Worker",
			parentId: "0-Worker",
			depth: 1,
		});
		const group = makeGroup("0-Worker", [rootRef, nestedRef]);
		const mode = createModeWithSnapshot([rootRef, nestedRef], [group]) as any;

		mode.openSubagentNavigator();

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(mode.subagentNavigatorComponent).toBeDefined();
	});

	test("openSubagentNavigator reuses existing navigator component without recreating overlay", () => {
		const ref = makeRef("0-Task");
		const group = makeGroup("0-Task", [ref]);
		const mode = createModeWithSnapshot([ref], [group]) as any;

		// First open creates the navigator
		mode.openSubagentNavigator();
		expect(mode.ui.showOverlay).toHaveBeenCalledTimes(1);
		const componentAfterFirst = mode.subagentNavigatorComponent;

		// Second open reuses existing component (updates in-place)
		mode.openSubagentNavigator();
		expect(mode.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(mode.subagentNavigatorComponent).toBe(componentAfterFirst);
		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	test("openSubagentNavigator sets selection state from snapshot groups", () => {
		const ref1 = makeRef("0-A");
		const ref2 = makeRef("1-B", { agent: "research" });
		const groups = [makeGroup("0-A", [ref1]), makeGroup("1-B", [ref2])];
		const mode = createModeWithSnapshot([ref1, ref2], groups) as any;

		mode.openSubagentNavigator();

		expect(mode.subagentCycleIndex).toBeGreaterThanOrEqual(0);
		expect(mode.subagentViewActiveId).toBeDefined();
		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});
});

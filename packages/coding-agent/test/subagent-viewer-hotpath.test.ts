import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";

/**
 * Hot-path absence tests for the active viewer navigation path.
 *
 * Guard against reintroducing synchronous filesystem discovery
 * on the viewer navigation hot path. When the SubagentIndex snapshot is
 * populated, navigateSubagentView and refreshActiveViewerTranscript must resolve
 * groups from the in-memory snapshot rather than calling collectSubagentViewRefs.
 *
 * Production gap: when the snapshot has empty refs AND empty groups,
 * `getSnapshotGroups()` falls through to the legacy `collectSubagentViewRefs()`.
 * This is expected to be fixed in Unit 2.5 wiring. The empty-snapshot edge case
 * is not tested here for that reason.
 */

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
 * Build a minimal InteractiveMode instance with a populated snapshot and
 * mock transcript loading so that navigateSubagentView completes without
 * real filesystem or terminal dependencies.
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

	// Mock transcript loading to avoid real filesystem reads (this is async, not a sync hot path issue)
	mode.loadSubagentTranscript = vi.fn(async (ref: SubagentViewRef) => ({
		source: ref.sessionPath ?? "/tmp/mock.jsonl",
		content: '{"type":"session_init","task":"mock task"}\n',
		sessionContext: { messages: [] },
		model: ref.model ?? "default",
		tokens: ref.tokens ?? 0,
		contextPreview: ref.description,
		skillsUsed: [],
	}));

	// Mock renderSubagentSession to avoid terminal rendering dependencies
	mode.renderSubagentSession = vi.fn(async () => undefined);

	return mode as InteractiveMode;
}

describe("viewer navigation hot path avoids sync FS when snapshot is populated", () => {
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

	test("navigateSubagentView root direction reads groups from snapshot without sync FS", async () => {
		const ref1 = makeRef("0-Explore");
		const ref2 = makeRef("1-Research", { agent: "research" });
		const group1 = makeGroup("0-Explore", [ref1]);
		const group2 = makeGroup("1-Research", [ref2]);
		const mode = createModeWithSnapshot([ref1, ref2], [group1, group2]) as any;

		await mode.navigateSubagentView("root", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalledTimes(1);
		expect(mode.renderSubagentSession).toHaveBeenCalledTimes(1);
	});

	test("navigateSubagentView root backward cycles to last group from snapshot", async () => {
		const ref1 = makeRef("0-Explore");
		const ref2 = makeRef("1-Research", { agent: "research" });
		const group1 = makeGroup("0-Explore", [ref1]);
		const group2 = makeGroup("1-Research", [ref2]);
		const mode = createModeWithSnapshot([ref1, ref2], [group1, group2]) as any;

		await mode.navigateSubagentView("root", -1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.subagentViewActiveId).toBeDefined();
	});

	test("navigateSubagentView nested direction reads from snapshot without sync FS", async () => {
		const rootRef = makeRef("0-Worker", { agent: "implement" });
		const nestedRef = makeRef("0-Worker.0-Lint", {
			agent: "lint",
			rootId: "0-Worker",
			parentId: "0-Worker",
			depth: 1,
		});
		const group = makeGroup("0-Worker", [rootRef, nestedRef]);
		const mode = createModeWithSnapshot([rootRef, nestedRef], [group]) as any;

		// Set active view on root
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;

		await mode.navigateSubagentView("nested", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	// NOTE: empty snapshot falls through to collectSubagentViewRefs() — production gap.
	// The empty-groups path in getSnapshotGroups() does not short-circuit; it falls
	// through to legacy sync discovery. This will be fixed in Unit 2.5 wiring.

	test("refreshActiveViewerTranscript reads groups from snapshot without sync FS", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const mode = createModeWithSnapshot([ref], [group]) as any;

		// Set active viewer state (simulates viewer being open)
		mode.subagentViewActiveId = "0-Explore";
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;

		await mode.refreshActiveViewerTranscript();

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalled();
	});

	test("refreshActiveViewerTranscript exits when active ID vanishes from snapshot", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const mode = createModeWithSnapshot([ref], [group]) as any;

		// Set viewer active for a different ID that no longer exists in snapshot
		mode.subagentViewActiveId = "0-Vanished";
		mode.subagentCycleIndex = 0;

		await mode.refreshActiveViewerTranscript();

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	test("consecutive navigateSubagentView calls cycle through groups from snapshot", async () => {
		const ref1 = makeRef("0-A");
		const ref2 = makeRef("1-B", { agent: "research" });
		const ref3 = makeRef("2-C", { agent: "implement" });
		const groups = [makeGroup("0-A", [ref1]), makeGroup("1-B", [ref2]), makeGroup("2-C", [ref3])];
		const mode = createModeWithSnapshot([ref1, ref2, ref3], groups) as any;

		await mode.navigateSubagentView("root", 1);
		await mode.navigateSubagentView("root", 1);
		await mode.navigateSubagentView("root", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalledTimes(3);
	});
});

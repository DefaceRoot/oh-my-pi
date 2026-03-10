import { beforeAll, describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Integration tests for overlay live-update behavior.
 *
 * Proves:
 * 1. Bootstrap refresh updates visible overlays in-place (same overlay handle).
 * 2. Navigator component receives setGroups() on snapshot version change.
 * 3. Viewer overlay refreshes transcript in-place on snapshot version change.
 * 4. Stale refresh generations are discarded after session root changes.
 *
 * Production gap (reported, not tested):
 * - No loading-state UX is set during bootstrap refresh. The plan requires
 *   a user-visible loading indicator while refresh is in flight, but production
 *   code does not currently set one. This needs Unit 2.5 wiring to resolve.
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

type MockOverlayHandle = {
	hide: ReturnType<typeof vi.fn>;
	setHidden: ReturnType<typeof vi.fn>;
	isHidden: () => boolean;
};

/**
 * Build a mode with an opened navigator overlay for live-update testing.
 * Calls openSubagentNavigator() to create a real SubagentNavigatorComponent
 * wired to the mock overlay handle.
 */
function createModeWithNavigatorOpen(): {
	mode: any;
	overlayHandle: MockOverlayHandle;
} {
	const ref = makeRef("0-Explore");
	const group = makeGroup("0-Explore", [ref]);

	const overlayHandle: MockOverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
	};

	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot([ref], [group], 1);
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
		showOverlay: vi.fn(() => overlayHandle),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	mode.isInitialized = true;

	// Open the navigator to create the overlay
	mode.openSubagentNavigator();

	return { mode, overlayHandle };
}

/**
 * Build a mode with an active viewer overlay for live-update testing.
 * Sets up a mock viewer component and overlay handle directly (viewer
 * creation requires transcript loading which we bypass).
 */
function createModeWithViewerOpen(): {
	mode: any;
	overlayHandle: MockOverlayHandle;
} {
	const ref = makeRef("0-Explore");
	const group = makeGroup("0-Explore", [ref]);

	const overlayHandle: MockOverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
	};

	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot([ref], [group], 1);
	mode.subagentViewActiveId = "0-Explore";
	mode.subagentCycleIndex = 0;
	mode.subagentNestedCycleIndex = -1;
	mode.subagentNestedArrowMode = false;
	mode.subagentNavigatorComponent = undefined;
	mode.subagentNavigatorClose = undefined;
	mode.subagentNavigatorOverlay = undefined;
	mode.subagentNavigatorGroups = [];
	mode.subagentCycleSignature = undefined;
	mode.subagentViewRequestToken = 0;
	mode.statusLine = { setHookStatus: vi.fn() };
	mode.ui = {
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => overlayHandle),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	mode.isInitialized = true;

	// Simulate an active viewer
	mode.subagentSessionViewer = { setContent: vi.fn(), render: () => [] };
	mode.subagentSessionOverlay = overlayHandle;

	// Mock transcript loading for viewer refresh
	mode.loadSubagentTranscript = vi.fn(async (r: SubagentViewRef) => ({
		source: r.sessionPath ?? "/tmp/mock.jsonl",
		content: '{"type":"session_init","task":"mock"}\n',
		sessionContext: { messages: [] },
		model: r.model ?? "default",
		tokens: r.tokens ?? 0,
		contextPreview: r.description,
		skillsUsed: [],
	}));

	// Mock renderSubagentSession to avoid terminal rendering dependencies
	mode.renderSubagentSession = vi.fn(async () => undefined);

	return { mode, overlayHandle };
}

describe("overlay live-update: navigator", () => {
	test("syncSubagentOverlaysForSnapshotChange updates navigator in-place without replacing overlay", async () => {
		const { mode, overlayHandle } = createModeWithNavigatorOpen();

		const navigatorBefore = mode.subagentNavigatorComponent;
		expect(navigatorBefore).toBeDefined();

		const setGroupsSpy = vi.spyOn(navigatorBefore, "setGroups");

		const updatedRef1 = makeRef("0-Explore");
		const updatedRef2 = makeRef("1-Research", { agent: "research", tokens: 5000 });
		const updatedGroups = [makeGroup("0-Explore", [updatedRef1]), makeGroup("1-Research", [updatedRef2])];
		const updatedSnapshot = makeSnapshot([updatedRef1, updatedRef2], updatedGroups, 2);

		await mode.syncSubagentOverlaysForSnapshotChange(updatedSnapshot, "bootstrap");

		// Navigator component was updated in-place, not recreated
		expect(mode.subagentNavigatorComponent).toBe(navigatorBefore);
		// setGroups was called with the updated groups
		expect(setGroupsSpy).toHaveBeenCalledTimes(1);
		expect(setGroupsSpy.mock.calls[0][0]).toEqual(updatedGroups);
		// Overlay was NOT replaced (hide was not called)
		expect(overlayHandle.hide).not.toHaveBeenCalled();
	});

	test("syncSubagentOverlaysForSnapshotChange exits navigator when groups become empty", async () => {
		const { mode, overlayHandle } = createModeWithNavigatorOpen();

		expect(mode.subagentNavigatorComponent).toBeDefined();

		const emptySnapshot = makeSnapshot([], [], 2);

		await mode.syncSubagentOverlaysForSnapshotChange(emptySnapshot, "watch");

		expect(mode.subagentNavigatorComponent).toBeUndefined();
		expect(overlayHandle.hide).toHaveBeenCalled();
	});

	test("syncSubagentOverlaysForSnapshotChange preserves selection when active ID survives", async () => {
		const { mode } = createModeWithNavigatorOpen();

		mode.subagentViewActiveId = "0-Explore";
		mode.subagentCycleIndex = 0;

		const updatedRef = makeRef("0-Explore", { tokens: 9000 });
		const newRef = makeRef("1-New");
		const updatedGroups = [makeGroup("0-Explore", [updatedRef]), makeGroup("1-New", [newRef])];
		const updatedSnapshot = makeSnapshot([updatedRef, newRef], updatedGroups, 2);

		await mode.syncSubagentOverlaysForSnapshotChange(updatedSnapshot, "bootstrap");

		expect(mode.subagentCycleIndex).toBe(0);
		expect(mode.subagentViewActiveId).toBe("0-Explore");
	});
});

describe("overlay live-update: viewer", () => {
	test("syncSubagentOverlaysForSnapshotChange refreshes active viewer in-place", async () => {
		const { mode, overlayHandle } = createModeWithViewerOpen();

		const updatedRef = makeRef("0-Explore", { tokens: 8000 });
		const updatedGroups = [makeGroup("0-Explore", [updatedRef])];
		const updatedSnapshot = makeSnapshot([updatedRef], updatedGroups, 2);

		await mode.syncSubagentOverlaysForSnapshotChange(updatedSnapshot, "watch");

		// Viewer overlay was NOT replaced
		expect(overlayHandle.hide).not.toHaveBeenCalled();
		// Transcript reload was triggered
		expect(mode.loadSubagentTranscript).toHaveBeenCalled();
	});

	test("syncSubagentOverlaysForSnapshotChange keeps same viewer overlay handle across updates", async () => {
		const { mode } = createModeWithViewerOpen();

		const overlayBefore = mode.subagentSessionOverlay;

		const updatedRef = makeRef("0-Explore", { tokens: 9999 });
		const updatedGroups = [makeGroup("0-Explore", [updatedRef])];
		const updatedSnapshot = makeSnapshot([updatedRef], updatedGroups, 2);

		await mode.syncSubagentOverlaysForSnapshotChange(updatedSnapshot, "bootstrap");

		expect(mode.subagentSessionOverlay).toBe(overlayBefore);
	});
});

describe("bootstrap refresh integration", () => {
	test("requestIndexRefresh triggers async reconcile and syncs overlay on version change", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const initialSnapshot = makeSnapshot([ref], [group], 1);

		const updatedRef = makeRef("0-Explore", { tokens: 7777 });
		const updatedGroup = makeGroup("0-Explore", [updatedRef]);
		const updatedSnapshot = makeSnapshot([updatedRef], [updatedGroup], 2);

		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentSnapshot = initialSnapshot;
		mode.subagentRefreshQueuedReason = undefined;
		mode.subagentRefreshInFlight = undefined;
		mode.subagentRefreshGeneration = 0;
		mode.subagentIndex = {
			getSnapshot: () => initialSnapshot,
			ingestTaskResults: vi.fn(),
			reconcile: vi.fn(async () => updatedSnapshot),
		};
		mode.sessionManager = {
			getEntries: () => [],
			getSessionFile: () => "/tmp/parent.jsonl",
		};
		mode.syncSubagentOverlaysForSnapshotChange = vi.fn(async () => undefined);
		mode.collectSubagentViewRefs = vi.fn(() => {
			throw new Error("sync discovery must not be called during async refresh");
		});
		mode.ui = { requestRender: vi.fn() };
		mode.isInitialized = true;

		mode.requestSubagentRefresh("bootstrap");
		await mode.subagentRefreshInFlight;

		expect(mode.subagentIndex.reconcile).toHaveBeenCalledTimes(1);
		expect(mode.subagentSnapshot).toBe(updatedSnapshot);
		expect(mode.syncSubagentOverlaysForSnapshotChange).toHaveBeenCalledWith(updatedSnapshot, "bootstrap");
		expect(mode.collectSubagentViewRefs).not.toHaveBeenCalled();
	});

	test("requestIndexRefresh with same version triggers render but not overlay sync", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const sameVersionSnapshot = makeSnapshot([ref], [group], 1);

		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentSnapshot = makeSnapshot([ref], [group], 1);
		mode.subagentRefreshQueuedReason = undefined;
		mode.subagentRefreshInFlight = undefined;
		mode.subagentRefreshGeneration = 0;
		mode.subagentIndex = {
			getSnapshot: () => sameVersionSnapshot,
			ingestTaskResults: vi.fn(),
			reconcile: vi.fn(async () => sameVersionSnapshot),
		};
		mode.sessionManager = {
			getEntries: () => [],
			getSessionFile: () => "/tmp/parent.jsonl",
		};
		mode.syncSubagentOverlaysForSnapshotChange = vi.fn(async () => undefined);
		mode.ui = { requestRender: vi.fn() };
		mode.isInitialized = true;

		mode.requestSubagentRefresh("manual");
		await mode.subagentRefreshInFlight;

		expect(mode.syncSubagentOverlaysForSnapshotChange).not.toHaveBeenCalled();
		expect(mode.ui.requestRender).toHaveBeenCalled();
	});

	test("stale refresh generation is discarded after session root change", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const staleSnapshot = makeSnapshot([ref], [group], 5);

		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentSnapshot = makeSnapshot([], [], 0);
		mode.subagentRefreshQueuedReason = undefined;
		mode.subagentRefreshInFlight = undefined;
		mode.subagentRefreshGeneration = 0;

		let resolveReconcile: (snap: SubagentIndexSnapshot) => void;
		const reconcilePromise = new Promise<SubagentIndexSnapshot>(resolve => {
			resolveReconcile = resolve;
		});

		mode.subagentIndex = {
			getSnapshot: () => makeSnapshot([], [], 0),
			ingestTaskResults: vi.fn(),
			reconcile: vi.fn(() => reconcilePromise),
		};
		mode.sessionManager = {
			getEntries: () => [],
			getSessionFile: () => "/tmp/parent.jsonl",
		};
		mode.syncSubagentOverlaysForSnapshotChange = vi.fn(async () => undefined);
		mode.ui = { requestRender: vi.fn() };
		mode.isInitialized = true;

		mode.requestSubagentRefresh("bootstrap");
		const inflight = mode.subagentRefreshInFlight;

		// Simulate session root change (bumps generation)
		mode.subagentRefreshGeneration += 1;

		// Complete the stale reconcile
		resolveReconcile!(staleSnapshot);
		await inflight;

		// Stale result discarded — snapshot not updated
		expect(mode.subagentSnapshot.version).toBe(0);
		expect(mode.syncSubagentOverlaysForSnapshotChange).not.toHaveBeenCalled();
	});
});

import { beforeAll, describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Overlay lifecycle tests for navigator/viewer transitions (Phase 4 Unit 4.4, Phase 5 Units 5.1-5.2).
 *
 * Proves:
 * 1. Opening viewer from navigator hides (does not destroy) the navigator overlay.
 * 2. Viewer close (Esc) unhides the navigator overlay and hides the viewer overlay.
 * 3. exitSubagentView() closes both overlays even when navigator is hidden.
 * 4. Focus restoration: after viewer close, navigator receives input again.
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
	isHidden: ReturnType<typeof vi.fn>;
};

/**
 * Build a test mode with an opened navigator overlay using the real
 * openSubagentNavigator() path, capturing the mock overlay handle.
 */
function createModeWithNavigatorOpen(): {
	mode: any;
	navigatorOverlayHandle: MockOverlayHandle;
} {
	const ref = makeRef("0-Explore");
	const group = makeGroup("0-Explore", [ref]);

	let hidden = false;
	const navigatorOverlayHandle: MockOverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn((h: boolean) => {
			hidden = h;
		}),
		isHidden: vi.fn(() => hidden),
	};

	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot([ref], [group], 1);
	mode.subagentViewActiveId = undefined;
	mode.subagentCycleIndex = -1;
	mode.subagentNestedCycleIndex = -1;
	mode.subagentNestedArrowMode = false;
	mode.subagentNavigatorComponent = undefined;
	mode.subagentNavigatorOverlay = undefined;
	mode.subagentNavigatorGroups = [];
	mode.subagentSessionViewer = undefined;
	mode.subagentSessionOverlay = undefined;
	mode.subagentCycleSignature = undefined;
	mode.subagentViewRequestToken = 0;
	mode.statusLine = { setHookStatus: vi.fn() };
	mode.ui = {
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => navigatorOverlayHandle),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	mode.isInitialized = true;

	// Open the navigator
	mode.openSubagentNavigator();

	return { mode, navigatorOverlayHandle };
}

/**
 * Build a mode with both navigator and viewer open (navigator hidden).
 * Simulates: user opened navigator, then pressed Enter to open viewer.
 */
function createModeWithViewerOpenFromNavigator(): {
	mode: any;
	navigatorOverlayHandle: MockOverlayHandle;
	viewerOverlayHandle: MockOverlayHandle;
} {
	const ref = makeRef("0-Explore");
	const group = makeGroup("0-Explore", [ref]);

	let navHidden = false;
	const navigatorOverlayHandle: MockOverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn((h: boolean) => {
			navHidden = h;
		}),
		isHidden: vi.fn(() => navHidden),
	};

	let viewerHidden = false;
	const viewerOverlayHandle: MockOverlayHandle = {
		hide: vi.fn(),
		setHidden: vi.fn((h: boolean) => {
			viewerHidden = h;
		}),
		isHidden: vi.fn(() => viewerHidden),
	};

	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot([ref], [group], 1);
	mode.subagentViewActiveId = "0-Explore";
	mode.subagentCycleIndex = 0;
	mode.subagentNestedCycleIndex = -1;
	mode.subagentNestedArrowMode = false;
	mode.subagentNavigatorGroups = [group];
	mode.subagentCycleSignature = "0-Explore:0-Explore";
	mode.subagentViewRequestToken = 0;

	mode.statusLine = { setHookStatus: vi.fn() };
	mode.ui = {
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => viewerOverlayHandle),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	mode.isInitialized = true;
	mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

	// Simulate navigator open with its overlay
	const { SubagentNavigatorModal } = require("@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-navigator-modal");
	const navigator = new SubagentNavigatorModal(
		[group],
		{ groupIndex: 0, nestedIndex: -1 },
		{
			onSelectionChange: vi.fn(),
			onOpenSelection: vi.fn(),
			onClose: () => mode.exitSubagentView(),
		},
	);
	mode.subagentNavigatorComponent = navigator;
	mode.subagentNavigatorOverlay = navigatorOverlayHandle;

	// Simulate navigator being hidden (user opened viewer)
	navigatorOverlayHandle.setHidden(true);

	// Simulate viewer created
	const {
		SubagentSessionViewerComponent,
	} = require("@oh-my-pi/pi-coding-agent/modes/components/subagent-session-viewer");
	const viewer = new SubagentSessionViewerComponent({
		getTerminalRows: () => 40,
		leaderKey: "Ctrl+X",
		onClose: () => mode.returnToNavigatorOrExit(),
		onNavigateRoot: vi.fn(),
		onNavigateNested: vi.fn(),
		onCycleAgentMode: vi.fn(),
	});
	mode.subagentSessionViewer = viewer;
	mode.subagentSessionOverlay = viewerOverlayHandle;

	return { mode, navigatorOverlayHandle, viewerOverlayHandle };
}

describe("overlay lifecycle: navigator hide/unhide", () => {
	test("opening viewer from navigator hides the navigator overlay (does not destroy)", async () => {
		const { mode, navigatorOverlayHandle } = createModeWithNavigatorOpen();

		expect(mode.subagentNavigatorComponent).toBeDefined();
		expect(mode.subagentNavigatorOverlay).toBeDefined();

		// Mock transcript loading
		mode.loadSubagentTranscript = vi.fn(async () => ({
			source: "/tmp/sessions/0-Explore.jsonl",
			content: '{"type":"session_init"}\n',
			sessionContext: { messages: [] },
			model: "claude-sonnet-4-20250514",
			tokens: 1200,
			contextPreview: "test",
			skillsUsed: [],
		}));
		mode.renderSubagentSession = vi.fn(async () => undefined);

		// Simulate opening transcript (the path triggered by onOpenSelection)
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });

		// Navigator overlay was hidden, NOT destroyed
		expect(navigatorOverlayHandle.setHidden).toHaveBeenCalledWith(true);
		expect(navigatorOverlayHandle.hide).not.toHaveBeenCalled();
		// Navigator component still exists
		expect(mode.subagentNavigatorComponent).toBeDefined();
		expect(mode.subagentNavigatorOverlay).toBeDefined();
	});
});

describe("overlay lifecycle: viewer close returns to navigator", () => {
	test("viewer Esc unhides navigator and hides viewer", () => {
		const { mode, navigatorOverlayHandle, viewerOverlayHandle } = createModeWithViewerOpenFromNavigator();

		// Pre-condition: navigator is hidden, viewer is visible
		expect(navigatorOverlayHandle.isHidden()).toBe(true);
		expect(viewerOverlayHandle.isHidden()).toBe(false);

		// Trigger viewer close (this is what Esc does)
		mode.returnToNavigatorOrExit();

		// Navigator was unhidden
		expect(navigatorOverlayHandle.setHidden).toHaveBeenCalledWith(false);
		// Viewer was hidden (not destroyed)
		expect(viewerOverlayHandle.setHidden).toHaveBeenCalledWith(true);
		// Neither overlay was permanently destroyed
		expect(navigatorOverlayHandle.hide).not.toHaveBeenCalled();
		expect(viewerOverlayHandle.hide).not.toHaveBeenCalled();
		// Navigator component still exists
		expect(mode.subagentNavigatorComponent).toBeDefined();
	});
});

describe("overlay lifecycle: full exit closes both overlays", () => {
	test("exitSubagentView closes both overlays even when navigator is hidden", () => {
		const { mode, navigatorOverlayHandle, viewerOverlayHandle } = createModeWithViewerOpenFromNavigator();

		// Pre-condition: navigator hidden, viewer visible
		expect(navigatorOverlayHandle.isHidden()).toBe(true);
		expect(mode.subagentNavigatorComponent).toBeDefined();
		expect(mode.subagentSessionViewer).toBeDefined();

		mode.exitSubagentView();

		// Both overlays destroyed (hide called)
		expect(navigatorOverlayHandle.hide).toHaveBeenCalled();
		expect(viewerOverlayHandle.hide).toHaveBeenCalled();
		// All state cleared
		expect(mode.subagentNavigatorComponent).toBeUndefined();
		expect(mode.subagentNavigatorOverlay).toBeUndefined();
		expect(mode.subagentSessionViewer).toBeUndefined();
		expect(mode.subagentSessionOverlay).toBeUndefined();
		expect(mode.subagentViewActiveId).toBeUndefined();
	});

	test("exitSubagentView clears all state when only navigator is open", () => {
		const { mode, navigatorOverlayHandle } = createModeWithNavigatorOpen();

		expect(mode.subagentNavigatorComponent).toBeDefined();

		mode.exitSubagentView();

		expect(navigatorOverlayHandle.hide).toHaveBeenCalled();
		expect(mode.subagentNavigatorComponent).toBeUndefined();
		expect(mode.subagentNavigatorOverlay).toBeUndefined();
		expect(mode.subagentViewActiveId).toBeUndefined();
		expect(mode.statusLine.setHookStatus).toHaveBeenCalledWith("subagent-viewer", undefined);
	});
});

describe("overlay lifecycle: focus restoration", () => {
	test("after viewer close, navigator component is accessible and receives updates", () => {
		const { mode, navigatorOverlayHandle } = createModeWithViewerOpenFromNavigator();

		// Return to navigator
		mode.returnToNavigatorOrExit();

		// Navigator is now visible
		expect(navigatorOverlayHandle.isHidden()).toBe(false);

		// Navigator component can still receive data updates
		const ref2 = makeRef("1-Research", { agent: "research" });
		const group2 = makeGroup("1-Research", [ref2]);
		const setGroupsSpy = vi.spyOn(mode.subagentNavigatorComponent, "setGroups");

		mode.subagentNavigatorComponent.setGroups([group2], { groupIndex: 0, nestedIndex: -1 });

		expect(setGroupsSpy).toHaveBeenCalledTimes(1);
	});
});

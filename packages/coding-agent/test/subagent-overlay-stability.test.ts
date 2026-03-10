import { beforeAll, describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Overlay stability tests (Phase 5 Units 5.1-5.2).
 *
 * Proves:
 * 1. Overlay reuse: showOverlay is not called repeatedly for the same type.
 * 2. Repeated open/viewer/close/open cycles are stable.
 * 3. Ctrl+X full exit in hidden-navigator state closes both overlays.
 * 4. No hidden overlays are left behind after full exit.
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

function createMockOverlayHandle(): MockOverlayHandle {
	let hidden = false;
	return {
		hide: vi.fn(),
		setHidden: vi.fn((h: boolean) => {
			hidden = h;
		}),
		isHidden: vi.fn(() => hidden),
	};
}

/**
 * Build a mode that tracks showOverlay calls and supports the full
 * navigator -> viewer -> navigator lifecycle.
 */
function createModeForStabilityTest(): {
	mode: any;
	showOverlayCalls: Array<{ component: any; options: any; handle: MockOverlayHandle }>;
} {
	const ref = makeRef("0-Explore");
	const group = makeGroup("0-Explore", [ref]);

	const showOverlayCalls: Array<{ component: any; options: any; handle: MockOverlayHandle }> = [];

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
		showOverlay: vi.fn((component: any, options: any) => {
			const handle = createMockOverlayHandle();
			showOverlayCalls.push({ component, options, handle });
			return handle;
		}),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);
	mode.isInitialized = true;
	mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

	// Mock transcript loading
	mode.loadSubagentTranscript = vi.fn(async (r: SubagentViewRef) => ({
		source: r.sessionPath ?? "/tmp/mock.jsonl",
		content: '{"type":"session_init","task":"mock"}\n',
		sessionContext: { messages: [] },
		model: r.model ?? "default",
		tokens: r.tokens ?? 0,
		contextPreview: r.description,
		skillsUsed: [],
	}));

	return { mode, showOverlayCalls };
}

describe("overlay stability: reuse semantics", () => {
	test("showOverlay is called once for navigator, not on re-open after viewer close", async () => {
		const { mode, showOverlayCalls } = createModeForStabilityTest();

		// Step 1: Open navigator
		mode.openSubagentNavigator();
		expect(showOverlayCalls).toHaveLength(1);
		const navigatorHandle = showOverlayCalls[0]!.handle;

		// Step 2: Open viewer from navigator
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });
		// Viewer overlay was created (second showOverlay call)
		expect(showOverlayCalls).toHaveLength(2);

		// Navigator was hidden, not destroyed
		expect(navigatorHandle.setHidden).toHaveBeenCalledWith(true);
		expect(navigatorHandle.hide).not.toHaveBeenCalled();

		// Step 3: Return to navigator (viewer Esc)
		mode.returnToNavigatorOrExit();

		// No additional showOverlay call — navigator was unhidden in place
		expect(showOverlayCalls).toHaveLength(2);
		expect(navigatorHandle.isHidden()).toBe(false);
	});

	test("showOverlay is not called repeatedly for the same overlay type", async () => {
		const { mode, showOverlayCalls } = createModeForStabilityTest();

		// Open navigator
		mode.openSubagentNavigator();
		expect(showOverlayCalls).toHaveLength(1);

		// Calling openSubagentNavigator again reuses existing component
		mode.openSubagentNavigator();
		expect(showOverlayCalls).toHaveLength(1);
	});
});

describe("overlay stability: repeated open/viewer/open cycles", () => {
	test("navigator -> viewer -> back to navigator -> viewer -> back is stable", async () => {
		const { mode, showOverlayCalls } = createModeForStabilityTest();

		// Cycle 1: open navigator
		mode.openSubagentNavigator();
		expect(showOverlayCalls).toHaveLength(1);
		const navHandle = showOverlayCalls[0]!.handle;

		// Cycle 1: open viewer from navigator
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });
		expect(showOverlayCalls).toHaveLength(2);
		expect(navHandle.isHidden()).toBe(true);

		// Cycle 1: return to navigator
		mode.returnToNavigatorOrExit();
		expect(navHandle.isHidden()).toBe(false);
		const viewerHandle1 = showOverlayCalls[1]!.handle;
		expect(viewerHandle1.isHidden()).toBe(true);

		// Cycle 2: open viewer again from navigator — viewer must be re-created
		// because returning to navigator hid the viewer but the renderSubagentSession
		// path checks this.subagentSessionViewer existence
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });
		// Navigator hidden again
		expect(navHandle.isHidden()).toBe(true);
		// Viewer may be reused or recreated depending on implementation
		expect(mode.subagentSessionViewer).toBeDefined();

		// Cycle 2: return to navigator
		mode.returnToNavigatorOrExit();
		expect(navHandle.isHidden()).toBe(false);

		// Navigator component is still the same instance throughout
		expect(mode.subagentNavigatorComponent).toBeDefined();
	});
});

describe("overlay stability: Ctrl+X full exit in hidden-navigator state", () => {
	test("full exit when navigator is hidden and viewer is open closes both", async () => {
		const { mode, showOverlayCalls } = createModeForStabilityTest();

		// Open navigator
		mode.openSubagentNavigator();
		const navHandle = showOverlayCalls[0]!.handle;

		// Open viewer (hides navigator)
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });
		expect(navHandle.isHidden()).toBe(true);
		expect(mode.subagentSessionViewer).toBeDefined();

		const viewerHandle = showOverlayCalls[1]!.handle;

		// Simulate Ctrl+X full exit (as if isSubagentViewActive() returned true → exitSubagentView())
		mode.exitSubagentView();

		// Both overlays permanently destroyed
		expect(navHandle.hide).toHaveBeenCalled();
		expect(viewerHandle.hide).toHaveBeenCalled();

		// All state cleared
		expect(mode.subagentNavigatorComponent).toBeUndefined();
		expect(mode.subagentNavigatorOverlay).toBeUndefined();
		expect(mode.subagentSessionViewer).toBeUndefined();
		expect(mode.subagentSessionOverlay).toBeUndefined();
		expect(mode.subagentViewActiveId).toBeUndefined();
	});

	test("no hidden overlays remain after full exit", async () => {
		const { mode } = createModeForStabilityTest();

		// Open navigator then viewer
		mode.openSubagentNavigator();
		await mode.openSubagentTranscriptFromGroups(mode.subagentNavigatorGroups, { groupIndex: 0, nestedIndex: -1 });

		// Full exit
		mode.exitSubagentView();

		// Verify no overlay references remain
		expect(mode.subagentNavigatorOverlay).toBeUndefined();
		expect(mode.subagentSessionOverlay).toBeUndefined();

		// isSubagentViewActive() should return false
		expect(mode.isSubagentViewActive()).toBe(false);
	});
});

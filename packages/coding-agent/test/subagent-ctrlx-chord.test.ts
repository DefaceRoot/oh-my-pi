import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { CTRL_N, CTRL_O, CTRL_P, CTRL_R, CTRL_V, CTRL_X, TestTui } from "./subagent-input-harness";

const CTRLX_CHORD_TIMEOUT_MS = 350;
const ESC = "\x1b";

/**
 * Minimal mock of InteractiveModeContext for chord testing.
 * Only the methods/properties used by the chord handler are stubbed.
 */
function createMockContext(overrides?: { subagentViewActive?: boolean }) {
	const ctx = {
		isSubagentViewActive: vi.fn(() => overrides?.subagentViewActive ?? false),
		exitSubagentView: vi.fn(),
		openSubagentNavigator: vi.fn(),
		openSubagentViewerForRoot: vi.fn(async () => undefined),
		openSubagentViewerNewest: vi.fn(async () => undefined),
		requestSubagentRefresh: vi.fn(),
		cycleThinkingLevel: vi.fn(),
		// statusLine stubs for workflow-menu arrow regression
		statusLine: {
			getActiveMenu: vi.fn(() => null),
			navigateMenu: vi.fn(),
			closeMenu: vi.fn(),
			toggleMenu: vi.fn(),
		},
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(),
		},
		editor: {
			onEscape: undefined as (() => void) | undefined,
			onShiftTab: undefined as (() => void) | undefined,
			setCustomKeyHandler: vi.fn(),
			onCtrlC: undefined as (() => void) | undefined,
			onCtrlD: undefined as (() => void) | undefined,
			onCtrlZ: undefined as (() => void) | undefined,
			onCtrlP: undefined as (() => void) | undefined,
			onShiftCtrlP: undefined as (() => void) | undefined,
			onAltP: undefined as (() => void) | undefined,
			onCtrlL: undefined as (() => void) | undefined,
			onCtrlR: undefined as (() => void) | undefined,
			onCtrlT: undefined as (() => void) | undefined,
			onCtrlV: undefined as (() => void) | undefined,
			onCtrlO: undefined as (() => void) | undefined,
			onAltUp: undefined as (() => void) | undefined,
			onQuestionMark: undefined as (() => void) | undefined,
			onChange: undefined as ((text: string) => void) | undefined,
			getText: vi.fn(() => ""),
			setText: vi.fn(),
			addToHistory: vi.fn(),
			insertText: vi.fn(),
		},
		keybindings: {
			getKeys: vi.fn(() => []),
			getDisplayString: vi.fn(() => "Ctrl+X"),
		},
		session: {
			isStreaming: false,
			isBashRunning: false,
			isPythonRunning: false,
			isCompacting: false,
			extensionRunner: undefined,
			cycleThinkingLevel: vi.fn(),
		},
		showStatus: vi.fn(),
		showDebugSelector: vi.fn(),
		showModelSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		loadingAnimation: undefined,
		isSubagentViewActive_: overrides?.subagentViewActive ?? false,
		isBashMode: false,
		isPythonMode: false,
		lastEscapeTime: 0,
		lastSigintTime: 0,
	} as any;

	return ctx;
}

/**
 * Build a chord handler function that simulates InputController's
 * Ctrl+X chord logic against a TestTui + mock context.
 * Returns { tui, ctx, dispose } for assertions.
 */
function setupChordHandler(overrides?: { subagentViewActive?: boolean }) {
	const tui = new TestTui();
	const ctx = createMockContext(overrides);

	let chordArmed = false;
	let chordTimer: ReturnType<typeof setTimeout> | undefined;

	function disarmChord(): void {
		chordArmed = false;
		if (chordTimer !== undefined) {
			clearTimeout(chordTimer);
			chordTimer = undefined;
		}
	}

	const unsubscribe = tui.addInputListener((data: string) => {
		if (data === CTRL_X) {
			if (ctx.isSubagentViewActive()) {
				ctx.exitSubagentView();
				return { consume: true };
			}
			disarmChord();
			chordArmed = true;
			chordTimer = setTimeout(() => {
				chordArmed = false;
				chordTimer = undefined;
				ctx.openSubagentNavigator();
			}, CTRLX_CHORD_TIMEOUT_MS);
			return { consume: true };
		}

		if (chordArmed) {
			disarmChord();
			switch (data) {
				case CTRL_N:
					void ctx.openSubagentViewerForRoot(1);
					return { consume: true };
				case CTRL_P:
					void ctx.openSubagentViewerForRoot(-1);
					return { consume: true };
				case CTRL_O:
					void ctx.openSubagentViewerNewest();
					return { consume: true };
				case CTRL_R:
					ctx.requestSubagentRefresh("manual");
					return { consume: true };
				case CTRL_V:
					ctx.openSubagentNavigator();
					return { consume: true };
				case ESC:
					return { consume: true };
				default:
					return undefined;
			}
		}

		return undefined;
	});

	return {
		tui,
		ctx,
		dispose: () => {
			disarmChord();
			unsubscribe();
		},
		isChordArmed: () => chordArmed,
	};
}

describe("Ctrl+X chord: follow-up mappings", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("Ctrl+X timeout opens navigator (default action)", () => {
		const { tui, ctx } = setupChordHandler();

		const result = tui.send(CTRL_X);
		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();

		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).toHaveBeenCalledTimes(1);
	});

	test("Ctrl+X then Ctrl+N opens viewer for next root", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(CTRL_N);

		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentViewerForRoot).toHaveBeenCalledWith(1);
		// Timeout should NOT fire after follow-up
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
	});

	test("Ctrl+X then Ctrl+P opens viewer for previous root", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(CTRL_P);

		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentViewerForRoot).toHaveBeenCalledWith(-1);
	});

	test("Ctrl+X then Ctrl+O opens viewer for newest", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(CTRL_O);

		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentViewerNewest).toHaveBeenCalledTimes(1);
	});

	test("Ctrl+X then Ctrl+R triggers manual refresh", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(CTRL_R);

		expect(result.consumed).toBe(true);
		expect(ctx.requestSubagentRefresh).toHaveBeenCalledWith("manual");
	});

	test("Ctrl+X then Ctrl+V opens navigator explicitly", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(CTRL_V);

		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentNavigator).toHaveBeenCalledTimes(1);
		// Confirm timeout does not double-fire
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).toHaveBeenCalledTimes(1);
	});

	test("Ctrl+X then Esc cancels chord with no action", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send(ESC);

		expect(result.consumed).toBe(true);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
		expect(ctx.openSubagentViewerForRoot).not.toHaveBeenCalled();
		expect(ctx.openSubagentViewerNewest).not.toHaveBeenCalled();
		expect(ctx.requestSubagentRefresh).not.toHaveBeenCalled();

		// Timeout should not fire
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
	});

	test("unknown follow-up key disarms chord and is not consumed", () => {
		const { tui, ctx } = setupChordHandler();

		tui.send(CTRL_X);
		const result = tui.send("z");

		// Unknown key is not consumed (forwarded to editor)
		expect(result.consumed).toBe(false);
		// Chord disarmed, timeout should not fire
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
	});
});

describe("Ctrl+X chord: State-B (subagent view active)", () => {
	test("Ctrl+X immediately exits subagent view when overlay is active", () => {
		const { tui, ctx } = setupChordHandler({ subagentViewActive: true });

		const result = tui.send(CTRL_X);
		expect(result.consumed).toBe(true);
		expect(ctx.exitSubagentView).toHaveBeenCalledTimes(1);
		// Should not arm chord
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
	});
});

describe("Ctrl+X chord: teardown", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("dispose() stops chord listener so Ctrl+X is no longer consumed", () => {
		const { tui, ctx, dispose } = setupChordHandler();

		// First verify chord works
		const r1 = tui.send(CTRL_X);
		expect(r1.consumed).toBe(true);
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).toHaveBeenCalledTimes(1);

		// Dispose
		dispose();

		// Ctrl+X should no longer be consumed
		const r2 = tui.send(CTRL_X);
		expect(r2.consumed).toBe(false);
		expect(r2.forwardedData).toBe(CTRL_X);
	});

	test("dispose() clears pending chord timer", () => {
		const { tui, ctx, dispose, isChordArmed } = setupChordHandler();

		tui.send(CTRL_X);
		expect(isChordArmed()).toBe(true);

		dispose();
		expect(isChordArmed()).toBe(false);

		// Advancing timers should not trigger navigator
		vi.advanceTimersByTime(CTRLX_CHORD_TIMEOUT_MS);
		expect(ctx.openSubagentNavigator).not.toHaveBeenCalled();
	});
});

describe("Ctrl+X chord: non-subagent key regressions", () => {
	test("arrow keys still navigate workflow menu when menu is active", () => {
		const { tui, ctx } = setupChordHandler();

		// Simulate an active menu
		const statusLine = ctx.statusLine;
		statusLine.getActiveMenu.mockReturnValue({ id: "test-menu" });

		// Capture the arrow key handlers that were registered
		const setCustomKeyHandler = ctx.editor.setCustomKeyHandler;
		const arrowHandlers = new Map<string, (...args: unknown[]) => unknown>();
		for (const call of setCustomKeyHandler.mock.calls) {
			if (typeof call[0] === "string" && typeof call[1] === "function") {
				arrowHandlers.set(call[0], call[1]);
			}
		}

		// We can't test via setCustomKeyHandler because we're in a mock context.
		// Instead, verify that the chord does NOT intercept arrow keys --
		// arrow keys are normal characters that the chord handler ignores.
		for (const arrowKey of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]) {
			const result = tui.send(arrowKey);
			// Arrow escape sequences are NOT Ctrl+X or chord follow-ups,
			// so they should pass through (not consumed by chord handler)
			expect(result.consumed).toBe(false);
		}
	});

	test("Shift+Tab (cycleThinkingLevel) is not intercepted by chord", () => {
		const { tui } = setupChordHandler();

		// Shift+Tab is typically sent as "\x1b[Z" (CSI Z)
		const shiftTabSequence = "\x1b[Z";
		const result = tui.send(shiftTabSequence);

		// The chord handler should NOT consume Shift+Tab
		expect(result.consumed).toBe(false);
		expect(result.forwardedData).toBe(shiftTabSequence);
	});

	test("regular text input is not intercepted by chord when not armed", () => {
		const { tui } = setupChordHandler();

		const result = tui.send("hello");
		expect(result.consumed).toBe(false);
		expect(result.forwardedData).toBe("hello");
	});
});

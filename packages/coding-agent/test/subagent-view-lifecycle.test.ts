import { describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

describe("InteractiveMode subagent view lifecycle", () => {
	test("exitSubagentView clears overlays, poisons async work, and triggers a redraw", () => {
		const viewerHide = vi.fn();
		const statusLine = { setHookStatus: vi.fn() };
		const ui = { requestRender: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as any;

		mode.subagentViewRequestToken = 4;
		mode.subagentSessionOverlay = { hide: viewerHide };
		mode.subagentSessionViewer = { render: () => [] };
		mode.subagentViewActiveId = "0-task";
		mode.subagentCycleSignature = "sig";
		mode.subagentCycleIndex = 1;
		mode.subagentNestedCycleIndex = 2;
		mode.subagentNestedArrowMode = true;
		mode.statusLine = statusLine;
		mode.ui = ui;

		mode.exitSubagentView();

		expect(mode.subagentViewRequestToken).toBe(5);
		expect(viewerHide).toHaveBeenCalledTimes(1);
		expect(mode.subagentSessionOverlay).toBeUndefined();
		expect(mode.subagentSessionViewer).toBeUndefined();
		expect(mode.subagentViewActiveId).toBeUndefined();
		expect(mode.subagentCycleSignature).toBeUndefined();
		expect(mode.subagentCycleIndex).toBe(-1);
		expect(mode.subagentNestedCycleIndex).toBe(-1);
		expect(mode.subagentNestedArrowMode).toBe(false);
		expect(statusLine.setHookStatus).toHaveBeenLastCalledWith("subagent-viewer", undefined);
		expect(ui.requestRender).toHaveBeenLastCalledWith();
	});

	test("isSubagentViewActive depends on visible viewer state instead of stale selection ids", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;

		mode.subagentSessionViewer = undefined;
		mode.subagentSessionOverlay = undefined;
		mode.subagentViewActiveId = "0-task";
		expect(mode.isSubagentViewActive()).toBe(false);

		mode.subagentSessionOverlay = { hide: () => {} };
		expect(mode.isSubagentViewActive()).toBe(true);
	});
});

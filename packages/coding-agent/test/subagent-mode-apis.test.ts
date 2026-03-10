import { describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";

function makeSnapshot(overrides?: Partial<SubagentIndexSnapshot>): SubagentIndexSnapshot {
	return {
		version: 1,
		updatedAt: Date.now(),
		refs: [],
		groups: [],
		...overrides,
	};
}

describe("InteractiveMode subagent mode APIs", () => {
	test("openSubagentNavigator delegates to the navigator opener", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.openSubagentNavigatorOverlay = vi.fn();

		mode.openSubagentNavigator();

		expect(mode.openSubagentNavigatorOverlay).toHaveBeenCalledWith({ scope: "root", direction: 1 });
	});

	test("openSubagentViewerForRoot delegates root navigation", async () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.navigateSubagentView = vi.fn(async () => undefined);

		await mode.openSubagentViewerForRoot(-1);

		expect(mode.navigateSubagentView).toHaveBeenCalledWith("root", -1);
	});

	test("openSubagentViewerNewest opens the newest root selection", async () => {
		const rootRef: SubagentViewRef = {
			id: "0-Root",
			rootId: "0-Root",
			sessionPath: "/tmp/0-Root.jsonl",
		};
		const group: SubagentViewGroup = {
			rootId: "0-Root",
			refs: [rootRef],
			lastUpdatedMs: Date.now(),
		};
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentSnapshot = makeSnapshot({ refs: [rootRef], groups: [group] });
		mode.openSubagentTranscriptFromNavigator = vi.fn(async () => undefined);

		await mode.openSubagentViewerNewest();

		expect(mode.openSubagentTranscriptFromNavigator).toHaveBeenCalledWith({ groupIndex: 0, nestedIndex: -1 });
	});

	test("requestSubagentRefresh avoids legacy sync discovery hot path", async () => {
		const nextSnapshot = makeSnapshot();
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentIndex = {
			getSnapshot: () => makeSnapshot({ version: 0 }),
			ingestTaskResults: vi.fn(() => nextSnapshot),
			reconcile: vi.fn(async () => nextSnapshot),
		};
		mode.subagentSnapshot = makeSnapshot({ version: 0 });
		mode.subagentRefreshQueuedReason = undefined;
		mode.subagentRefreshInFlight = undefined;
		mode.subagentRefreshGeneration = 0;
		mode.sessionManager = {
			getEntries: () => [],
			getSessionFile: () => "/tmp/parent.jsonl",
		};
		mode.syncSubagentOverlaysForSnapshotChange = vi.fn(async () => undefined);
		mode.collectSubagentViewRefs = vi.fn(() => {
			throw new Error("legacy sync discovery path should not run");
		});
		mode.ui = { requestRender: vi.fn() };

		mode.requestSubagentRefresh("manual");
		await mode.subagentRefreshInFlight;

		expect(mode.subagentIndex.reconcile).toHaveBeenCalledTimes(1);
		expect(mode.collectSubagentViewRefs).not.toHaveBeenCalled();
	});
});

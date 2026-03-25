import { describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";

function createContext(): ConstructorParameters<typeof EventController>[0] {
	return {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { onEscape: undefined },
		statusContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn() },
		rebuildChatFromMessages: vi.fn(),
		addMessageToChat: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
	} as unknown as ConstructorParameters<typeof EventController>[0];
}

describe("EventController auto compaction rendering", () => {
	it("rebuilds chat without appending a duplicate compaction summary block", async () => {
		const ctx = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: {
				summary: "Compaction summary",
				shortSummary: "Short summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 206533,
				details: undefined,
			},
			aborted: false,
			willRetry: false,
		});

		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.addMessageToChat).not.toHaveBeenCalled();
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("shows a neutral status for threshold no-op maintenance", async () => {
		const ctx = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});

		expect(ctx.showStatus).toHaveBeenCalledWith("Auto context-full maintenance skipped");
		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("shows a neutral status for skipped auto-handoff", async () => {
		const ctx = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "handoff",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});

		expect(ctx.showStatus).toHaveBeenCalledWith("Auto-handoff skipped");
		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.reloadTodos).not.toHaveBeenCalled();
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("still warns for real maintenance failures", async () => {
		const ctx = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: provider timeout",
		});

		expect(ctx.showWarning).toHaveBeenCalledWith("Auto-compaction failed: provider timeout");
		expect(ctx.showStatus).not.toHaveBeenCalled();
		expect(ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});

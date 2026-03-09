import { describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";

describe("EventController auto compaction rendering", () => {
	it("rebuilds chat without appending a duplicate compaction summary block", async () => {
		const ctx = {
			isInitialized: true,
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			editor: { onEscape: undefined },
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			flushCompactionQueue: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
		} as unknown as ConstructorParameters<typeof EventController>[0];

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
});

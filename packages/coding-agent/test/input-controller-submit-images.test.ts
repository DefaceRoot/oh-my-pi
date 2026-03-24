import { describe, expect, test, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";

function createBaseContext(options: { streaming: boolean }) {
	const editor = {
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		addToHistory: vi.fn(),
		setText: vi.fn(),
	};

	const session = {
		isStreaming: options.streaming,
		queuedMessageCount: 0,
		isCompacting: false,
		abort: vi.fn(),
		prompt: vi.fn(async () => {}),
		extensionRunner: undefined,
	};

	const ctx = {
		editor,
		statusLine: {
			getActiveMenu: vi.fn(() => undefined),
			executeSelectedMenuAction: vi.fn(),
		},
		session,
		ui: {
			requestRender: vi.fn(),
		},
		pendingImages: [] as any[],
		onInputCallback: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		agent: { state: { messages: [{ role: "user" }] } },
		sessionManager: { getSessionName: vi.fn(() => "existing"), setSessionName: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showSettingsSelector: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		openLazygit: vi.fn(),
		showModelSelector: vi.fn(),
		cycleAgentMode: vi.fn(),
		switchAgentMode: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		queueCompactionMessage: vi.fn(),
		settings: { get: vi.fn(), getModelRole: vi.fn() },
	} as any;

	return { ctx, editor, session };
}

describe("InputController submit handling", () => {
	test("submits pending images even when text is empty (non-streaming)", async () => {
		const { ctx, editor } = createBaseContext({ streaming: false });
		ctx.pendingImages = [{ type: "image", mimeType: "image/png", data: "abc" }];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit!("");

		expect(ctx.onInputCallback).toHaveBeenCalledTimes(1);
		expect(ctx.onInputCallback).toHaveBeenCalledWith({
			text: "",
			images: [{ type: "image", mimeType: "image/png", data: "abc" }],
		});
		expect(ctx.pendingImages).toEqual([]);
		expect(editor.addToHistory).not.toHaveBeenCalled();
	});

	test("submits pending images even when text is empty (streaming)", async () => {
		const { ctx, editor, session } = createBaseContext({ streaming: true });
		ctx.pendingImages = [{ type: "image", mimeType: "image/png", data: "abc" }];
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.onSubmit!("");

		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith("", {
			streamingBehavior: "steer",
			images: [{ type: "image", mimeType: "image/png", data: "abc" }],
		});
		expect(ctx.pendingImages).toEqual([]);
		expect(editor.addToHistory).not.toHaveBeenCalled();
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "../../../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";
import * as titleGenerator from "../../../src/utils/title-generator";

type TestEditor = {
	onSubmit?: (text: string) => Promise<void>;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
};

type TitleSource = "auto" | "user" | undefined;

async function flushMicrotasks(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

function createTitleGenerationContext() {
	let editorText = "";
	const providerSessionId = "provider-session";
	let persistedSessionId = "source-session";
	let sessionName: string | undefined;
	let titleSource: TitleSource;

	const editor: TestEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const setSessionName = vi.fn(async (name: string, source: "auto" | "user" = "auto"): Promise<boolean> => {
		if (titleSource === "user" && source === "auto") return false;
		const normalized = name.trim();
		if (!normalized) return false;
		sessionName = normalized;
		titleSource = source;
		return true;
	});
	const startPendingSubmission = vi.fn(
		(input: { text: string; images?: InteractiveModeContext["pendingImages"] }) => ({
			text: input.text,
			images: input.images,
			cancelled: false,
			started: false,
		}),
	);
	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender: vi.fn() } as unknown as InteractiveModeContext["ui"],
		session: {
			get sessionId() {
				return providerSessionId;
			},
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			messages: [],
			modelRegistry: {},
			model: undefined,
			agent: { metadataForProvider: vi.fn((_provider: string) => undefined) },
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			get titleSource() {
				return titleSource;
			},
			getSessionId: () => persistedSessionId,
			getSessionName: () => sessionName,
			getCwd: () => "/repo",
			setSessionName,
		} as unknown as InteractiveModeContext["sessionManager"],
		settings: { get: vi.fn(() => "online") } as unknown as InteractiveModeContext["settings"],
		pendingImages: [],
		isBashMode: false,
		isPythonMode: false,
		isBackgrounded: false,
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission,
		onInputCallback: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		setSessionName,
		getSessionName: () => sessionName,
		switchToHandoffSession(name: string): void {
			persistedSessionId = "handoff-session";
			sessionName = name;
			titleSource = "auto";
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

async function submit(editor: TestEditor, text: string): Promise<void> {
	if (!editor.onSubmit) throw new Error("Expected submit handler");
	await editor.onSubmit(text);
}

describe("InputController tool output expansion", () => {
	it("allows unknown viewport mutation when toggling tool output expansion", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(requestRender).toHaveBeenCalledWith(false, { allowUnknownViewportMutation: true });
	});
});

describe("InputController title generation", () => {
	it("ignores a late first-turn auto title after the persisted session changes while the provider id stays stable", async () => {
		const originalNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		const title = Promise.withResolvers<string | null>();
		const generateTitle = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(title.promise);
		const terminalTitle = vi.spyOn(titleGenerator, "setSessionTerminalTitle").mockImplementation(() => {});
		const { ctx, editor, getSessionName, setSessionName, switchToHandoffSession } = createTitleGenerationContext();
		const controller = new InputController(ctx);

		try {
			controller.setupEditorSubmitHandler();
			await submit(editor, "Please fix the cache race");

			expect(generateTitle).toHaveBeenCalledTimes(1);
			expect(generateTitle.mock.calls[0]?.[3]).toBe("provider-session");
			expect(ctx.session.sessionId).toBe("provider-session");
			expect(ctx.sessionManager.getSessionId()).toBe("source-session");

			switchToHandoffSession("Please fix the cache race (1)");
			expect(ctx.session.sessionId).toBe("provider-session");
			expect(ctx.sessionManager.getSessionId()).toBe("handoff-session");
			title.resolve("Late source title");
			await flushMicrotasks();

			expect(getSessionName()).toBe("Please fix the cache race (1)");
			expect(setSessionName).not.toHaveBeenCalled();
			expect(terminalTitle).not.toHaveBeenCalled();
		} finally {
			if (originalNoTitle === undefined) {
				delete Bun.env.PI_NO_TITLE;
			} else {
				Bun.env.PI_NO_TITLE = originalNoTitle;
			}
		}
	});
});

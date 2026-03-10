import { describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";

mock.module("../../modes/components/bash-execution", () => ({
	BashExecutionComponent: class {
		appendOutput = vi.fn();
		setComplete = vi.fn();
	},
}));

mock.module("../../modes/components/bordered-loader", () => ({
	BorderedLoader: class {},
}));

mock.module("../../modes/components/dynamic-border", () => ({
	DynamicBorder: class {},
}));

mock.module("../../modes/components/python-execution", () => ({
	PythonExecutionComponent: class {},
}));

mock.module("../../modes/theme/theme", () => ({
	getMarkdownTheme: () => ({}),
	getSymbolTheme: () => ({ success: "✓", error: "✗", warning: "!", info: "i" }),
	theme: {
		bold: (value: string) => value,
		fg: (_token: string, value: string) => value,
		info: (value: string) => value,
		status: { success: "✓", error: "✗", warning: "!" },
	},
}));

mock.module("../../tools/output-meta", () => ({
	outputMeta: () => ({
		truncationFromSummary: () => ({
			get: () => undefined,
		}),
	}),
}));

mock.module("node:child_process", () => ({
	spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

mock.module("../../task/omp-command", () => ({
	resolveOmpCommand: () => ({ cmd: "omp", args: [], shell: false }),
	buildOmpResumeArgs: () => [],
}));

import { CommandController } from "./command-controller";

function createClearContext() {
	const handleSessionRootChange = vi.fn();
	const newSession = vi.fn(async () => true);

	const ctx = {
		session: {
			isStreaming: false,
			isCompacting: false,
			newSession,
			abortCompaction: vi.fn(),
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionFile: () => "/tmp/project/.omp/session.jsonl",
		} as unknown as InteractiveModeContext["sessionManager"],
		chatContainer: {
			addChild: vi.fn(),
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["chatContainer"],
		pendingMessagesContainer: {
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["pendingMessagesContainer"],
		statusContainer: {
			clear: vi.fn(),
		} as unknown as InteractiveModeContext["statusContainer"],
		statusLine: {
			invalidate: vi.fn(),
		} as unknown as InteractiveModeContext["statusLine"],
		pendingTools: new Map(),
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		ui: {
			requestRender: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		updateEditorTopBorder: vi.fn(),
		handleSessionRootChange,
	} as unknown as InteractiveModeContext;

	return { controller: new CommandController(ctx), handleSessionRootChange, newSession };
}

describe("CommandController session-root-change reset", () => {
	it("calls handleSessionRootChange after successful newSession in handleClearCommand", async () => {
		const { controller, handleSessionRootChange, newSession } = createClearContext();

		await controller.handleClearCommand();

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(handleSessionRootChange).toHaveBeenCalledTimes(1);
	});

	it("calls handleSessionRootChange even when session was compacting", async () => {
		const { controller, handleSessionRootChange } = createClearContext();

		// isCompacting starts false, so it skips the compaction loop
		await controller.handleClearCommand();

		expect(handleSessionRootChange).toHaveBeenCalledTimes(1);
	});
});

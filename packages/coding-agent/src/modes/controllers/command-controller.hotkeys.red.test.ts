import { describe, expect, it, mock, vi } from "bun:test";
import type { InteractiveModeContext } from "../../modes/types";

class MockMarkdown {
	readonly source: string;

	constructor(text: string, ..._rest: unknown[]) {
		this.source = text;
	}

	render(): string[] {
		return [this.source];
	}

	invalidate(): void {}
}

class MockLoader {
	constructor(..._args: unknown[]) {}
}

class MockSpacer {
	constructor(..._args: unknown[]) {}
}

class MockText {
	constructor(..._args: unknown[]) {}
}

mock.module("@oh-my-pi/pi-tui", () => ({
	Loader: MockLoader,
	Markdown: MockMarkdown,
	padding: (count: number) => " ".repeat(Math.max(0, count)),
	Spacer: MockSpacer,
	Text: MockText,
	visibleWidth: (value: string) => Bun.stripANSI(value).length,
}));

mock.module("../../modes/theme/theme", () => ({
	getMarkdownTheme: () => ({}) as object,
	getSymbolTheme: () => ({
		success: "✓",
		error: "✗",
		warning: "!",
		info: "i",
	}),
	theme: {
		bold: (value: string) => value,
		fg: (_token: string, value: string) => value,
		status: {
			success: "✓",
			error: "✗",
			warning: "!",
		},
		info: (value: string) => value,
	},
}));

import { CommandController } from "./command-controller";

type HotkeyMap = Partial<
	Record<
		"lazygit" | "externalEditor" | "expandTools" | "cycleAgentMode" | "togglePlanMode" | "toggleSTT",
		string
	>
>;

function renderHotkeys(bindings: HotkeyMap): string {
	const children: unknown[] = [];
	const getDisplayString = vi.fn((action: string) => bindings[action as keyof HotkeyMap] ?? "");
	const ctx = {
		keybindings: { getDisplayString },
		chatContainer: {
			addChild: vi.fn((child: unknown) => {
				children.push(child);
			}),
		},
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	const controller = new CommandController(ctx);
	controller.handleHotkeysCommand();

	const markdown = children.find((child): child is MockMarkdown => child instanceof MockMarkdown);
	if (!markdown) {
		throw new Error("Missing hotkeys markdown output");
	}

	return markdown.source;
}

describe("CommandController hotkeys viewer lazygit rows", () => {
	it("shows lazygit row and omits external editor row when only lazygit is bound", () => {
		const hotkeysMarkdown = renderHotkeys({ lazygit: "Ctrl+G", externalEditor: "" });

		expect(hotkeysMarkdown).toContain("| `Ctrl+G` | Open Lazygit |");
		expect(hotkeysMarkdown).not.toContain("Edit message in external editor");
	});

	it("shows external editor row only when external editor action is bound", () => {
		const hotkeysMarkdown = renderHotkeys({ lazygit: "", externalEditor: "Ctrl+E" });

		expect(hotkeysMarkdown).toContain("| `Ctrl+E` | Edit message in external editor |");
		expect(hotkeysMarkdown).not.toContain("Open Lazygit");
		expect(hotkeysMarkdown).not.toContain("| `Ctrl+G` | Edit message in external editor |");
	});

	it("shows both lazygit and external editor rows when both actions are bound", () => {
		const hotkeysMarkdown = renderHotkeys({ lazygit: "Ctrl+G", externalEditor: "Ctrl+E" });

		expect(hotkeysMarkdown).toContain("| `Ctrl+G` | Open Lazygit |");
		expect(hotkeysMarkdown).toContain("| `Ctrl+E` | Edit message in external editor |");
	});

	it("omits lazygit and external editor rows when bindings are whitespace-only", () => {
		const hotkeysMarkdown = renderHotkeys({ lazygit: "   ", externalEditor: "\t" });

		expect(hotkeysMarkdown).not.toContain("Open Lazygit");
		expect(hotkeysMarkdown).not.toContain("Edit message in external editor");
		expect(hotkeysMarkdown).not.toContain("| `Ctrl+G` |");
	});

	it("does not render stale hardcoded external editor shortcut when both actions are unbound", () => {
		const hotkeysMarkdown = renderHotkeys({ lazygit: "", externalEditor: "" });

		expect(hotkeysMarkdown).not.toContain("Open Lazygit");
		expect(hotkeysMarkdown).not.toContain("Edit message in external editor");
		expect(hotkeysMarkdown).not.toContain("| `Ctrl+G` |");
	});
});

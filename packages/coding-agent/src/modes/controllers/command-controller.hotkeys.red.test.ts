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
	Record<"lazygit" | "externalEditor" | "expandTools" | "cycleAgentMode" | "togglePlanMode" | "toggleSTT", string>
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

describe("CommandController hotkeys Ctrl+X chord rows", () => {
	it("documents the Ctrl+X leader key to open/close navigator", () => {
		const md = renderHotkeys({});
		expect(md).toContain("| `Ctrl+X` | Open subagent navigator (or close if already open) |");
	});

	it("documents all Ctrl+X chord follow-ups", () => {
		const md = renderHotkeys({});
		expect(md).toContain("| `Ctrl+X, Ctrl+N` | Next subagent |");
		expect(md).toContain("| `Ctrl+X, Ctrl+P` | Previous subagent |");
		expect(md).toContain("| `Ctrl+X, Ctrl+O` | View most recently updated subagent |");
		expect(md).toContain("| `Ctrl+X, Ctrl+R` | Refresh subagent list |");
		expect(md).toContain("| `Ctrl+X, Ctrl+V` | Open navigator (explicit) |");
	});

	it("renders Subagent Navigator section heading", () => {
		const md = renderHotkeys({});
		expect(md).toContain("**Subagent Navigator (Ctrl+X chord)**");
	});

	it("preserves existing hotkey sections alongside chord section", () => {
		const md = renderHotkeys({});
		expect(md).toContain("**Navigation**");
		expect(md).toContain("**Editing**");
		expect(md).toContain("**Other**");
		expect(md).toContain("**Subagent Navigator (Ctrl+X chord)**");
	});
});

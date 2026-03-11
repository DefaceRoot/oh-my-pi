import { describe, expect, it } from "bun:test";
import { type Component, type TerminalMouseEvent, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleText(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

class StaticLinesComponent implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.lines];
	}
}

class MutableLinesComponent implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.lines];
	}
}

describe("TUI mouse events", () => {
	it("parses SGR mouse input and forwards visible line context", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		tui.addChild(new StaticLinesComponent(["alpha", "beta", "gamma"]));

		const events: TerminalMouseEvent[] = [];
		tui.onMouse = event => {
			events.push(event);
			return true;
		};

		try {
			tui.start();
			await Bun.sleep(0);
			await term.flush();

			term.sendInput("\x1b[<0;3;2M");
			await Bun.sleep(0);

			expect(events).toHaveLength(1);
			expect(events[0]?.raw).toBe("\x1b[<0;3;2M");
			expect(events[0]?.x).toBe(3);
			expect(events[0]?.y).toBe(2);
			expect(events[0]?.action).toBe("press");
			expect(events[0]?.button).toBe("left");
			expect(events[0]?.lineIndex).toBe(1);
			expect(visibleText(events[0]?.lineText ?? "")).toBe("beta");
		} finally {
			tui.stop();
		}
	});

	it("maps mouse rows against the current viewport after scrollback growth", async () => {
		const term = new VirtualTerminal(24, 3);
		const tui = new TUI(term);
		tui.addChild(new StaticLinesComponent(Array.from({ length: 8 }, (_value, index) => `row-${index}`)));

		let received: TerminalMouseEvent | undefined;
		tui.onMouse = event => {
			received = event;
			return true;
		};

		try {
			tui.start();
			await Bun.sleep(0);
			await term.flush();

			expect(term.getViewport().at(-1)?.trim()).toBe("row-7");

			term.sendInput("\x1b[<0;2;3m");
			await Bun.sleep(0);

			expect(received?.action).toBe("release");
			expect(received?.lineIndex).toBe(7);
			expect(visibleText(received?.lineText ?? "").trim()).toBe("row-7");
		} finally {
			tui.stop();
		}
	});

	it("maps mouse rows against current rendered lines after content shrinks", async () => {
		const term = new VirtualTerminal(24, 3);
		const tui = new TUI(term);
		const lines = new MutableLinesComponent(Array.from({ length: 6 }, (_value, index) => `row-${index}`));
		tui.addChild(lines);

		let received: TerminalMouseEvent | undefined;
		tui.onMouse = event => {
			received = event;
			return true;
		};

		try {
			tui.start();
			await Bun.sleep(0);
			await term.flush();

			expect(term.getViewport().at(-1)?.trim()).toBe("row-5");

			lines.setLines(Array.from({ length: 4 }, (_value, index) => `row-${index}`));
			tui.requestRender();
			await Bun.sleep(0);
			await term.flush();

			const viewport = term.getViewport().map(line => line.trim());
			expect(viewport).toContain("row-3");

			term.sendInput("\x1b[<0;2;3m");
			await Bun.sleep(0);

			expect(received?.action).toBe("release");
			expect(received?.lineIndex).toBe(3);
			expect(visibleText(received?.lineText ?? "").trim()).toBe("row-3");
		} finally {
			tui.stop();
		}
	});
});

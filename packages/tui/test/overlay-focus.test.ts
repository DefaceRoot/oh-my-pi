import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class PassiveComponent implements Component {
	constructor(private readonly label: string) {}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

class InputComponent implements Component {
	focused = false;
	readonly inputs: string[] = [];

	constructor(private readonly label: string) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return [this.focused ? `${this.label}*` : this.label];
	}

	invalidate(): void {}
}

async function settle(term: { flush(): Promise<void> }): Promise<void> {
	await Bun.sleep(0);
	await term.flush();
}

describe("TUI overlay focus restoration", () => {
	it("keeps focus on the current input when showing a display-only overlay", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const editor = new InputComponent("editor");
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);

			tui.showOverlay(new PassiveComponent("sidebar"), { anchor: "top-right" });
			await settle(term);

			term.sendInput("a");
			expect(editor.inputs).toEqual(["a"]);
		} finally {
			tui.stop();
		}
	});

	it("handle.hide restores focus past display-only overlays to the prior input", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const editor = new InputComponent("editor");
		const modal = new InputComponent("modal");
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);

			tui.showOverlay(new PassiveComponent("sidebar"), { anchor: "top-right" });
			const handle = tui.showOverlay(modal, { anchor: "center" });
			await settle(term);

			term.sendInput("x");
			expect(modal.inputs).toEqual(["x"]);

			handle.hide();
			await settle(term);

			term.sendInput("y");
			expect(editor.inputs).toEqual(["y"]);
			expect(modal.inputs).toEqual(["x"]);
		} finally {
			tui.stop();
		}
	});

	it("hideOverlay restores focus past display-only overlays to the prior input", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const editor = new InputComponent("editor");
		const modal = new InputComponent("modal");
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);

			tui.showOverlay(new PassiveComponent("sidebar"), { anchor: "top-right" });
			tui.showOverlay(modal, { anchor: "center" });
			await settle(term);

			term.sendInput("x");
			expect(modal.inputs).toEqual(["x"]);

			tui.hideOverlay();
			await settle(term);

			term.sendInput("y");
			expect(editor.inputs).toEqual(["y"]);
			expect(modal.inputs).toEqual(["x"]);
		} finally {
			tui.stop();
		}
	});

	it("visibility changes restore focus to the prior input instead of a display-only overlay", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const editor = new InputComponent("editor");
		const modal = new InputComponent("modal");
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);

			tui.showOverlay(new PassiveComponent("sidebar"), { anchor: "top-right" });
			tui.showOverlay(modal, {
				anchor: "center",
				visible: termWidth => termWidth >= 70,
			});
			await settle(term);

			term.sendInput("x");
			expect(modal.inputs).toEqual(["x"]);

			term.resize(60, 12);
			await settle(term);

			term.sendInput("y");
			expect(editor.inputs).toEqual(["y"]);
			expect(modal.inputs).toEqual(["x"]);
		} finally {
			tui.stop();
		}
	});
});

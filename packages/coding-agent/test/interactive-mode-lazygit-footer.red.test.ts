import { describe, expect, test, vi } from "bun:test";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

describe("InteractiveMode lazygit footer click routing", () => {
	test("routes direct lazygit button clicks to InputController.openLazygit", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		const prompt = vi.fn(async () => undefined);
		const openLazygit = vi.fn(async () => undefined);

		mode.getActionButtonUnderMouse = vi.fn(() => ({ command: "/lazygit" }));
		mode.setActionButtonHoverState = vi.fn();
		mode.editor = { setText: vi.fn() };
		mode.inputController = { openLazygit };
		mode.session = {
			prompt,
			extensionRunner: { getCommand: () => undefined },
		};
		mode.isKnownSlashCommand = vi.fn(() => true);
		mode.showError = vi.fn();

		const handled = mode.handleFooterMouseClick({ action: "release", button: "left" } as any);

		expect(handled).toBe(true);
		expect(openLazygit).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	test("keeps editorText click behavior unchanged", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		const prompt = vi.fn(async () => undefined);
		const openLazygit = vi.fn(async () => undefined);
		const setText = vi.fn();

		mode.getActionButtonUnderMouse = vi.fn(() => ({ command: "/refresh-fork", editorText: "draft" }));
		mode.setActionButtonHoverState = vi.fn();
		mode.editor = { setText };
		mode.inputController = { openLazygit };
		mode.session = {
			prompt,
			extensionRunner: { getCommand: () => undefined },
		};
		mode.isKnownSlashCommand = vi.fn(() => true);
		mode.showError = vi.fn();

		const handled = mode.handleFooterMouseClick({ action: "release", button: "left" } as any);

		expect(handled).toBe(true);
		expect(setText).toHaveBeenCalledWith("draft");
		expect(openLazygit).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	test("keeps generic footer slash-command dispatch unchanged", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		const prompt = vi.fn(async () => undefined);
		const openLazygit = vi.fn(async () => undefined);

		mode.getActionButtonUnderMouse = vi.fn(() => ({ command: "/refresh-fork" }));
		mode.setActionButtonHoverState = vi.fn();
		mode.editor = { setText: vi.fn() };
		mode.inputController = { openLazygit };
		mode.session = {
			prompt,
			extensionRunner: { getCommand: () => undefined },
		};
		mode.isKnownSlashCommand = vi.fn(() => true);
		mode.showError = vi.fn();

		const handled = mode.handleFooterMouseClick({ action: "release", button: "left" } as any);

		expect(handled).toBe(true);
		expect(openLazygit).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("/refresh-fork");
	});
});

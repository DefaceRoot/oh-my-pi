import { beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { ACTION_BUTTONS, getActionButtonAtMouse, stripAnsi } from "./action-buttons";
import { StatusLineComponent } from "./components/status-line";
import { initTheme } from "./theme/theme";

function createStatusLine(): StatusLineComponent {
	return new StatusLineComponent({
		keybindings: { getDisplayString: () => "Alt+W" },
	} as any);
}

function renderFooterHookLine(): string {
	const statusLine = createStatusLine();
	for (const button of ACTION_BUTTONS) {
		statusLine.setHookStatus(button.statusKey, button.normalText);
	}

	const renderedLines = statusLine.render(240);
	expect(renderedLines.length).toBeGreaterThan(0);
	return stripAnsi(renderedLines[renderedLines.length - 1] ?? "").trim();
}

function xForLabel(line: string, label: string): number {
	const index = line.indexOf(label);
	expect(index).toBeGreaterThanOrEqual(0);
	return index + 1;
}

describe("action button click routing", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
	});

	test("maps trimmed Git footer click to the lazygit command", () => {
		const line = renderFooterHookLine();
		const gitX = xForLabel(line, "Git");

		const button = getActionButtonAtMouse(line, gitX);
		expect(button?.command).toBe("/lazygit");
		expect(button?.label).toBe("Git");
	});

	test("keeps Worktree clicks distinct from neighboring Git", () => {
		const line = renderFooterHookLine();
		const worktreeX = xForLabel(line, "Worktree");

		const button = getActionButtonAtMouse(line, worktreeX);
		expect(button?.command).toBe("/worktree-menu");
		expect(button?.command).not.toBe("/lazygit");
	});
});

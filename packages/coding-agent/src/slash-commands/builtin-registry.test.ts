import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "../modes/types";
import { type BuiltinSlashCommandRuntime, executeBuiltinSlashCommand } from "./builtin-registry";

function createRuntime() {
	const showPresetSelector = vi.fn();
	const setText = vi.fn();
	const ctx = {
		showPresetSelector,
		editor: { setText },
	} as unknown as InteractiveModeContext;
	const runtime = {
		ctx,
		handleBackgroundCommand: vi.fn(),
	} satisfies BuiltinSlashCommandRuntime;

	return { runtime, setText, showPresetSelector };
}

describe("builtin preset slash commands", () => {
	it.each(["/preset", "/presets"])("opens the standalone preset selector for %s", async command => {
		const { runtime, setText, showPresetSelector } = createRuntime();

		expect(await executeBuiltinSlashCommand(command, runtime)).toBe(true);
		expect(showPresetSelector).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("");
	});
});

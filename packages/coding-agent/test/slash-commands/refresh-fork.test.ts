import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { FORK_REINSTALL_COMMAND } from "@oh-my-pi/pi-coding-agent/cli/update-cli";

describe("/refresh-fork slash command", () => {
	it("runs the fork reinstall command outside session context and warns about restart", async () => {
		const calls: Array<{ command: string; excludeFromContext?: boolean }> = [];
		let statusMessage: string | undefined;
		let editorText = "unchanged";
		const runtime = {
			ctx: {
				editor: {
					setText: (value: string) => {
						editorText = value;
					},
				} as InteractiveModeContext["editor"],
				handleBashCommand: async (command: string, excludeFromContext?: boolean) => {
					calls.push({ command, excludeFromContext });
				},
				showStatus: (message: string) => {
					statusMessage = message;
				},
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		};

		const handled = await executeBuiltinSlashCommand("/refresh-fork", runtime);

		expect(handled).toBe(true);
		expect(editorText).toBe("");
		expect(calls).toEqual([{ command: FORK_REINSTALL_COMMAND, excludeFromContext: true }]);
		expect(statusMessage).toContain("restart omp");
	});
});

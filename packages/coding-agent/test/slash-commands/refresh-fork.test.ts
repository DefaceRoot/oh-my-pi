import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/refresh-fork slash command", () => {
	it("delegates fork refresh to interactive mode so successful refreshes can relaunch omp", async () => {
		let refreshCalls = 0;
		let editorText = "unchanged";
		const runtime = {
			ctx: {
				editor: {
					setText: (value: string) => {
						editorText = value;
					},
				} as InteractiveModeContext["editor"],
				refreshForkInstall: async () => {
					refreshCalls += 1;
				},
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		};

		const handled = await executeBuiltinSlashCommand("/refresh-fork", runtime);

		expect(handled).toBe(true);
		expect(editorText).toBe("");
		expect(refreshCalls).toBe(1);
	});
});

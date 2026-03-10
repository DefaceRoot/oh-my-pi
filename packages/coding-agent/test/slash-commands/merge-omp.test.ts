import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/merge-omp slash command", () => {
	it("delegates fork merge to interactive mode so successful merges can relaunch omp", async () => {
		let mergeCalls = 0;
		let editorText = "unchanged";
		const runtime = {
			ctx: {
				editor: {
					setText: (value: string) => {
						editorText = value;
					},
				} as InteractiveModeContext["editor"],
				mergeUpstreamFork: async () => {
					mergeCalls += 1;
				},
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		};

		const handled = await executeBuiltinSlashCommand("/merge-omp", runtime);

		expect(handled).toBe(true);
		expect(editorText).toBe("");
		expect(mergeCalls).toBe(1);
	});
});

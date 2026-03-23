/**
 * Generate and optionally push a commit with changelog updates.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCommitCommand } from "../commit";
import type { CommitCommandArgs } from "../commit/types";
import { initTheme } from "../modes/theme/theme";

export default class Commit extends Command {
	static description = "Generate a commit message and update changelogs";

	static flags = {
		push: Flags.boolean({ description: "Push after committing" }),
		"no-push": Flags.boolean({ description: "Do not push after committing" }),
		"dry-run": Flags.boolean({ description: "Preview without committing" }),
		"no-changelog": Flags.boolean({ description: "Skip changelog updates" }),
		legacy: Flags.boolean({ description: "Use legacy deterministic pipeline" }),
		context: Flags.string({ char: "c", description: "Additional context for the model" }),
		model: Flags.string({ char: "m", description: "Override model selection" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Commit);
		const lastPushFlag = [...this.argv].reverse().find(arg => arg === "--push" || arg === "--no-push");
		const push = lastPushFlag === "--no-push" ? false : true;

		const cmd: CommitCommandArgs = {
			push,
			dryRun: flags["dry-run"] ?? false,
			noChangelog: flags["no-changelog"] ?? false,
			legacy: flags.legacy,
			context: flags.context,
			model: flags.model,
		};

		await initTheme();
		await runCommitCommand(cmd);
	}
}

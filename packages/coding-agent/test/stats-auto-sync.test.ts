import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("stats auto-sync", () => {
	it("registers one guarded startup and shutdown sync path", async () => {
		using tempDir = TempDir.createSync("@omp-stats-auto-sync-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const stopMessage = "stop stats auto-sync test ACP mode";
		const calls: Array<{ workers?: number } | undefined> = [];
		const shutdownCallbacks: Array<() => void | Promise<void>> = [];
		const firstCallStarted = Promise.withResolvers<void>();
		const firstCallCanFinish = Promise.withResolvers<void>();
		let inFlight = 0;
		let maxInFlight = 0;

		const runAcpUntilStartup = async () => {
			try {
				await runRootCommand(
					{
						mode: "acp",
						messages: [],
						fileArgs: [],
						unknownFlags: new Map(),
						unrecognizedFlags: [],
						noSkills: true,
						noRules: true,
						noTools: true,
						noLsp: true,
						noExtensions: true,
						sessionDir: cwd,
					},
					[],
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						syncStatsSessions: async opts => {
							calls.push(opts);
							inFlight++;
							maxInFlight = Math.max(maxInFlight, inFlight);
							if (calls.length === 1) {
								firstCallStarted.resolve();
								await firstCallCanFinish.promise;
							}
							inFlight--;
							return { processed: 0, files: 0 };
						},
						registerPostmortem: (_id, callback) => {
							shutdownCallbacks.push(() => callback(postmortem.Reason.MANUAL));
							return () => {};
						},
						runAcpMode: async () => {
							throw new Error(stopMessage);
						},
					},
				);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== stopMessage) {
					throw error;
				}
			}
		};

		try {
			await runAcpUntilStartup();
			await firstCallStarted.promise;
			expect(calls[0]).toBeUndefined();
			expect(shutdownCallbacks).toHaveLength(1);

			const shutdownDuringStartup = shutdownCallbacks[0]();
			expect(calls).toHaveLength(1);
			firstCallCanFinish.resolve();
			await shutdownDuringStartup;

			await shutdownCallbacks[0]();
			expect(calls[1]).toEqual({ workers: 1 });
			expect(maxInFlight).toBe(1);

			await runAcpUntilStartup();
			expect(shutdownCallbacks).toHaveLength(1);
			expect(calls).toHaveLength(2);
		} finally {
			authStorage.close();
		}
	});
});

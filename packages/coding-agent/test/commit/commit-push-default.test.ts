import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import CommitCommand from "../../src/commands/commit";
import * as commitModule from "../../src/commit";
import { parseCommitArgs } from "../../src/commit/cli";
import * as themeModule from "../../src/modes/theme/theme";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "test",
	commands: new Map(),
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("commit push defaults", () => {
	it("defaults parseCommitArgs push to true", () => {
		const parsed = parseCommitArgs(["commit"]);
		expect(parsed).toBeDefined();
		expect(parsed?.push).toBe(true);
	});

	it("allows parseCommitArgs --no-push override", () => {
		const parsed = parseCommitArgs(["commit", "--no-push"]);
		expect(parsed?.push).toBe(false);
	});

	it("makes parseCommitArgs use the last push flag", () => {
		expect(parseCommitArgs(["commit", "--push", "--no-push"])?.push).toBe(false);
		expect(parseCommitArgs(["commit", "--no-push", "--push"])?.push).toBe(true);
	});

	it("keeps parseCommitArgs unknown-flag failures", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit:${code ?? 0}`);
		}) as never);

		expect(() => parseCommitArgs(["commit", "--bogus"])).toThrow("exit:1");
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("defaults command push to true when omitted", async () => {
		const runSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue();
		vi.spyOn(themeModule, "initTheme").mockResolvedValue();

		const command = new CommitCommand([], TEST_CONFIG);
		await command.run();

		expect(runSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				push: true,
			}),
		);
	});

	it("supports --no-push override in command flags", async () => {
		const runSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue();
		vi.spyOn(themeModule, "initTheme").mockResolvedValue();

		const command = new CommitCommand(["--no-push"], TEST_CONFIG);
		await command.run();

		expect(runSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				push: false,
			}),
		);
	});

	it("makes command use the last push flag", async () => {
		const runSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue();
		vi.spyOn(themeModule, "initTheme").mockResolvedValue();

		const first = new CommitCommand(["--push", "--no-push"], TEST_CONFIG);
		await first.run();
		expect(runSpy).toHaveBeenLastCalledWith(expect.objectContaining({ push: false }));

		const second = new CommitCommand(["--no-push", "--push"], TEST_CONFIG);
		await second.run();
		expect(runSpy).toHaveBeenLastCalledWith(expect.objectContaining({ push: true }));
	});

	it("keeps command unknown-flag failures", async () => {
		const command = new CommitCommand(["--bogus"], TEST_CONFIG);
		await expect(command.run()).rejects.toThrow("Unknown option '--bogus'");
	});
});

import { describe, expect, it } from "bun:test";
import {
	_buildForkReinstallGuidanceForTest,
	_resolveUpdateMethodForTest,
	_runUpdateCommandForTest,
} from "../src/cli/update-cli";

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when prioritized omp only shares a prefix with bun global bin", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.bun/bin-shadow/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = _resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("includes local fork reinstall and PATH precedence checks in guidance", () => {
		const guidance = _buildForkReinstallGuidanceForTest();

		expect(guidance).toContain("bun --cwd=/home/colin/devpod-repos/DefaceRoot/oh-my-pi run reinstall:fork");
		expect(guidance).toContain("command -v omp");
		expect(guidance).toContain("bun pm bin -g");
	});

	it("reinstalls the local fork for bun-managed installs without consulting the npm registry", async () => {
		const events: string[] = [];

		await _runUpdateCommandForTest(
			{ force: false, check: false },
			{
				resolveUpdateTarget: async () => ({ method: "bun" }),
				getLatestRelease: async () => {
					events.push("latest");
					return { tag: "v99.0.0", version: "99.0.0" };
				},
				updateViaBun: async () => {
					events.push("bun");
				},
				updateViaBinaryAt: async () => {
					events.push("binary");
				},
				log: message => {
					events.push(`log:${message}`);
				},
				error: message => {
					events.push(`error:${message}`);
				},
				exit: code => {
					throw new Error(`exit:${code}`);
				},
			},
		);

		expect(events).toContain("bun");
		expect(events).not.toContain("latest");
		expect(events).not.toContain("binary");
	});

	it("prints fork guidance instead of reinstalling during bun-managed check mode", async () => {
		const events: string[] = [];

		await _runUpdateCommandForTest(
			{ force: false, check: true },
			{
				resolveUpdateTarget: async () => ({ method: "bun" }),
				updateViaBun: async () => {
					events.push("bun");
				},
				updateViaBinaryAt: async () => {
					events.push("binary");
				},
				log: message => {
					events.push(`log:${message}`);
				},
				error: message => {
					events.push(`error:${message}`);
				},
				exit: code => {
					throw new Error(`exit:${code}`);
				},
			},
		);

		expect(events).not.toContain("bun");
		expect(events).not.toContain("binary");
		expect(events.some(event => event.includes("bun --cwd=/home/colin/devpod-repos/DefaceRoot/oh-my-pi run reinstall:fork"))).toBeTrue();
	});
});

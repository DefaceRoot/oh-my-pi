import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const menuPopupScript = path.join(repoRoot, "scripts", "menu-popup.sh");
const systemPath = process.env.PATH ?? Bun.env.PATH ?? "/usr/bin:/bin";

async function runMenuPopup(args: string[], fzfOutput: string) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-popup-test-"));
	const fakeFzfPath = path.join(tempDir, "fzf");
	const fzfArgsLogPath = path.join(tempDir, "fzf-args.log");
	const fzfInputLogPath = path.join(tempDir, "fzf-input.log");

	try {
		fs.writeFileSync(
			fakeFzfPath,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"printf '%s\\n' \"$@\" > \"${FZF_ARGS_LOG:?}\"",
				"input=\"$(</dev/stdin)\"",
				"printf '%s' \"${input}\" > \"${FZF_INPUT_LOG:?}\"",
				"if [ -n \"${FZF_TEST_OUTPUT:-}\" ]; then",
				"  printf '%s' \"${FZF_TEST_OUTPUT}\"",
				"fi",
			].join("\n"),
			{ mode: 0o755 },
		);
		fs.chmodSync(fakeFzfPath, 0o755);

		const child = Bun.spawn(["bash", menuPopupScript, ...args], {
			env: {
				...process.env,
				TMUX: "",
				PATH: `${tempDir}:${systemPath}`,
				FZF_ARGS_LOG: fzfArgsLogPath,
				FZF_INPUT_LOG: fzfInputLogPath,
				FZF_TEST_OUTPUT: fzfOutput,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		const fzfArgs = fs.existsSync(fzfArgsLogPath)
			? fs.readFileSync(fzfArgsLogPath, "utf8").trim().split("\n").filter(Boolean)
			: [];
		const fzfInput = fs.existsSync(fzfInputLogPath) ? fs.readFileSync(fzfInputLogPath, "utf8") : "";

		return { stdout, stderr, exitCode, fzfArgs, fzfInput };
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("menu-popup", () => {
	test("keeps default single-select behavior", async () => {
		const result = await runMenuPopup(["Pick one", "Alpha", "Beta", "Gamma"], "Beta\n");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Beta\n");
		expect(result.fzfInput).toBe("Alpha\nBeta\nGamma");
		expect(result.fzfArgs).not.toContain("--multi");
	});

	test("passes --multi to fzf and emits newline-separated selections", async () => {
		const result = await runMenuPopup(["--multi", "Pick many", "Alpha", "Beta", "Gamma"], "Alpha\nGamma\n");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("Alpha\nGamma\n");
		expect(result.fzfInput).toBe("Alpha\nBeta\nGamma");
		expect(result.fzfArgs).toContain("--multi");
	});
});

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const installScriptPath = path.join(repoRoot, "scripts", "install.sh");
const reinstallScriptPath = path.join(repoRoot, "scripts", "reinstall-fork-global.sh");

async function readText(filePath: string): Promise<string> {
	return await Bun.file(filePath).text();
}

describe("fork global install contract", () => {
	test("repo exposes a dedicated fork reinstall script", async () => {
		const packageJson = (await Bun.file(rootPackageJsonPath).json()) as {
			scripts?: Record<string, string>;
		};

		expect(packageJson.scripts?.["reinstall:fork"]).toContain("scripts/reinstall-fork-global.sh");
		expect(await readText(reinstallScriptPath)).toContain("bun pm pack");
		expect(await readText(reinstallScriptPath)).toContain("bun add -g");
	});

	test("installer delegates local fork reinstalls through the dedicated script", async () => {
		const installScript = await readText(installScriptPath);

		expect(installScript).toContain("reinstall-fork-global.sh");
		expect(installScript).not.toContain('bun install -g "$INSTALL_TARGET"');
	});
});

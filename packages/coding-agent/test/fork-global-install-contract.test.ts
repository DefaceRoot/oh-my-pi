import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const installScriptPath = path.join(repoRoot, "scripts", "install.sh");
const reinstallScriptPath = path.join(repoRoot, "scripts", "reinstall-fork-global.sh");

const implementationEnginePath = path.join(repoRoot, "agent", "extensions", "implementation-engine", "index.ts");
const configInstallScriptPath = path.join(repoRoot, "agent", "scripts", "install-omp-config.sh");
const migrateWorkflowScriptPath = path.join(repoRoot, "agent", "scripts", "migrate-workflow-from-ssh.sh");
async function readText(filePath: string): Promise<string> {
	return await Bun.file(filePath).text();
}

describe("fork global install contract", () => {
	test("repo exposes a dedicated fork reinstall script", async () => {
		const packageJson = (await Bun.file(rootPackageJsonPath).json()) as {
			scripts?: Record<string, string>;
		};

		expect(packageJson.scripts?.["reinstall:fork"]).toContain("scripts/reinstall-fork-global.sh");
		const reinstallScript = await readText(reinstallScriptPath);
		expect(reinstallScript).toContain("bun pm pack");
		expect(reinstallScript).toContain("bun add -g");
		expect(reinstallScript).toContain("link_workspace_dependencies");
		expect(reinstallScript).toContain("fork-tarballs");
		expect(reinstallScript).not.toContain("mktemp -d");
	});

	test("installer delegates local fork reinstalls through the dedicated script", async () => {
		const installScript = await readText(installScriptPath);

		expect(installScript).toContain("reinstall-fork-global.sh");
		expect(installScript).not.toContain('bun install -g "$INSTALL_TARGET"');
	});

	test("live fork refresh paths do not auto-apply archived workflow patch bundles", async () => {
		const implementationEngine = await readText(implementationEnginePath);
		const configInstallScript = await readText(configInstallScriptPath);
		const migrateWorkflowScript = await readText(migrateWorkflowScriptPath);

		expect(implementationEngine).not.toContain("ensureWorkflowPatchHealth");
		expect(implementationEngine).not.toContain("WORKFLOW_PATCH_SCRIPT_PATH");
		expect(implementationEngine).not.toContain("OMP_IMPLEMENT_PATCH_GUARD");
		expect(configInstallScript).not.toContain("patches/*/manage.sh");
		expect(configInstallScript).not.toContain("Applying patches...");
		expect(migrateWorkflowScript).not.toContain("--skip-patch");
		expect(migrateWorkflowScript).not.toContain("--force-patch");
		expect(migrateWorkflowScript).not.toContain("manage.sh apply");
		expect(migrateWorkflowScript).not.toContain("manage.sh status");
	});
});

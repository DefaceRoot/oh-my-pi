import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const installScriptPath = path.join(repoRoot, "scripts", "install.sh");
const launcherPath = path.join(repoRoot, "omp");

const implementationEnginePath = path.join(repoRoot, "agent", "extensions", "implementation-engine", "index.ts");
const configInstallScriptPath = path.join(repoRoot, "agent", "scripts", "install-omp-config.sh");
const migrateWorkflowScriptPath = path.join(repoRoot, "agent", "scripts", "migrate-workflow-from-ssh.sh");

const removedCommandName = ["reinstall", "fork"].join(":");
const removedScriptName = ["reinstall", "fork", "global.sh"].join("-");

async function readText(filePath: string): Promise<string> {
	return await Bun.file(filePath).text();
}

describe("fork launcher contract", () => {
	test("repo exposes the fork launcher and no removed reinstall entry point", async () => {
		const packageJson = (await Bun.file(rootPackageJsonPath).json()) as {
			scripts?: Record<string, string>;
		};

		expect(packageJson.scripts?.[removedCommandName]).toBeUndefined();

		const launcher = await readText(launcherPath);
		expect(launcher).toContain('export PI_CODING_AGENT_DIR="$FORK_ROOT/agent"');
		expect(launcher).toContain('packages/coding-agent/src/cli.ts');
	});

	test("installer links the local fork launcher instead of reinstalling packed globals", async () => {
		const installScript = await readText(installScriptPath);

		expect(installScript).toContain('ln -s "$repo_root/omp" "$INSTALL_DIR/omp"');
		expect(installScript).toContain("SOURCE_INSTALL_ROOT");
		expect(installScript).not.toContain(removedScriptName);
		expect(installScript).not.toContain("bun pm pack");
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

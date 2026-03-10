import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const updatingDocPath = path.join(repoRoot, "UPDATING.md");
const customizationSkillPath = path.join(repoRoot, "agent", "skills", "oh-my-pi-customization", "SKILL.md");
const customizationQuickReferencePath = path.join(
	repoRoot,
	"agent",
	"skills",
	"oh-my-pi-customization",
	"QUICK-REFERENCE.md",
);

const forkRootPlaceholder = "<fork-root>";
const forkAgentPlaceholder = `${forkRootPlaceholder}/agent`;

async function readText(filePath: string): Promise<string> {
	return await Bun.file(filePath).text();
}

describe("fork global install documentation", () => {
	test("UPDATING.md documents restart-based workflow with legacy reinstall compatibility", async () => {
		const updatingDoc = await readText(updatingDocPath);

		expect(updatingDoc).toContain("git fetch upstream && git rebase upstream/main");
		expect(updatingDoc).toContain("bun install");
		expect(updatingDoc).toContain("No global package reinstall is needed for day-to-day use.");
		expect(updatingDoc).toContain(
			"Changes under `<fork-root>/packages/` take effect on the next `omp` restart (no reinstall needed)",
		);
		expect(updatingDoc).toContain("Changes under `<fork-root>/agent/` take effect on the next `omp` restart");
		expect(updatingDoc).toContain("Then restart `omp` normally. The launcher runs the updated source immediately.");
		expect(updatingDoc).toContain(
			"`bun run reinstall:fork` still exists for backward compatibility but is no longer the recommended workflow.",
		);
		expect(updatingDoc).not.toContain("require `bun run reinstall:fork` plus an `omp` restart");
		expect(updatingDoc).toContain("command -v omp");
		expect(updatingDoc).toContain(forkRootPlaceholder);
		expect(updatingDoc).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});

	test("customization skill points users at fork placeholders and restart-based refresh steps", async () => {
		const skillDoc = await readText(customizationSkillPath);

		expect(skillDoc).toContain("UPDATING.md");
		expect(skillDoc).toContain(forkAgentPlaceholder);
		expect(skillDoc).toContain("~/.omp/agent -> <fork-root>/agent");
		expect(skillDoc).toContain(
			"If you change files under `<fork-root>/packages/`, restart `omp` to load the updated source.",
		);
		expect(skillDoc).toContain("If you only change files under `<fork-root>/agent/`, restart `omp`.");
		expect(skillDoc).toContain(
			"If dependencies changed, run `bun install` in `<fork-root>` before restarting `omp`.",
		);
		expect(skillDoc).toContain(
			"`bun run reinstall:fork` remains available only for legacy global-install compatibility checks; it is not part of the normal edit loop.",
		);
		expect(skillDoc).toContain("Git commit and push do not update the live local `omp` process.");
		expect(skillDoc).not.toContain("~/.bun/install/global/node_modules");
		expect(skillDoc).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});

	test("customization quick reference keeps restart-based defaults and legacy reinstall notes", async () => {
		const quickReference = await readText(customizationQuickReferencePath);

		expect(quickReference).toContain(`${forkAgentPlaceholder}/extensions/*.ts`);
		expect(quickReference).toContain(`${forkAgentPlaceholder}/agents/*.md`);
		expect(quickReference).toContain("Changes under `<fork-root>/packages/` take effect on the next `omp` restart.");
		expect(quickReference).toContain("Changes under `<fork-root>/agent/` take effect on the next `omp` restart.");
		expect(quickReference).toContain(
			"If dependencies changed, run `bun install` in `<fork-root>` before restarting `omp`.",
		);
		expect(quickReference).toContain("Legacy Global Reinstall (Compatibility Only)");
		expect(quickReference).toContain("bun --cwd=<fork-root> run reinstall:fork");
		expect(quickReference).toContain("Use this only when you intentionally need the legacy global-install behavior.");
		expect(quickReference).toContain("UPDATING.md");
		expect(quickReference).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});
});

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
	test("UPDATING.md explains when reinstall versus restart is required", async () => {
		const updatingDoc = await readText(updatingDocPath);

		expect(updatingDoc).toContain("git fetch upstream && git rebase upstream/main");
		expect(updatingDoc).toContain("bun install");
		expect(updatingDoc).toContain("bun run reinstall:fork");
		expect(updatingDoc).toContain("bun --cwd=<fork-root> run reinstall:fork");
		expect(updatingDoc).toContain("Git commit and push do not update the live local omp install");
		expect(updatingDoc).toContain("Changes under `<fork-root>/packages/` require `bun run reinstall:fork` plus an `omp` restart");
		expect(updatingDoc).toContain("Changes under `<fork-root>/agent/` usually only require restarting `omp`");
		expect(updatingDoc).toContain("command -v omp");
		expect(updatingDoc).toContain("bun pm bin -g");
		expect(updatingDoc.toLowerCase()).toContain("bun link");
		expect(updatingDoc).toContain(forkRootPlaceholder);
		expect(updatingDoc).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});

	test("customization skill points users at fork placeholders and correct refresh steps", async () => {
		const skillDoc = await readText(customizationSkillPath);

		expect(skillDoc).toContain("UPDATING.md");
		expect(skillDoc).toContain(forkAgentPlaceholder);
		expect(skillDoc).toContain("~/.omp/agent -> <fork-root>/agent");
		expect(skillDoc).toContain("If you change files under `<fork-root>/packages/`, run `bun --cwd=<fork-root> run reinstall:fork` and restart `omp`");
		expect(skillDoc).toContain("If you only change files under `<fork-root>/agent/`, restart `omp`");
		expect(skillDoc).not.toContain("~/.bun/install/global/node_modules");
		expect(skillDoc).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});

	test("customization quick reference uses fork placeholders instead of machine-local paths", async () => {
		const quickReference = await readText(customizationQuickReferencePath);

		expect(quickReference).toContain(`${forkAgentPlaceholder}/extensions/*.ts`);
		expect(quickReference).toContain(`${forkAgentPlaceholder}/agents/*.md`);
		expect(quickReference).toContain("bun --cwd=<fork-root> run reinstall:fork");
		expect(quickReference).toContain("Changes under `<fork-root>/packages/` require reinstall plus restart");
		expect(quickReference).toContain("Changes under `<fork-root>/agent/` usually only require restart");
		expect(quickReference).toContain("UPDATING.md");
		expect(quickReference).not.toContain("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
	});
});

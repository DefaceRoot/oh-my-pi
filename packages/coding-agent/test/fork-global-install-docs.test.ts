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

const forkRepoPath = "/home/colin/devpod-repos/DefaceRoot/oh-my-pi";
const forkAgentPath = "/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent";

async function readText(filePath: string): Promise<string> {
	return await Bun.file(filePath).text();
}

describe("fork global install documentation", () => {
	test("UPDATING.md exists and documents the fork-managed reinstall loop", async () => {
		const updatingDoc = await readText(updatingDocPath);

		expect(updatingDoc).toContain("git fetch upstream && git rebase upstream/main");
		expect(updatingDoc).toContain("bun install");
		expect(updatingDoc).toContain("bun run reinstall:fork");
		expect(updatingDoc).not.toContain("bun install -g /home/colin/devpod-repos/DefaceRoot/oh-my-pi/packages/coding-agent");
		expect(updatingDoc).toContain("command -v omp");
		expect(updatingDoc).toContain("bun pm bin -g");
		expect(updatingDoc.toLowerCase()).toContain("bun link");
	});

	test("customization skill points users at the fork repo and not patched global installs", async () => {
		const skillDoc = await readText(customizationSkillPath);

		expect(skillDoc).toContain("UPDATING.md");
		expect(skillDoc).toContain(forkAgentPath);
		expect(skillDoc).not.toContain("~/.bun/install/global/node_modules");
		expect(skillDoc).not.toContain("Edit `~/.bun/install/global/node_modules");
		expect(skillDoc).not.toContain("Will be overwritten on next upgrade");
		expect(skillDoc).not.toContain("~/.omp/agent/extensions/plan-worktree/index.ts");
	});

	test("customization quick reference uses repo-managed paths for this fork", async () => {
		const quickReference = await readText(customizationQuickReferencePath);

		expect(quickReference).toContain(`${forkAgentPath}/extensions/*.ts`);
		expect(quickReference).toContain(`${forkAgentPath}/agents/*.md`);
		expect(quickReference).toContain("bun run reinstall:fork");
		expect(quickReference).toContain("UPDATING.md");
		expect(quickReference).not.toContain("~/.omp/agent/extensions/*.ts");
		expect(quickReference).not.toContain("~/.omp/agent/agents/*.md");
	});
});

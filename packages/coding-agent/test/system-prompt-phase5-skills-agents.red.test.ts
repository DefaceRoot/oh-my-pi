import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { buildSystemPrompt } from "../src/system-prompt";

type MainRole = "default" | "orchestrator" | "plan" | "ask";

const TEST_SKILLS: Skill[] = [
	{
		name: "brainstorming",
		description: "Planning skill",
		filePath: "/tmp/skills/brainstorming/SKILL.md",
		baseDir: "/tmp/skills/brainstorming",
		source: "test",
	},
	{
		name: "commit-hygiene",
		description: "Workflow skill",
		filePath: "/tmp/skills/commit-hygiene/SKILL.md",
		baseDir: "/tmp/skills/commit-hygiene",
		source: "test",
	},
	{
		name: "simplify",
		description: "Implementation skill",
		filePath: "/tmp/skills/simplify/SKILL.md",
		baseDir: "/tmp/skills/simplify",
		source: "test",
	},
];

const SHARED_AGENTS_SENTINEL = "PHASE5_SHARED_AGENTS_GUIDANCE";
const PLAN_AGENTS_SENTINEL = "PHASE5_PLAN_ONLY_GUIDANCE";
const ASK_AGENTS_SENTINEL = "PHASE5_ASK_ONLY_GUIDANCE";

function createRoleTools(role: MainRole): Map<string, { label: string; description: string }> {
	const roleTools = DEFAULT_ROLES_CONFIG.roles[role].tools;
	return new Map(roleTools.map(name => [name, { label: name, description: `${name} test tool` }]));
}

async function renderPromptForRole(role: MainRole, options: { cwd: string; skills: Skill[] }): Promise<string> {
	return await buildSystemPrompt({
		mode: role,
		cwd: options.cwd,
		tools: createRoleTools(role),
		skills: options.skills,
		rules: [],
	});
}

describe("Phase 5 RED: per-mode skill filtering", () => {
	it("default mode keeps all skills", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: TEST_SKILLS,
		});

		expect(prompt.includes("## brainstorming")).toBe(true);
		expect(prompt.includes("## commit-hygiene")).toBe(true);
		expect(prompt.includes("## simplify")).toBe(true);
	});

	it("ask mode loads no skills", async () => {
		const prompt = await renderPromptForRole("ask", {
			cwd: os.tmpdir(),
			skills: TEST_SKILLS,
		});

		expect(prompt.includes("## brainstorming")).toBe(false);
		expect(prompt.includes("## commit-hygiene")).toBe(false);
		expect(prompt.includes("## simplify")).toBe(false);
	});

	it("plan mode keeps planning and workflow skills only", async () => {
		const prompt = await renderPromptForRole("plan", {
			cwd: os.tmpdir(),
			skills: TEST_SKILLS,
		});

		expect(prompt.includes("## brainstorming")).toBe(true);
		expect(prompt.includes("## commit-hygiene")).toBe(true);
		expect(prompt.includes("## simplify")).toBe(false);
	});
});

describe("Phase 5 RED: mode-specific AGENTS segmentation", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-phase5-agents-"));
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), `${SHARED_AGENTS_SENTINEL}\n`);
		await fs.writeFile(path.join(tempDir, "AGENTS-plan.md"), `${PLAN_AGENTS_SENTINEL}\n`);
		await fs.writeFile(path.join(tempDir, "AGENTS-ask.md"), `${ASK_AGENTS_SENTINEL}\n`);
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps shared AGENTS guidance in every mode", async () => {
		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			const prompt = await renderPromptForRole(role, {
				cwd: tempDir,
				skills: [],
			});
			expect(prompt.includes(SHARED_AGENTS_SENTINEL)).toBe(true);
		}
	});

	it("plan mode merges plan-only AGENTS guidance while excluding ask-only guidance", async () => {
		const prompt = await renderPromptForRole("plan", {
			cwd: tempDir,
			skills: [],
		});

		expect(prompt.includes(SHARED_AGENTS_SENTINEL)).toBe(true);
		expect(prompt.includes(PLAN_AGENTS_SENTINEL)).toBe(true);
		expect(prompt.includes(ASK_AGENTS_SENTINEL)).toBe(false);
	});

	it("ask mode merges ask-only AGENTS guidance while excluding plan-only guidance", async () => {
		const prompt = await renderPromptForRole("ask", {
			cwd: tempDir,
			skills: [],
		});

		expect(prompt.includes(SHARED_AGENTS_SENTINEL)).toBe(true);
		expect(prompt.includes(ASK_AGENTS_SENTINEL)).toBe(true);
		expect(prompt.includes(PLAN_AGENTS_SENTINEL)).toBe(false);
	});
});

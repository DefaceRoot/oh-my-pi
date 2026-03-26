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
		mode: 'auto' as const,
		content: '',
	},
	{
		name: "commit-hygiene",
		description: "Workflow skill",
		filePath: "/tmp/skills/commit-hygiene/SKILL.md",
		baseDir: "/tmp/skills/commit-hygiene",
		source: "test",
		mode: 'auto' as const,
		content: '',
	},
	{
		name: "simplify",
		description: "Implementation skill",
		filePath: "/tmp/skills/simplify/SKILL.md",
		baseDir: "/tmp/skills/simplify",
		source: "test",
		mode: 'auto' as const,
		content: '',
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

	it("ask mode with no pre-filtered skills shows no skills", async () => {
		const prompt = await renderPromptForRole("ask", {
			cwd: os.tmpdir(),
			skills: [], // ask role has skills: none — caller pre-filters to empty
		});

		expect(prompt.includes("## brainstorming")).toBe(false);
		expect(prompt.includes("## commit-hygiene")).toBe(false);
		expect(prompt.includes("## simplify")).toBe(false);
	});

	it("plan mode renders only the pre-filtered planning and workflow skills", async () => {
		// Skills arrive pre-filtered by the caller; plan role allows planning+workflow categories
		const planSkills = TEST_SKILLS.filter(s => s.name !== "simplify");
		const prompt = await renderPromptForRole("plan", {
			cwd: os.tmpdir(),
			skills: planSkills,
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

describe("Phase 5 RED: dual skill sections (auto vs frontmatter mode)", () => {
	const MIXED_SKILLS: Skill[] = [
		{
			name: "brainstorming",
			description: "Auto planning skill",
			filePath: "/tmp/skills/brainstorming/SKILL.md",
			baseDir: "/tmp/skills/brainstorming",
			source: "test",
			mode: "auto" as const,
			content: "",
		},
		{
			name: "commit-hygiene",
			description: "Frontmatter workflow skill",
			filePath: "/tmp/skills/commit-hygiene/SKILL.md",
			baseDir: "/tmp/skills/commit-hygiene",
			source: "test",
			mode: "frontmatter" as const,
			content: "",
		},
	];

	it("auto skills appear in '# Skills' section (before Available Skills)", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// auto skill must appear in the Skills section, before any Available Skills header
		const skillsIdx = prompt.indexOf("# Skills");
		const availableIdx = prompt.indexOf("# Available Skills");
		const skillsSection = availableIdx > 0 ? prompt.slice(skillsIdx, availableIdx) : prompt.slice(skillsIdx);
		expect(skillsSection.includes("## brainstorming")).toBe(true);
	});

	it("frontmatter skills appear in '# Available Skills' section", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// frontmatter skill must appear after the Available Skills header
		const availableIdx = prompt.indexOf("# Available Skills");
		expect(availableIdx).toBeGreaterThan(0);
		const afterAvailable = prompt.slice(availableIdx);
		expect(afterAvailable.includes("## commit-hygiene")).toBe(true);
		// and NOT in the primary Skills section before it
		const beforeAvailable = prompt.slice(0, availableIdx);
		expect(beforeAvailable.includes("## commit-hygiene")).toBe(false);
	});

	it("auto skill does not appear in '# Available Skills' section", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// brainstorming is auto — only in Skills, not Available Skills
		// Verify Available Skills section exists but doesn't contain brainstorming
		const availableIdx = prompt.indexOf("# Available Skills");
		const afterAvailable = availableIdx >= 0 ? prompt.slice(availableIdx) : "";
		expect(afterAvailable.includes("## brainstorming")).toBe(false);
	});

	it("no frontmatter skills means no Available Skills section", async () => {
		const allAutoSkills: Skill[] = [
			{
				name: "brainstorming",
				description: "Auto skill",
				filePath: "/tmp/skills/brainstorming/SKILL.md",
				baseDir: "/tmp/skills/brainstorming",
				source: "test",
				mode: "auto" as const,
				content: "",
			},
		];
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: allAutoSkills,
		});

		expect(prompt.includes("# Available Skills")).toBe(false);
	});

	it("frontmatter skills render in custom-prompt path", async () => {
		const tools = createRoleTools("default");
		const prompt = await buildSystemPrompt({
			mode: "default",
			customPrompt: "Base prompt",
			cwd: os.tmpdir(),
			tools,
			skills: MIXED_SKILLS,
			rules: [],
		});

		// Both auto and frontmatter skills must appear in custom prompt output
		expect(prompt.includes("brainstorming")).toBe(true);
		expect(prompt.includes("commit-hygiene")).toBe(true);
	});
});


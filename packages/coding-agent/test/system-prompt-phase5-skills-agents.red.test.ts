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

		// All TEST_SKILLS are auto mode — they render as skill:// must-read references
		expect(prompt.includes("skill://brainstorming")).toBe(true);
		expect(prompt.includes("skill://commit-hygiene")).toBe(true);
		expect(prompt.includes("skill://simplify")).toBe(true);
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

		expect(prompt.includes("skill://brainstorming")).toBe(true);
		expect(prompt.includes("skill://commit-hygiene")).toBe(true);
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

	it("auto skills appear in '# Must-Read Skills' section", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// auto skill must appear as a skill:// reference in the Must-Read Skills section
		const mustReadIdx = prompt.indexOf("# Must-Read Skills");
		expect(mustReadIdx).toBeGreaterThan(0);
		const mustReadSection = prompt.slice(mustReadIdx);
		expect(mustReadSection.includes("skill://brainstorming")).toBe(true);
	});

	it("frontmatter skills appear in '# Skills' section", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// frontmatter skill must appear with ## heading in the Skills section, before Must-Read Skills
		const skillsIdx = prompt.indexOf("# Skills");
		const mustReadIdx = prompt.indexOf("# Must-Read Skills");
		expect(mustReadIdx).toBeGreaterThan(skillsIdx);
		const skillsSection = prompt.slice(skillsIdx, mustReadIdx);
		expect(skillsSection.includes("## commit-hygiene")).toBe(true);
		// and NOT as a skill:// reference in Must-Read Skills
		const mustReadSection = prompt.slice(mustReadIdx);
		expect(mustReadSection.includes("## commit-hygiene")).toBe(false);
	});

	it("auto skill does not appear in '# Skills' section", async () => {
		const prompt = await renderPromptForRole("default", {
			cwd: os.tmpdir(),
			skills: MIXED_SKILLS,
		});

		// brainstorming is auto — only as skill:// reference, not as ## heading in # Skills
		const skillsIdx = prompt.indexOf("# Skills");
		const mustReadIdx = prompt.indexOf("# Must-Read Skills");
		const skillsSection = mustReadIdx > skillsIdx ? prompt.slice(skillsIdx, mustReadIdx) : prompt.slice(skillsIdx);
		expect(skillsSection.includes("## brainstorming")).toBe(false);
	});

	it("no frontmatter skills means no ## entries in # Skills section", async () => {
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

		// Auto skill renders as must-read reference, not as a ## section heading
		expect(prompt.includes("skill://brainstorming")).toBe(true);
		expect(prompt.includes("# Available Skills")).toBe(false);
		const skillsIdx = prompt.indexOf("# Skills");
		const mustReadIdx = prompt.indexOf("# Must-Read Skills");
		const skillsSection = mustReadIdx > skillsIdx ? prompt.slice(skillsIdx, mustReadIdx) : prompt.slice(skillsIdx);
		expect(skillsSection.includes("## brainstorming")).toBe(false);
	});

	it("frontmatter skills render in custom-prompt path with correct section placement", async () => {
		const tools = createRoleTools("default");
		const prompt = await buildSystemPrompt({
			mode: "default",
			customPrompt: "Base prompt",
			cwd: os.tmpdir(),
			tools,
			skills: MIXED_SKILLS,
			rules: [],
		});

		// frontmatter skill (commit-hygiene) must appear inside <skills> block, not as a must-read
		const skillsStart = prompt.indexOf("<skills>");
		const skillsEnd = prompt.indexOf("</skills>");
		expect(skillsStart).toBeGreaterThan(0);
		const skillsBlock = prompt.slice(skillsStart, skillsEnd);
		expect(skillsBlock.includes("commit-hygiene")).toBe(true);

		// auto skill (brainstorming) must appear as skill:// reference in <must_read_skills>
		const mustReadStart = prompt.indexOf("<must_read_skills>");
		expect(mustReadStart).toBeGreaterThan(0);
		const mustReadBlock = prompt.slice(mustReadStart, prompt.indexOf("</must_read_skills>") + "</must_read_skills>".length);
		expect(mustReadBlock.includes("skill://brainstorming")).toBe(true);

		// negative: auto skill NOT inside <skills>, frontmatter NOT inside must_read_skills
		expect(skillsBlock.includes("brainstorming")).toBe(false);
		expect(mustReadBlock.includes("commit-hygiene")).toBe(false);
	});
});


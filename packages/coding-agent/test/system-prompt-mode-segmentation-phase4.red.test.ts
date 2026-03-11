import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";
import { renderPromptTemplate, type TemplateContext } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";

type MainRole = "default" | "orchestrator" | "plan" | "ask";

const systemPromptTemplatePath = path.resolve(import.meta.dir, "../src/prompts/system/system-prompt.md");

const baseRenderContext: TemplateContext = {
	agentsMdSearch: { files: [] },
	appendPrompt: "",
	contextFiles: [],
	cwd: "/tmp/system-prompt-phase4-red",
	date: "2026-03-10",
	dateTime: "2026-03-10T12:00:00Z",
	environment: [{ label: "OS", value: "Linux" }],
	intentTracing: false,
	repeatToolDescriptions: false,
	rules: [],
	skills: [],
	systemPromptCustomization: "",
};

let systemPromptTemplate = "";

beforeAll(async () => {
	systemPromptTemplate = await Bun.file(systemPromptTemplatePath).text();
});

function renderForRole(role: MainRole): string {
	const tools = [...DEFAULT_ROLES_CONFIG.roles[role].tools];
	const toolInfo = tools.map(name => ({
		name,
		label: name,
		description: `${name} description`,
	}));

	return renderPromptTemplate(systemPromptTemplate, {
		...baseRenderContext,
		mode: role,
		tools,
		toolInfo,
	});
}

function assertToolSectionsRespectAvailability(prompt: string, tools: string[]): void {
	const available = new Set(tools);
	if (!available.has("edit")) {
		expect(prompt).not.toContain("**Edit tool**");
	}
	if (!available.has("lsp")) {
		expect(prompt).not.toContain("### LSP knows; grep guesses");
	}
	if (!available.has("ssh")) {
		expect(prompt).not.toContain("### SSH: match commands to host shell");
	}
	if (!available.has("task")) {
		expect(prompt).not.toContain("parallelizable via Task tool");
	}
	if (!available.has("ast_grep") && !available.has("ast_edit")) {
		expect(prompt).not.toContain("### AST tools for structural code work");
	}
}

describe("Phase 4 RED: system prompt mode segmentation", () => {
	it("default mode keeps full procedure-oriented sections", () => {
		const prompt = renderForRole("default");
		expect(prompt).toContain("# Procedure");
		expect(prompt).toContain("## 2. Before You Edit");
		expect(prompt).toContain("## 7. Verification");
		expect(prompt).toContain("## 8. Handoff");
	});

	it("plan mode excludes before-edit guidance and uses planning workflow sections", () => {
		const prompt = renderForRole("plan");
		expect(prompt).not.toContain("## 2. Before You Edit");
		expect(prompt).toContain("## Planning Workflow");
		expect(prompt).toContain("### Phase 2: Brainstorm");
		expect(prompt).toContain("### Phase 4: Update Plan");
	});

	it("ask mode omits design-integrity and implementation verification sections", () => {
		const prompt = renderForRole("ask");
		expect(prompt).not.toContain("# Design Integrity");
		expect(prompt).not.toContain("## 2. Before You Edit");
		expect(prompt).not.toContain("## 7. Verification");
	});

	it("each mode only renders tool guidance for its filtered startup tools", () => {
		for (const role of ["default", "orchestrator", "plan", "ask"] as const) {
			const prompt = renderForRole(role);
			const tools = DEFAULT_ROLES_CONFIG.roles[role].tools;
			assertToolSectionsRespectAvailability(prompt, tools);
		}
	});
});

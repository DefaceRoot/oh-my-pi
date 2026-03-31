import { beforeAll, describe, expect, test, vi } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import type { SkillConfig } from "../src/config/roles-config";
import type { Skill } from "../src/extensibility/skills";
import { SkillConfigPanel } from "../src/modes/components/agent-config/skill-config-panel";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function renderText(component: { render: (width: number) => string[] }, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function renderRaw(component: { render: (width: number) => string[] }, width = 120): string {
	return component.render(width).join("\n");
}

function createSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
		mode: "auto",
		content: `${name} content`,
	};
}

function createSkillConfig(): SkillConfig {
	return { auto: [], frontmatter: [] };
}

describe("SkillConfigPanel", () => {
	test("filters skills through slash search and cycles the filtered result", () => {
		const onConfigChange = vi.fn();
		const panel = new SkillConfigPanel({
			skills: [
				createSkill("Alpha", "First skill"),
				createSkill("Beta", "Second skill"),
				createSkill("Gamma", "Third skill"),
			],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange,
				onClose: vi.fn(),
			},
		});

		expect(renderText(panel)).toContain("Search (/ to edit)");
		expect(renderText(panel)).toContain("Alpha");
		expect(renderText(panel)).toContain("Beta");
		expect(renderText(panel)).toContain("Gamma");
		expect(renderRaw(panel)).not.toContain(CURSOR_MARKER);

		panel.handleInput("/");
		expect(renderRaw(panel)).toContain(CURSOR_MARKER);
		panel.handleInput("b");
		panel.handleInput("e");
		panel.handleInput("t");
		panel.handleInput("a");
		panel.handleInput("\n");

		const filtered = renderText(panel);
		expect(filtered).toContain("Search (/ to edit)");
		expect(filtered).toContain("Beta");
		expect(filtered).not.toContain("Alpha");
		expect(filtered).not.toContain("Gamma");

		panel.handleInput(" ");
		expect(onConfigChange).toHaveBeenCalledTimes(1);
		expect(onConfigChange).toHaveBeenCalledWith({ auto: ["Beta"], frontmatter: [] });
	});

	test("keeps the current skill selected while refining the search", () => {
		const onConfigChange = vi.fn();
		const panel = new SkillConfigPanel({
			skills: [
				createSkill("Alpha", "First skill"),
				createSkill("Beta", "Second skill"),
				createSkill("Gamma", "Third skill"),
			],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange,
				onClose: vi.fn(),
			},
		});

		panel.handleInput("j");
		panel.handleInput("/");
		panel.handleInput("a");
		panel.handleInput("\n");
		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledTimes(1);
		expect(onConfigChange).toHaveBeenCalledWith({ auto: ["Beta"], frontmatter: [] });
	});
	test("escape clears search while filtering and closes when not filtering", () => {
		const onClose = vi.fn();
		const panel = new SkillConfigPanel({
			skills: [createSkill("Alpha", "First skill"), createSkill("Beta", "Second skill")],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange: vi.fn(),
				onClose,
			},
		});

		panel.handleInput("/");
		panel.handleInput("a");
		panel.handleInput("l");
		panel.handleInput("p");
		expect(renderText(panel)).toContain("enter:done");
		expect(renderText(panel)).toContain("esc:clear search");
		expect(renderText(panel)).toContain("Search (editing)");
		expect(renderText(panel)).toContain("Alpha");
		expect(renderText(panel)).not.toContain("Beta");

		panel.handleInput("\x1b");
		const cleared = renderText(panel);
		expect(cleared).toContain("Search (/ to edit)");
		expect(cleared).toContain("Alpha");
		expect(cleared).toContain("Beta");

		panel.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("keeps the active query applied after the skills list updates", () => {
		const panel = new SkillConfigPanel({
			skills: [createSkill("Alpha", "First skill"), createSkill("Beta", "Second skill")],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange: vi.fn(),
				onClose: vi.fn(),
			},
		});

		panel.handleInput("/");
		panel.handleInput("b");
		expect(renderText(panel)).toContain("Beta");
		expect(renderText(panel)).not.toContain("Alpha");

		panel.update([createSkill("Beta", "Second skill"), createSkill("Delta", "Fourth skill")], createSkillConfig());

		const updated = renderText(panel);
		expect(updated).toContain("Beta");
		expect(updated).not.toContain("Alpha");
		expect(updated).not.toContain("Delta");
	});

	test("keeps the selected skill after a reordered update", () => {
		const onConfigChange = vi.fn();
		const panel = new SkillConfigPanel({
			skills: [
				createSkill("Alpha", "First skill"),
				createSkill("Beta", "Second skill"),
				createSkill("Gamma", "Third skill"),
			],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange,
				onClose: vi.fn(),
			},
		});

		panel.handleInput("j");
		panel.update(
			[
				createSkill("Gamma", "Third skill"),
				createSkill("Alpha", "First skill"),
				createSkill("Beta", "Second skill"),
			],
			createSkillConfig(),
		);
		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledTimes(1);
		expect(onConfigChange).toHaveBeenCalledWith({ auto: ["Beta"], frontmatter: [] });
	});
	test("shows a recovery footer when the search matches nothing", () => {
		const panel = new SkillConfigPanel({
			skills: [createSkill("Alpha", "First skill"), createSkill("Beta", "Second skill")],
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange: vi.fn(),
				onClose: vi.fn(),
			},
		});

		panel.handleInput("/");
		panel.handleInput("z");
		panel.handleInput("z");
		panel.handleInput("z");

		const editing = renderText(panel);
		expect(editing).toContain("No matching skills.");
		expect(editing).toContain("enter:done");
		expect(editing).toContain("esc:clear search");

		panel.handleInput("\n");
		const rendered = renderText(panel);
		expect(rendered).toContain("No matching skills.");
		expect(rendered).toContain("/:search");
		expect(rendered).toContain("esc:close");
		expect(rendered).not.toContain("↑/↓:navigate");
	});

	test("resets the viewport when the skills list shrinks", () => {
		const panel = new SkillConfigPanel({
			skills: Array.from({ length: 20 }, (_, index) =>
				createSkill(`Skill${String(index + 1).padStart(2, "0")}`, `Skill ${index + 1}`),
			),
			skillConfig: createSkillConfig(),
			callbacks: {
				onConfigChange: vi.fn(),
				onClose: vi.fn(),
			},
		});

		for (let index = 0; index < 19; index += 1) {
			panel.handleInput("j");
		}

		const scrolled = renderText(panel);
		expect(scrolled).toContain("▲ more");

		panel.update([createSkill("Skill01", "Skill 1"), createSkill("Skill02", "Skill 2")], createSkillConfig());

		const updated = renderText(panel);
		expect(updated).toContain("Skill01");
		expect(updated).toContain("Skill02");
		expect(updated).not.toContain("▲ more");
	});
});

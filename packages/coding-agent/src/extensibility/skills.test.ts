import { describe, expect, mock, test, vi } from "bun:test";

const disabledProviders = new Set<string>();
const mockLoadCapability = vi.fn();

mock.module("../discovery", () => ({
	loadCapability: mockLoadCapability,
	isProviderEnabled: (id: string) => !disabledProviders.has(id),
}));

mock.module("../discovery/helpers", () => ({
	scanSkillsFromDir: vi.fn().mockResolvedValue({ items: [], warnings: [] }),
	compareSkillOrder: (a: string, _p1: string, b: string, _p2: string) => a.localeCompare(b),
}));

mock.module("../tools/path-utils", () => ({
	expandTilde: (p: string) => p,
}));

import { loadSkills } from "./skills";

function makeCapSkill(name: string, provider: string, level: "user" | "project" = "user") {
	return {
		name,
		path: `/fake/${name}/SKILL.md`,
		content: `## ${name}`,
		frontmatter: { description: `${name} skill` },
		level,
		_source: { provider, level, path: `/fake/${name}/SKILL.md`, providerName: provider },
	};
}

function makeCapResult(skills: ReturnType<typeof makeCapSkill>[]) {
	return { items: skills, all: skills, warnings: [], providers: [skills[0]?._source.provider ?? ""] };
}

describe("loadSkills — isSourceEnabled agents-provider fix", () => {
	test("agents skills shown when agents provider enabled even if all legacy flags are false", async () => {
		disabledProviders.clear();
		const agentsSkill = makeCapSkill("my-skill", "agents");
		mockLoadCapability.mockResolvedValueOnce(makeCapResult([agentsSkill]));

		const result = await loadSkills({
			enableCodexUser: false,
			enableClaudeUser: false,
			enableClaudeProject: false,
			enablePiUser: false,
			enablePiProject: false,
		});

		expect(result.skills.map(s => s.name)).toContain("my-skill");
	});

	test("agents skills excluded when agents provider is disabled via capability system", async () => {
		disabledProviders.clear();
		disabledProviders.add("agents");
		const agentsSkill = makeCapSkill("my-skill", "agents");
		// loadCapability is mocked so it returns the skill even with disabled provider;
		// isSourceEnabled is the layer that must now reject it.
		mockLoadCapability.mockResolvedValueOnce(makeCapResult([agentsSkill]));

		const result = await loadSkills({ enablePiUser: true });

		expect(result.skills.map(s => s.name)).not.toContain("my-skill");
		disabledProviders.clear();
	});

	test("native skills excluded when enablePiUser is false (legacy flag preserved)", async () => {
		disabledProviders.clear();
		const nativeSkill = makeCapSkill("pi-skill", "native", "user");
		mockLoadCapability.mockResolvedValueOnce(makeCapResult([nativeSkill]));

		const result = await loadSkills({ enablePiUser: false });

		expect(result.skills.map(s => s.name)).not.toContain("pi-skill");
	});

	test("agents skills shown when native is disabled via legacy flag but agents provider enabled", async () => {
		disabledProviders.clear();
		const agentsSkill = makeCapSkill("agents-skill", "agents");
		mockLoadCapability.mockResolvedValueOnce(makeCapResult([agentsSkill]));

		// enablePiUser:false disables native but not agents; agents provider not in disabledProviders
		const result = await loadSkills({ enablePiUser: false });

		expect(result.skills.map(s => s.name)).toContain("agents-skill");
	});
});

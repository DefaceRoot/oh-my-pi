import { beforeEach, describe, expect, mock, test, vi } from "bun:test";

const mockLoadCapability = vi.fn();
const mockScanSkillsFromDir = vi.fn();

mock.module("../../../discovery", () => ({
	loadCapability: mockLoadCapability,
	isProviderEnabled: () => true,
	getAllProvidersInfo: () => [],
	disableProvider: vi.fn(),
	enableProvider: vi.fn(),
}));

mock.module("../../../discovery/helpers", () => ({
	scanSkillsFromDir: mockScanSkillsFromDir,
}));

mock.module("../../../tools/path-utils", () => ({
	expandTilde: (p: string) => p,
}));

mock.module("@oh-my-pi/pi-utils", () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), time: vi.fn(), timeAsync: vi.fn() },
	getProjectDir: () => "/fake/cwd",
}));

import { loadAllExtensions } from "./state-manager";

function emptyCapResult() {
	return { items: [], all: [], warnings: [], providers: [] };
}

function makeCapSkill(name: string, provider = "custom") {
	return {
		name,
		path: `/custom-dir/${name}/SKILL.md`,
		content: `## ${name}`,
		frontmatter: { description: `${name} skill` },
		level: "user" as const,
		_source: { provider, level: "user" as const, path: `/custom-dir/${name}/SKILL.md`, providerName: provider },
	};
}

describe("loadAllExtensions — custom directories", () => {
	beforeEach(() => {
		mockLoadCapability.mockReset();
		mockScanSkillsFromDir.mockReset();
	});

	test("includes skills from custom directories", async () => {
		mockLoadCapability.mockResolvedValue(emptyCapResult());
		const customSkill = makeCapSkill("custom-skill");
		mockScanSkillsFromDir.mockResolvedValueOnce({ items: [customSkill], warnings: [] });

		const extensions = await loadAllExtensions(undefined, undefined, ["/my/custom/skills"]);

		const skillExtension = extensions.find(e => e.name === "custom-skill");
		expect(skillExtension).toBeDefined();
		expect(skillExtension?.kind).toBe("skill");
	});

	test("custom skill state is active when not individually disabled", async () => {
		mockLoadCapability.mockResolvedValue(emptyCapResult());
		const customSkill = makeCapSkill("enabled-custom-skill");
		mockScanSkillsFromDir.mockResolvedValueOnce({ items: [customSkill], warnings: [] });

		const extensions = await loadAllExtensions(undefined, [], ["/my/skills"]);

		const ext = extensions.find(e => e.name === "enabled-custom-skill");
		expect(ext?.state).toBe("active");
	});

	test("custom skill state is disabled when individually disabled", async () => {
		mockLoadCapability.mockResolvedValue(emptyCapResult());
		const customSkill = makeCapSkill("disabled-custom-skill");
		mockScanSkillsFromDir.mockResolvedValueOnce({ items: [customSkill], warnings: [] });

		const extensions = await loadAllExtensions(undefined, ["skill:disabled-custom-skill"], ["/my/skills"]);

		const ext = extensions.find(e => e.name === "disabled-custom-skill");
		expect(ext?.state).toBe("disabled");
		expect(ext?.disabledReason).toBe("item-disabled");
	});

	test("loads skills from multiple custom directories", async () => {
		mockLoadCapability.mockResolvedValue(emptyCapResult());
		mockScanSkillsFromDir
			.mockResolvedValueOnce({ items: [makeCapSkill("skill-a")], warnings: [] })
			.mockResolvedValueOnce({ items: [makeCapSkill("skill-b")], warnings: [] });

		const extensions = await loadAllExtensions(undefined, undefined, ["/dir-a", "/dir-b"]);

		const names = extensions.map(e => e.name);
		expect(names).toContain("skill-a");
		expect(names).toContain("skill-b");
	});

	test("omitting customDirectories leaves custom scanning unchanged (empty)", async () => {
		mockLoadCapability.mockResolvedValue(emptyCapResult());

		const extensions = await loadAllExtensions();

		expect(mockScanSkillsFromDir).not.toHaveBeenCalled();
		expect(extensions.filter(e => e.kind === "skill")).toHaveLength(0);
	});
});

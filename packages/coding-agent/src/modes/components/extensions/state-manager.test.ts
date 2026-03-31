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

import { loadAllExtensions, filterByProvider, buildProviderTabs } from "./state-manager";
import type { Extension } from "./types";

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


function makeExtension(name: string, provider: string): Extension {
	return {
		id: `skill:${name}`,
		kind: "skill",
		name,
		displayName: name,
		path: `/fake/${name}`,
		source: { provider, providerName: provider, level: "user" as const },
		state: "active",
		raw: {},
	};
}

describe("filterByProvider — ALL tab native exclusion", () => {
	const nativeExt = makeExtension("native-skill", "native");
	const agentExt = makeExtension("agent-skill", "agents");
	const customExt = makeExtension("custom-skill", "custom");
	const mixed = [nativeExt, agentExt, customExt];

	test("excludes native-provider entries from ALL", () => {
		const result = filterByProvider(mixed, "all");
		expect(result.some(e => e.source.provider === "native")).toBe(false);
	});

	test("includes non-native entries in ALL", () => {
		const result = filterByProvider(mixed, "all");
		expect(result).toHaveLength(2);
		expect(result.map(e => e.name)).toContain("agent-skill");
		expect(result.map(e => e.name)).toContain("custom-skill");
	});

	test("returns empty array when all entries are native", () => {
		const result = filterByProvider([nativeExt], "all");
		expect(result).toHaveLength(0);
	});

	test("provider-specific filtering is unaffected by native exclusion logic", () => {
		const result = filterByProvider(mixed, "agents");
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("agent-skill");
	});
});

describe("buildProviderTabs — ALL tab count native exclusion", () => {
	const nativeExt = makeExtension("native-skill", "native");
	const agentExt = makeExtension("agent-skill", "agents");
	const customExt = makeExtension("custom-skill", "custom");

	test("ALL tab count excludes native entries", () => {
		const tabs = buildProviderTabs([nativeExt, agentExt, customExt]);
		const allTab = tabs.find(t => t.id === "all");
		expect(allTab?.count).toBe(2);
	});

	test("ALL tab count is 0 when all entries are native", () => {
		const tabs = buildProviderTabs([nativeExt]);
		const allTab = tabs.find(t => t.id === "all");
		expect(allTab?.count).toBe(0);
	});

	test("ALL tab count matches non-native-only list", () => {
		const tabs = buildProviderTabs([agentExt, customExt]);
		const allTab = tabs.find(t => t.id === "all");
		expect(allTab?.count).toBe(2);
	});
});
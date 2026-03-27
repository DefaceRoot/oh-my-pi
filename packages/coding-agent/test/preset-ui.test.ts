import { beforeAll, describe, expect, test, vi } from "bun:test";
import { MODEL_ROLE_IDS } from "../src/config/model-registry";
import type { PresetSnapshot } from "../src/config/presets-config";
import { PresetBar } from "../src/modes/components/agent-config/preset-bar";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { PresetSelector } from "../src/modes/components/agent-config/preset-selector";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

function renderText(component: { render: (width: number) => string[] }, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function eraseInput(component: { handleInput: (data: string) => void }, count: number): void {
	for (let index = 0; index < count; index += 1) {
		component.handleInput("\x7f");
	}
}

function createSnapshot(overrides: Partial<PresetSnapshot> = {}): PresetSnapshot {
	const modelRoles = Object.fromEntries(
		MODEL_ROLE_IDS.map(role => [role, "anthropic/claude-sonnet-4-5"]),
	) as PresetSnapshot["modelRoles"];
	return {
		description: "Baseline preset",
		createdAt: "2026-03-27T00:00:00.000Z",
		updatedAt: "2026-03-27T00:00:00.000Z",
		modelRoles,
		roles: {} as PresetSnapshot["roles"],
		subagents: {} as PresetSnapshot["subagents"],
		...overrides,
	};
}

class TestPresetsConfig {
	#presets = new Map<string, PresetSnapshot>();
	#captured = {
		modelRoles: createSnapshot().modelRoles,
		roles: {} as PresetSnapshot["roles"],
		subagents: {} as PresetSnapshot["subagents"],
	};
	activePreset: string | null;
	defaultPreset: string | null = null;
	readonly applyCalls: string[] = [];

	constructor(initial: Record<string, PresetSnapshot>, activePreset: string | null = null) {
		for (const [name, snapshot] of Object.entries(initial)) {
			this.#presets.set(name, structuredClone(snapshot));
		}
		this.activePreset = activePreset;
	}

	listPresets(): Array<{ name: string; description?: string; createdAt: string; updatedAt: string }> {
		return [...this.#presets.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, snapshot]) => ({
				name,
				description: snapshot.description,
				createdAt: snapshot.createdAt,
				updatedAt: snapshot.updatedAt,
			}));
	}

	getPreset(name: string): PresetSnapshot | undefined {
		const snapshot = this.#presets.get(name);
		return snapshot ? structuredClone(snapshot) : undefined;
	}

	getActivePreset(): string | null {
		return this.activePreset;
	}

	getDefaultPreset(): string | null {
		return this.defaultPreset;
	}

	setDefaultPreset(name: string | null): void {
		if (name !== null && !this.#presets.has(name)) {
			throw new Error(`Unknown preset: ${name}`);
		}
		this.defaultPreset = name;
	}

	captureCurrentConfig(): Pick<PresetSnapshot, "modelRoles" | "roles" | "subagents"> {
		return structuredClone(this.#captured);
	}

	savePreset(name: string, snapshot: PresetSnapshot): void {
		this.#presets.set(name, structuredClone(snapshot));
	}

	deletePreset(name: string): void {
		this.#presets.delete(name);
		if (this.activePreset === name) {
			this.activePreset = null;
		}
	}

	renamePreset(oldName: string, newName: string): void {
		const snapshot = this.#presets.get(oldName);
		if (!snapshot) return;
		this.#presets.set(newName, structuredClone(snapshot));
		this.#presets.delete(oldName);
		if (this.activePreset === oldName) {
			this.activePreset = newName;
		}
	}

	async applyPreset(name: string): Promise<void> {
		if (!this.#presets.has(name)) {
			throw new Error(`Unknown preset: ${name}`);
		}
		this.applyCalls.push(name);
		this.activePreset = name;
	}
}

class FailingPresetsConfig extends TestPresetsConfig {
	failSave = false;
	failRename = false;

	override savePreset(name: string, snapshot: PresetSnapshot): void {
		if (this.failSave) {
			throw new Error("Save failed");
		}
		super.savePreset(name, snapshot);
	}

	override renamePreset(oldName: string, newName: string): void {
		if (this.failRename) {
			throw new Error("Rename failed");
		}
		super.renamePreset(oldName, newName);
	}
}

describe("PresetBar", () => {
	test("renders custom, active, and modified states", () => {
		const customBar = new PresetBar({
			activePreset: null,
			isModified: false,
			onSave: () => {},
			onSaveAs: () => {},
			onSwitch: () => {},
			onRevert: () => {},
		});
		expect(renderText(customBar)).toContain("Preset: Custom");
		expect(renderText(customBar)).toContain("[Save as...]");
		expect(renderText(customBar)).toContain("[Switch]");
		expect(renderText(customBar)).not.toContain("[Revert]");

		const activeBar = new PresetBar({
			activePreset: "Production Quality",
			isModified: false,
			onSave: () => {},
			onSaveAs: () => {},
			onSwitch: () => {},
			onRevert: () => {},
		});
		expect(renderText(activeBar)).toContain("Preset: Production Quality");
		expect(renderText(activeBar)).toContain("[Save]");
		expect(renderText(activeBar)).toContain("[Revert]");
		expect(renderText(activeBar)).not.toContain("*");

		const modifiedBar = new PresetBar({
			activePreset: "Production Quality",
			isModified: true,
			onSave: () => {},
			onSaveAs: () => {},
			onSwitch: () => {},
			onRevert: () => {},
		});
		expect(renderText(modifiedBar)).toContain("Preset: Production Quality *");
	});

	test("routes keyboard shortcuts only when the action is available", () => {
		const onSave = vi.fn();
		const onSaveAs = vi.fn();
		const onSwitch = vi.fn();
		const onRevert = vi.fn();
		const modifiedBar = new PresetBar({
			activePreset: "Production Quality",
			isModified: true,
			onSave,
			onSaveAs,
			onSwitch,
			onRevert,
		});

		modifiedBar.handleInput("s");
		modifiedBar.handleInput("p");
		modifiedBar.handleInput("r");
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSwitch).toHaveBeenCalledTimes(1);
		expect(onRevert).toHaveBeenCalledTimes(1);
		expect(onSaveAs).not.toHaveBeenCalled();

		const unmodifiedBar = new PresetBar({
			activePreset: "Production Quality",
			isModified: false,
			onSave,
			onSaveAs,
			onSwitch,
			onRevert,
		});
		unmodifiedBar.handleInput("s");
		unmodifiedBar.handleInput("r");
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onRevert).toHaveBeenCalledTimes(1);

		const customBar = new PresetBar({
			activePreset: null,
			isModified: false,
			onSave,
			onSaveAs,
			onSwitch,
			onRevert,
		});
		customBar.handleInput("s");
		customBar.handleInput("p");
		expect(onSaveAs).toHaveBeenCalledTimes(1);
		expect(onSwitch).toHaveBeenCalledTimes(2);
	});
});

describe("PresetSelector", () => {
	test("renders preset metadata and filters through explicit search mode", () => {
		const presetsConfig = new TestPresetsConfig(
			{
				"Production Quality": createSnapshot({
					description: "High-quality models",
					updatedAt: "2026-03-26T10:00:00.000Z",
				}),
				"Fast Iteration": createSnapshot({
					description: "Cheap models for prototyping",
					updatedAt: "2026-03-25T10:00:00.000Z",
				}),
			},
			"Production Quality",
		);
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		const initial = renderText(selector, 90);
		expect(initial).toContain("Select Preset");
		expect(initial).toContain("Production Quality");
		expect(initial).toContain("High-quality models");
		expect(initial).toContain("Updated: 2026-03-26");
		expect(initial).toContain("Fast Iteration");

		selector.handleInput("/");
		selector.handleInput("p");
		selector.handleInput("r");
		selector.handleInput("o");
		selector.handleInput("d");
		selector.handleInput("\n");
		const filtered = renderText(selector, 90);
		expect(filtered).toContain("Search");
		expect(filtered).toContain("Production Quality");
		expect(filtered).not.toContain("Fast Iteration");
		expect(filtered).not.toContain("Delete preset");
	});

	test("navigates and applies the selected preset", async () => {
		const presetsConfig = new TestPresetsConfig(
			{
				Alpha: createSnapshot({ updatedAt: "2026-03-24T10:00:00.000Z" }),
				Bravo: createSnapshot({ updatedAt: "2026-03-25T10:00:00.000Z" }),
			},
			"Alpha",
		);
		const onApply = vi.fn();
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply,
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("j");
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(presetsConfig.applyCalls).toEqual(["Bravo"]);
		expect(presetsConfig.getActivePreset()).toBe("Bravo");
		expect(onApply).toHaveBeenCalledWith("Bravo");
	});

	test("scrolls long preset lists while keeping the active preset visible", () => {
		const presetsConfig = new TestPresetsConfig(
			{
				Alpha: createSnapshot({ updatedAt: "2026-03-20T10:00:00.000Z" }),
				Bravo: createSnapshot({ updatedAt: "2026-03-21T10:00:00.000Z" }),
				Charlie: createSnapshot({ updatedAt: "2026-03-22T10:00:00.000Z" }),
				Delta: createSnapshot({ updatedAt: "2026-03-23T10:00:00.000Z" }),
				Echo: createSnapshot({ updatedAt: "2026-03-24T10:00:00.000Z" }),
				Foxtrot: createSnapshot({ updatedAt: "2026-03-25T10:00:00.000Z" }),
				Golf: createSnapshot({ updatedAt: "2026-03-26T10:00:00.000Z" }),
				Hotel: createSnapshot({ updatedAt: "2026-03-27T10:00:00.000Z" }),
			},
			"Hotel",
		);
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		const initial = renderText(selector, 90);
		expect(initial).toContain("▼ more");
		expect(initial).not.toContain("Hotel");

		for (let index = 0; index < 7; index += 1) {
			selector.handleInput("j");
		}

		const scrolled = renderText(selector, 90);
		expect(scrolled).toContain("▲ more");
		expect(scrolled).toContain("●  Hotel");
		expect(scrolled).not.toContain("Alpha");
	});

	test("keeps active preset state accurate when renaming or deleting the active preset", () => {
		const presetsConfig = new TestPresetsConfig(
			{
				Alpha: createSnapshot({ description: "First preset", updatedAt: "2026-03-24T10:00:00.000Z" }),
				Bravo: createSnapshot({ description: "Second preset", updatedAt: "2026-03-25T10:00:00.000Z" }),
			},
			"Alpha",
		);
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		expect(renderText(selector)).toContain("●  Alpha");

		selector.handleInput("r");
		eraseInput(selector, "Alpha".length);
		for (const ch of "Active Alpha") selector.handleInput(ch);
		selector.handleInput("\n");

		expect(presetsConfig.getActivePreset()).toBe("Active Alpha");
		expect(renderText(selector)).toContain("●  Active Alpha");

		selector.handleInput("d");
		selector.handleInput("\n");

		expect(presetsConfig.getActivePreset()).toBeNull();
		expect(renderText(selector)).not.toContain("●");
		expect(renderText(selector)).toContain("Bravo");
	});

	test("creates, renames, edits descriptions, and deletes presets", () => {
		const presetsConfig = new TestPresetsConfig(
			{
				Alpha: createSnapshot({ description: "First preset", updatedAt: "2026-03-24T10:00:00.000Z" }),
				Bravo: createSnapshot({ description: "Second preset", updatedAt: "2026-03-25T10:00:00.000Z" }),
			},
			"Alpha",
		);
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("n");
		for (const ch of "Custom Build") selector.handleInput(ch);
		selector.handleInput("\n");
		expect(presetsConfig.getPreset("Custom Build")).toBeDefined();
		expect(presetsConfig.getPreset("Custom Build")?.updatedAt).toBe("2026-03-27T12:00:00.000Z");
		expect(renderText(selector)).toContain("Custom Build");

		selector.handleInput("r");
		eraseInput(selector, "Custom Build".length);
		for (const ch of "Bravo") selector.handleInput(ch);
		selector.handleInput("\n");
		expect(renderText(selector)).toContain("already exists");
		expect(presetsConfig.getPreset("Custom Build")).toBeDefined();

		selector.handleInput("\x1b");
		selector.handleInput("r");
		eraseInput(selector, "Custom Build".length);
		for (const ch of "Custom Saved") selector.handleInput(ch);
		selector.handleInput("\n");
		expect(presetsConfig.getPreset("Custom Saved")).toBeDefined();
		expect(presetsConfig.getPreset("Custom Build")).toBeUndefined();

		selector.handleInput("e");
		for (const ch of "Updated description") selector.handleInput(ch);
		selector.handleInput("\n");
		expect(presetsConfig.getPreset("Custom Saved")?.description).toBe("Updated description");

		selector.handleInput("d");
		selector.handleInput("\n");
		expect(presetsConfig.getPreset("Custom Saved")).toBeUndefined();
		expect(renderText(selector)).toContain("Alpha");
	});

	test("keeps the save prompt frame aligned while typing a preset name", () => {
		const presetsConfig = new TestPresetsConfig({ Alpha: createSnapshot() }, "Alpha");
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("n");
		for (const ch of "Preset Name") {
			selector.handleInput(ch);
			for (const line of selector.render(48)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(48);
			}
		}
	});


	test("keeps the create prompt open and shows inline errors when saving fails", async () => {
		const presetsConfig = new FailingPresetsConfig({ Alpha: createSnapshot() }, "Alpha");
		presetsConfig.failSave = true;
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("n");
		for (const ch of "Broken") selector.handleInput(ch);
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(rendered).toContain("Save current settings as");
		expect(rendered).toContain("Save failed");
	});

	test("keeps the rename prompt open and shows inline errors when renaming fails", async () => {
		const presetsConfig = new FailingPresetsConfig({ Alpha: createSnapshot() }, "Alpha");
		presetsConfig.failRename = true;
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("r");
		eraseInput(selector, "Alpha".length);
		for (const ch of "Beta") selector.handleInput(ch);
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(rendered).toContain("Rename Alpha");
		expect(rendered).toContain("Rename failed");
	});

	test("reports when a preset disappears during inline editing", () => {
		const presetsConfig = new TestPresetsConfig({ Alpha: createSnapshot() }, "Alpha");
		const selector = new PresetSelector({
			presetsConfig: presetsConfig as never,
			onApply: () => {},
			onClose: () => {},
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("e");
		presetsConfig.deletePreset("Alpha");
		selector.handleInput("x");
		selector.handleInput("\n");

		const rendered = renderText(selector);
		expect(rendered).toContain("Preset Alpha no longer exists.");
		expect(rendered).toContain("No presets match. Press n to save the current configuration.");
	});

	test("closes on interrupt input", () => {
		const onClose = vi.fn();
		const selector = new PresetSelector({
			presetsConfig: new TestPresetsConfig({ Alpha: createSnapshot() }, "Alpha") as never,
			onApply: () => {},
			onClose,
			now: () => "2026-03-27T12:00:00.000Z",
		});

		selector.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

import { type Component, hasCursorMarker, Input, matchesKey, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { PresetsConfig } from "../../../config/presets-config";
import { fuzzyFilter } from "../../../utils/fuzzy";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

const MAX_VISIBLE_PRESETS = 6;

type PresetListItem = ReturnType<PresetsConfig["listPresets"]>[number];
type PresetStore = Pick<
	PresetsConfig,
	| "applyPreset"
	| "captureCurrentConfig"
	| "deletePreset"
	| "getActivePreset"
	| "getPreset"
	| "listPresets"
	| "renamePreset"
	| "savePreset"
>;
type StatusTone = "success" | "warning" | "error";

type InputMode = {
	kind: "create" | "rename" | "description";
	prompt: string;
	input: Input;
	targetName?: string;
	error?: string;
};

type ConfirmMode = {
	prompt: string;
	detail?: string;
	onConfirm: () => Promise<void> | void;
};

export interface PresetSelectorOptions {
	presetsConfig: PresetStore;
	onApply: (name: string) => void | Promise<void>;
	onClose: () => void;
	now?: () => string;
}

/**
 * Overlay-friendly preset browser and manager.
 *
 * This component keeps all edit prompts inline so callers can embed it in an
 * overlay without stacking another modal for basic preset management.
 */
export class PresetSelector implements Component {
	readonly #presetsConfig: PresetStore;
	readonly #onApply: (name: string) => void | Promise<void>;
	readonly #onClose: () => void;
	readonly #now: () => string;
	readonly #searchInput = new Input();

	#allPresets: PresetListItem[] = [];
	#visiblePresets: PresetListItem[] = [];
	#selectedIndex = 0;
	#scrollOffset = 0;
	#statusMessage?: string;
	#statusTone: StatusTone = "success";
	#inputMode: InputMode | null = null;
	#confirmMode: ConfirmMode | null = null;
	#filterMode = false;

	constructor(options: PresetSelectorOptions) {
		this.#presetsConfig = options.presetsConfig;
		this.#onApply = options.onApply;
		this.#onClose = options.onClose;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#refreshPresets();
	}

	invalidate(): void {
		// Stateless render; nothing to invalidate.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(28, width);
		const innerWidth = Math.max(24, safeWidth - 2);
		this.#syncInputFocus();
		const lines = [
			this.#frameTop(innerWidth),
			this.#frameRow(theme.bold(theme.fg("accent", "Select Preset")), innerWidth),
			this.#frameRow(theme.fg("muted", this.#filterMode ? "Search (editing)" : "Search (/ to edit)"), innerWidth),
			this.#frameRow(this.#searchInput.render(innerWidth)[0] ?? "> ", innerWidth),
			...this.#renderStatusRows(innerWidth),
			...this.#renderPromptRows(innerWidth),
			...this.#renderPresetRows(innerWidth),
			this.#frameRow(
				theme.fg("dim", "↑/↓ move  / search  Enter apply  n new  r rename  e describe  d delete  Esc close"),
				innerWidth,
			),
			this.#frameBottom(innerWidth),
		];
		return lines.map(line => theme.overlaySurface(line));
	}

	handleInput(keyData: string): void {
		if (this.#inputMode) {
			this.#handleInputMode(keyData);
			return;
		}
		if (this.#confirmMode) {
			this.#handleConfirmMode(keyData);
			return;
		}
		if (this.#filterMode) {
			this.#handleFilterInput(keyData);
			return;
		}
		this.#handleBrowseInput(keyData);
	}

	#handleBrowseInput(keyData: string): void {
		if (matchesKey(keyData, "up") || keyData === "k") {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down") || keyData === "j") {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			void this.#applySelectedPreset();
			return;
		}
		if (keyData === "/") {
			this.#filterMode = true;
			return;
		}
		if (keyData === "n" || keyData === "N") {
			this.#startCreate();
			return;
		}
		if (keyData === "d" || keyData === "D") {
			this.#startDelete();
			return;
		}
		if (keyData === "r" || keyData === "R") {
			this.#startRename();
			return;
		}
		if (keyData === "e" || keyData === "E") {
			this.#startDescriptionEdit();
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			this.#onClose();
		}
	}

	#handleFilterInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#filterMode = false;
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			this.#filterMode = false;
			this.#searchInput.setValue("");
			this.#refreshPresets();
			return;
		}

		const previousName = this.#currentPresetName();
		this.#searchInput.handleInput(keyData);
		this.#refreshPresets(previousName);
	}

	#handleInputMode(keyData: string): void {
		if (!this.#inputMode) return;
		if (matchesAppInterrupt(keyData)) {
			this.#inputMode = null;
			return;
		}
		this.#inputMode.input.handleInput(keyData);
	}

	#handleConfirmMode(keyData: string): void {
		if (!this.#confirmMode) return;
		if (
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return") ||
			keyData === "\n" ||
			keyData === "y" ||
			keyData === "Y"
		) {
			const mode = this.#confirmMode;
			this.#confirmMode = null;
			void this.#runConfirm(mode);
			return;
		}
		if (matchesAppInterrupt(keyData) || keyData === "n" || keyData === "N") {
			this.#confirmMode = null;
		}
	}

	#startCreate(): void {
		const input = new Input();
		input.onSubmit = value => {
			void this.#submitInputMode(value);
		};
		this.#inputMode = {
			kind: "create",
			prompt: "Save current settings as",
			input,
		};
	}

	#startRename(): void {
		const preset = this.#currentPreset();
		if (!preset) {
			this.#setStatus("Choose a preset to rename.", "warning");
			return;
		}
		const input = new Input();
		seedInputValue(input, preset.name);
		input.onSubmit = value => {
			void this.#submitInputMode(value);
		};
		this.#inputMode = {
			kind: "rename",
			prompt: `Rename ${preset.name}`,
			input,
			targetName: preset.name,
		};
	}

	#startDescriptionEdit(): void {
		const preset = this.#currentPreset();
		if (!preset) {
			this.#setStatus("Choose a preset to edit.", "warning");
			return;
		}
		const snapshot = this.#presetsConfig.getPreset(preset.name);
		const input = new Input();
		seedInputValue(input, snapshot?.description ?? "");
		input.onSubmit = value => {
			void this.#submitInputMode(value);
		};
		this.#inputMode = {
			kind: "description",
			prompt: `Description for ${preset.name}`,
			input,
			targetName: preset.name,
		};
	}

	#startDelete(): void {
		const preset = this.#currentPreset();
		if (!preset) {
			this.#setStatus("Choose a preset to delete.", "warning");
			return;
		}
		this.#confirmMode = {
			prompt: `Delete preset "${preset.name}"?`,
			detail: "Press Enter to confirm or Esc to keep it.",
			onConfirm: () => {
				this.#presetsConfig.deletePreset(preset.name);
				this.#refreshPresets();
				this.#setStatus(`Deleted ${preset.name}.`, "success");
			},
		};
	}

	async #submitInputMode(rawValue: string): Promise<void> {
		const mode = this.#inputMode;
		if (!mode) return;
		const value = rawValue.trim();

		try {
			switch (mode.kind) {
				case "create": {
					if (!value) {
						mode.error = "Preset name is required.";
						return;
					}
					const existing = this.#presetsConfig.getPreset(value);
					if (existing) {
						this.#inputMode = null;
						this.#confirmMode = {
							prompt: `Overwrite preset "${value}"?`,
							detail: "The existing description is preserved unless you edit it later.",
							onConfirm: () => {
								this.#saveCurrentAsPreset(value, existing.description, existing.createdAt);
							},
						};
						return;
					}
					this.#saveCurrentAsPreset(value);
					this.#inputMode = null;
					return;
				}
				case "rename": {
					const currentName = mode.targetName;
					if (!currentName) {
						this.#inputMode = null;
						return;
					}
					if (!value) {
						mode.error = "Preset name is required.";
						return;
					}
					if (value !== currentName && this.#presetsConfig.getPreset(value)) {
						mode.error = `A preset named "${value}" already exists.`;
						return;
					}
					if (value === currentName) {
						this.#inputMode = null;
						return;
					}
					this.#presetsConfig.renamePreset(currentName, value);
					this.#refreshPresets(value);
					this.#setStatus(`Renamed ${currentName} to ${value}.`, "success");
					this.#inputMode = null;
					return;
				}
				case "description": {
					const presetName = mode.targetName;
					if (!presetName) {
						this.#inputMode = null;
						return;
					}
					const snapshot = this.#presetsConfig.getPreset(presetName);
					if (!snapshot) {
						this.#inputMode = null;
						this.#setStatus(`Preset ${presetName} no longer exists.`, "error");
						this.#refreshPresets();
						return;
					}
					this.#presetsConfig.savePreset(presetName, {
						...snapshot,
						description: value || undefined,
						updatedAt: this.#now(),
					});
					this.#refreshPresets(presetName);
					this.#setStatus(`Updated description for ${presetName}.`, "success");
					this.#inputMode = null;
					return;
				}
			}
		} catch (error) {
			mode.error = error instanceof Error ? error.message : String(error);
		}
	}

	async #runConfirm(mode: ConfirmMode): Promise<void> {
		try {
			await mode.onConfirm();
		} catch (error) {
			this.#setStatus(error instanceof Error ? error.message : String(error), "error");
		}
	}

	async #applySelectedPreset(): Promise<void> {
		const preset = this.#currentPreset();
		if (!preset) {
			this.#setStatus("No preset selected.", "warning");
			return;
		}
		try {
			await this.#presetsConfig.applyPreset(preset.name);
			this.#refreshPresets(preset.name);
			await this.#onApply(preset.name);
		} catch (error) {
			this.#setStatus(error instanceof Error ? error.message : String(error), "error");
		}
	}

	#saveCurrentAsPreset(name: string, description?: string, createdAt?: string): void {
		const timestamp = this.#now();
		this.#presetsConfig.savePreset(name, {
			...this.#presetsConfig.captureCurrentConfig(),
			description,
			createdAt: createdAt ?? timestamp,
			updatedAt: timestamp,
		});
		this.#refreshPresets(name);
		this.#setStatus(`Saved ${name}.`, "success");
	}

	#refreshPresets(preferredName?: string): void {
		this.#allPresets = this.#presetsConfig.listPresets();
		let nextVisible = this.#filterPresets(this.#searchInput.getValue().trim());
		if (
			!this.#filterMode &&
			preferredName &&
			nextVisible.every(preset => preset.name !== preferredName) &&
			this.#searchInput.getValue().trim()
		) {
			this.#searchInput.setValue("");
			nextVisible = [...this.#allPresets];
		}
		this.#visiblePresets = nextVisible;
		const nextName = preferredName ?? this.#currentPresetName();
		if (nextName) {
			const preferredIndex = this.#visiblePresets.findIndex(preset => preset.name === nextName);
			if (preferredIndex >= 0) {
				this.#selectedIndex = preferredIndex;
			} else {
				this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#visiblePresets.length - 1));
			}
		} else {
			this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#visiblePresets.length - 1));
		}
	}

	#filterPresets(query: string): PresetListItem[] {
		if (!query) {
			return [...this.#allPresets];
		}
		return fuzzyFilter(this.#allPresets, query, preset => `${preset.name} ${preset.description ?? ""}`);
	}

	#moveSelection(delta: number): void {
		if (this.#visiblePresets.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex + delta, this.#visiblePresets.length - 1));
	}

	#currentPreset(): PresetListItem | undefined {
		return this.#visiblePresets[this.#selectedIndex];
	}

	#currentPresetName(): string | undefined {
		return this.#visiblePresets[this.#selectedIndex]?.name;
	}

	#renderStatusRows(innerWidth: number): string[] {
		if (!this.#statusMessage) return [];
		return [this.#frameRow(theme.fg(this.#statusTone, this.#statusMessage), innerWidth)];
	}

	#renderPromptRows(innerWidth: number): string[] {
		if (this.#inputMode) {
			const rows = [
				this.#frameRow(theme.fg("accent", this.#inputMode.prompt), innerWidth),
				this.#frameRow(this.#inputMode.input.render(innerWidth)[0] ?? "> ", innerWidth),
				this.#frameRow(theme.fg("dim", "Enter save  Esc cancel"), innerWidth),
			];
			if (this.#inputMode.error) {
				rows.splice(2, 0, this.#frameRow(theme.fg("error", this.#inputMode.error), innerWidth));
			}
			return rows;
		}
		if (this.#confirmMode) {
			const rows = [this.#frameRow(theme.fg("warning", this.#confirmMode.prompt), innerWidth)];
			if (this.#confirmMode.detail) {
				rows.push(this.#frameRow(theme.fg("dim", this.#confirmMode.detail), innerWidth));
			}
			rows.push(this.#frameRow(theme.fg("dim", "Enter confirm  Esc cancel"), innerWidth));
			return rows;
		}
		return [];
	}

	#renderPresetRows(innerWidth: number): string[] {
		if (this.#visiblePresets.length === 0) {
			return [
				this.#frameRow(
					theme.fg("muted", "No presets match. Press n to save the current configuration."),
					innerWidth,
				),
			];
		}

		this.#ensureVisible();
		const rows: string[] = [];
		if (this.#scrollOffset > 0) {
			rows.push(this.#frameRow(theme.fg("dim", "▲ more"), innerWidth));
		}

		const endIndex = Math.min(this.#scrollOffset + MAX_VISIBLE_PRESETS, this.#visiblePresets.length);
		const activePreset = this.#presetsConfig.getActivePreset();
		for (let index = this.#scrollOffset; index < endIndex; index += 1) {
			const preset = this.#visiblePresets[index];
			if (!preset) continue;
			const selected = index === this.#selectedIndex;
			const cursor = selected ? `${theme.fg("accent", `${theme.nav.cursor} `)}` : "  ";
			const active = preset.name === activePreset ? theme.fg("accent", "●") : theme.fg("dim", "○");
			const name = selected ? theme.bold(theme.fg("accent", preset.name)) : preset.name;
			const summary = preset.description?.trim() || "No description";
			const meta = `${summary} ${theme.sep.dot} Updated: ${formatPresetDate(preset.updatedAt)}`;
			rows.push(this.#frameRow(`${cursor}${active} ${name}`, innerWidth));
			rows.push(this.#frameRow(theme.fg("dim", `  ${meta}`), innerWidth));
		}

		if (endIndex < this.#visiblePresets.length) {
			rows.push(this.#frameRow(theme.fg("dim", "▼ more"), innerWidth));
		}

		return rows;
	}

	#ensureVisible(): void {
		if (this.#selectedIndex < this.#scrollOffset) {
			this.#scrollOffset = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#scrollOffset + MAX_VISIBLE_PRESETS) {
			this.#scrollOffset = this.#selectedIndex - MAX_VISIBLE_PRESETS + 1;
		}
	}

	#syncInputFocus(): void {
		const searchFocused = !this.#inputMode && !this.#confirmMode && this.#filterMode;
		this.#searchInput.focused = searchFocused;
		if (this.#inputMode) {
			this.#inputMode.input.focused = true;
		}
	}

	#setStatus(message: string, tone: StatusTone): void {
		this.#statusMessage = message;
		this.#statusTone = tone;
	}

	#frameTop(innerWidth: number): string {
		const border = theme.fg("border", theme.boxSharp.horizontal.repeat(innerWidth));
		return `${theme.fg("border", theme.boxSharp.topLeft)}${border}${theme.fg("border", theme.boxSharp.topRight)}`;
	}

	#frameBottom(innerWidth: number): string {
		const border = theme.fg("border", theme.boxSharp.horizontal.repeat(innerWidth));
		return `${theme.fg("border", theme.boxSharp.bottomLeft)}${border}${theme.fg("border", theme.boxSharp.bottomRight)}`;
	}

	#frameRow(content: string, innerWidth: number): string {
		// Focused inputs already render to the requested width. Re-truncating them here
		// would count the hidden cursor marker as visible text and collapse the frame.
		const fitted = hasCursorMarker(content) ? content : truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(fitted));
		const side = theme.fg("border", theme.boxSharp.vertical);
		return `${side}${fitted}${padding(remaining)}${side}`;
	}
}

function formatPresetDate(value: string): string {
	if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toISOString().slice(0, 10);
}

function seedInputValue(input: Input, value: string): void {
	for (const ch of value) {
		input.handleInput(ch);
	}
}

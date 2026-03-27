import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";

export interface PresetBarOptions {
	activePreset: string | null;
	isModified: boolean;
	onSave: () => void;
	onSaveAs: () => void;
	onSwitch: () => void;
	onRevert: () => void;
}

/**
 * Compact action bar that summarizes the current preset state.
 *
 * The bar stays intentionally stateless with respect to persistence — callers own
 * save/apply behavior and pass the latest preset state in via update().
 */
export class PresetBar implements Component {
	#activePreset: string | null;
	#isModified: boolean;
	readonly #onSave: () => void;
	readonly #onSaveAs: () => void;
	readonly #onSwitch: () => void;
	readonly #onRevert: () => void;

	constructor(options: PresetBarOptions) {
		this.#activePreset = options.activePreset;
		this.#isModified = options.isModified;
		this.#onSave = options.onSave;
		this.#onSaveAs = options.onSaveAs;
		this.#onSwitch = options.onSwitch;
		this.#onRevert = options.onRevert;
	}

	update(options: Pick<PresetBarOptions, "activePreset" | "isModified">): void {
		this.#activePreset = options.activePreset;
		this.#isModified = options.isModified;
	}

	invalidate(): void {
		// Stateless render; nothing to invalidate.
	}

	render(width: number): string[] {
		const presetLabel = this.#activePreset
			? `${theme.fg("accent", this.#activePreset)}${this.#isModified ? theme.fg("warning", " *") : ""}`
			: theme.fg("dim", "Custom");
		const actions = this.#renderActions().join(" ");
		const line = ` ${theme.fg("dim", "Preset:")} ${presetLabel}  ${actions}`;
		return [truncateToWidth(line, width)];
	}

	handleInput(data: string): void {
		if (data === "s" || data === "S") {
			if (this.#activePreset === null) {
				this.#onSaveAs();
			} else if (this.#isModified) {
				this.#onSave();
			}
			return;
		}

		if (data === "p" || data === "P") {
			this.#onSwitch();
			return;
		}

		if ((data === "r" || data === "R") && this.#activePreset !== null && this.#isModified) {
			this.#onRevert();
		}
	}

	#renderActions(): string[] {
		if (this.#activePreset === null) {
			return [theme.fg("accent", "[Save as...]"), theme.fg("accent", "[Switch]")];
		}

		return [
			this.#isModified ? theme.fg("accent", "[Save]") : theme.fg("dim", "[Save]"),
			theme.fg("accent", "[Switch]"),
			this.#isModified ? theme.fg("warning", "[Revert]") : theme.fg("dim", "[Revert]"),
		];
	}
}

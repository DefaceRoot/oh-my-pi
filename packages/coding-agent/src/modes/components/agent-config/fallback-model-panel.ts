import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

const MAX_VISIBLE = 12;

export interface FallbackModelPanelOptions {
	currentModelLabel: string;
	currentModelSourceLabel: string;
	currentFallbackLabel: string;
	overrideLabel: string;
	globalDefaultLabel: string;
	clearOptionLabel: string;
	availableModelKeys: string[];
	selectedFallbackKey: string | null;
	callbacks: FallbackModelPanelCallbacks;
}

export interface FallbackModelPanelCallbacks {
	onSelectFallback: (modelKey: string | null) => void;
	onClose?: () => void;
}

export class FallbackModelPanel implements Component {
	#currentModelLabel = "(not configured)";
	#currentModelSourceLabel = "no assignment";
	#currentFallbackLabel = "none";
	#overrideLabel = "no override";
	#globalDefaultLabel = "none";
	#clearOptionLabel = "No fallback";
	#availableModelKeys: string[] = [];
	#selectedFallbackKey: string | null = null;
	#selectedIndex = 0;
	#scrollOffset = 0;
	readonly #callbacks: FallbackModelPanelCallbacks;

	constructor(options: FallbackModelPanelOptions) {
		this.#callbacks = options.callbacks;
		this.update(options);
	}

	update(options: Omit<FallbackModelPanelOptions, "callbacks">): void {
		const previousKey = this.#optionKeyAt(this.#selectedIndex);
		this.#currentModelLabel = options.currentModelLabel;
		this.#currentModelSourceLabel = options.currentModelSourceLabel;
		this.#currentFallbackLabel = options.currentFallbackLabel;
		this.#overrideLabel = options.overrideLabel;
		this.#globalDefaultLabel = options.globalDefaultLabel;
		this.#clearOptionLabel = options.clearOptionLabel;
		this.#availableModelKeys = options.availableModelKeys;
		this.#selectedFallbackKey = options.selectedFallbackKey;

		const nextIndex = this.#findOptionIndex(previousKey ?? options.selectedFallbackKey);
		this.#selectedIndex = Math.max(0, Math.min(nextIndex, this.#optionCount - 1));
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [
			truncateToWidth(theme.fg("dim", "  Current model:"), width),
			truncateToWidth(
				`  ${theme.bold(this.#currentModelLabel)} ${theme.fg("dim", `(${this.#currentModelSourceLabel})`)}`,
				width,
			),
			"",
			truncateToWidth(theme.fg("dim", `  Current: ${this.#currentFallbackLabel}`), width),
			truncateToWidth(theme.fg("dim", `  Override: ${this.#overrideLabel}`), width),
			truncateToWidth(theme.fg("dim", `  Global default: ${this.#globalDefaultLabel}`), width),
			"",
			truncateToWidth(
				` ${theme.fg("success", "[✓]")}=agent override  ${theme.fg("dim", "[~]")}=inherit  ${theme.fg("dim", "[ ]")}=available   space:select`,
				width,
			),
			"",
		];

		this.#ensureVisible(this.#selectedIndex);
		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIndex = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#optionCount);
		for (let index = this.#scrollOffset; index < endIndex; index += 1) {
			const optionKey = this.#optionKeyAt(index);
			const label = index === 0 ? this.#clearOptionLabel : (optionKey ?? "");
			const tag = this.#renderStateTag(index, optionKey);
			const isSelected = index === this.#selectedIndex;
			const nameWidth = Math.max(4, width - visibleWidth(tag) - 2);
			let line = ` ${tag} ${truncateToWidth(label, nameWidth)}`;
			if (isSelected) {
				line = theme.bg("selectedBg", truncateToWidth(line, width));
			}
			lines.push(truncateToWidth(line, width));
		}

		if (endIndex < this.#optionCount) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▼ more"), width));
		}

		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", "  ↑/↓:navigate  space:select  esc:close"), width));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.min(this.#optionCount - 1, this.#selectedIndex + 1);
			return;
		}
		if (data === " " || matchesKey(data, "space")) {
			this.#callbacks.onSelectFallback(this.#optionKeyAt(this.#selectedIndex));
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
		}
	}

	get #optionCount(): number {
		return this.#availableModelKeys.length + 1;
	}

	#optionKeyAt(index: number): string | null {
		if (index <= 0) return null;
		return this.#availableModelKeys[index - 1] ?? null;
	}

	#findOptionIndex(optionKey: string | null | undefined): number {
		if (!optionKey) return 0;
		const modelIndex = this.#availableModelKeys.indexOf(optionKey);
		return modelIndex >= 0 ? modelIndex + 1 : 0;
	}

	#renderStateTag(index: number, optionKey: string | null): string {
		if (index === 0) {
			return this.#selectedFallbackKey === null
				? this.#globalDefaultLabel === "none"
					? theme.fg("success", "[✓]")
					: theme.fg("dim", "[~]")
				: theme.fg("dim", "[ ]");
		}
		return optionKey === this.#selectedFallbackKey ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
	}

	#ensureVisible(index: number): void {
		if (index < this.#scrollOffset) {
			this.#scrollOffset = index;
		} else if (index >= this.#scrollOffset + MAX_VISIBLE) {
			this.#scrollOffset = index - MAX_VISIBLE + 1;
		}
	}
}

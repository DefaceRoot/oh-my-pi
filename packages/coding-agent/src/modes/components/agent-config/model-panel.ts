import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getThinkingLevelMetadata } from "../../../thinking";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

const MAX_VISIBLE = 12;

export interface ModelPanelOptions {
	currentModelLabel: string;
	currentModelSourceLabel: string;
	/** Canonical key (provider/id) for the role's resolved primary model, used to mark the active entry. */
	primaryModelKey: string;
	currentFallbackLabel: string;
	overrideLabel: string;
	globalDefaultLabel: string;
	clearOptionLabel: string;
	availableModelKeys: string[];
	selectedFallbackKey: string | null;
	/** Thinking level for the primary model, undefined = no override. */
	primaryThinkingLevel?: ThinkingLevel;
	/** Thinking level for the fallback model, undefined = no override. */
	fallbackThinkingLevel?: ThinkingLevel;
	callbacks: ModelPanelCallbacks;
}

export interface ModelPanelCallbacks {
	/** Called when the user selects a new primary model for the current role. */
	onSelectPrimary: (modelKey: string) => void;
	/** Called when the user selects a fallback model (null = clear the override). */
	onSelectFallback: (modelKey: string | null) => void;
	/** Cycle the thinking level for the primary model. */
	onCyclePrimaryThinkingLevel?: () => void;
	/** Cycle the thinking level for the fallback model. */
	onCycleFallbackThinkingLevel?: () => void;
	onClose?: () => void;
}

/**
 * TUI panel shown under the "Model" tab of the agent config modal.
 *
 * Two editing targets, toggled with `t`:
 *   Primary  — the role's assigned main model (written to config.yml)
 *   Fallback — the role's fallback model override (written to roles.yml)
 *
 * Navigation is unified: the model list always shows models for the active
 * target.  Space selects the highlighted model for that target.
 */
export class ModelPanel implements Component {
	#currentModelLabel = "(not configured)";
	#currentModelSourceLabel = "no assignment";
	#primaryModelKey = "";
	#currentFallbackLabel = "none";
	#overrideLabel = "no override";
	#globalDefaultLabel = "none";
	#clearOptionLabel = "No fallback";
	#availableModelKeys: string[] = [];
	#selectedFallbackKey: string | null = null;
	#primaryThinkingLevel: ThinkingLevel | undefined = undefined;
	#fallbackThinkingLevel: ThinkingLevel | undefined = undefined;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#activeTarget: "primary" | "fallback" = "fallback";
	readonly #callbacks: ModelPanelCallbacks;

	constructor(options: ModelPanelOptions) {
		this.#callbacks = options.callbacks;
		this.update(options);
	}

	update(options: Omit<ModelPanelOptions, "callbacks">): void {
		const previousKey = this.#optionKeyAt(this.#selectedIndex);
		this.#currentModelLabel = options.currentModelLabel;
		this.#currentModelSourceLabel = options.currentModelSourceLabel;
		this.#primaryModelKey = options.primaryModelKey;
		this.#currentFallbackLabel = options.currentFallbackLabel;
		this.#overrideLabel = options.overrideLabel;
		this.#globalDefaultLabel = options.globalDefaultLabel;
		this.#clearOptionLabel = options.clearOptionLabel;
		this.#availableModelKeys = options.availableModelKeys;
		this.#selectedFallbackKey = options.selectedFallbackKey;
		this.#primaryThinkingLevel = options.primaryThinkingLevel;
		this.#fallbackThinkingLevel = options.fallbackThinkingLevel;

		// When no previous key is known, initialise the cursor at the current
		// selection for the active target so the highlighted entry is visible.
		const initialKey = this.#activeTarget === "primary" ? options.primaryModelKey : options.selectedFallbackKey;
		const nextIndex = this.#findOptionIndex(previousKey ?? initialKey);
		this.#selectedIndex = Math.max(0, Math.min(nextIndex, this.#optionCount - 1));
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const isPrimary = this.#activeTarget === "primary";
		const primaryLabel = isPrimary ? `${theme.fg("success", "▶")} Primary (editing)` : theme.fg("dim", "  Primary");
		const fallbackLabel = isPrimary
			? theme.fg("dim", "  Fallback")
			: `${theme.fg("success", "▶")} Fallback (editing)`;

		const primaryThinkingStr =
			this.#primaryThinkingLevel !== undefined
				? theme.fg("dim", ` [thinking: ${getThinkingLevelMetadata(this.#primaryThinkingLevel).label}]`)
				: theme.fg("dim", " [thinking: —]");
		const fallbackThinkingStr =
			this.#fallbackThinkingLevel !== undefined
				? theme.fg("dim", ` [thinking: ${getThinkingLevelMetadata(this.#fallbackThinkingLevel).label}]`)
				: theme.fg("dim", " [thinking: —]");
		const lines: string[] = [
			truncateToWidth(`  ${primaryLabel}${primaryThinkingStr}`, width),
			truncateToWidth(
				`  ${theme.bold(this.#currentModelLabel)} ${theme.fg("dim", `(${this.#currentModelSourceLabel})`)}`,
				width,
			),
			"",
			truncateToWidth(`  ${fallbackLabel}${fallbackThinkingStr}`, width),
			truncateToWidth(theme.fg("dim", `  ${this.#currentFallbackLabel}`), width),
			"",
		];

		// Show override/global-default info only for fallback editing to keep the
		// primary section uncluttered.
		if (!isPrimary) {
			lines.push(
				truncateToWidth(theme.fg("dim", `  Override: ${this.#overrideLabel}`), width),
				truncateToWidth(theme.fg("dim", `  Global default: ${this.#globalDefaultLabel}`), width),
				"",
			);
		}

		lines.push(
			truncateToWidth(
				` ${theme.fg("success", "[✓]")}=selected  ${theme.fg("dim", "[~]")}=inherit  ${theme.fg("dim", "[ ]")}=available   space:select`,
				width,
			),
			"",
		);

		this.#ensureVisible(this.#selectedIndex);
		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIndex = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#optionCount);
		for (let index = this.#scrollOffset; index < endIndex; index += 1) {
			const optionKey = this.#optionKeyAt(index);
			const label = this.#getOptionLabel(index, optionKey);
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
		lines.push(
			truncateToWidth(theme.fg("dim", "  ↑/↓:navigate  space:select  t:toggle  l:cycle thinking  esc:close"), width),
		);
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
			const key = this.#optionKeyAt(this.#selectedIndex);
			if (this.#activeTarget === "primary") {
				// key is always non-null in primary mode (no "clear" entry exists).
				if (key !== null) {
					this.#callbacks.onSelectPrimary(key);
				}
			} else {
				this.#callbacks.onSelectFallback(key);
			}
			return;
		}
		if (data === "t" || data === "T") {
			this.#activeTarget = this.#activeTarget === "primary" ? "fallback" : "primary";
			// Jump cursor to the current selection for the newly active target.
			const currentKey = this.#activeTarget === "primary" ? this.#primaryModelKey : this.#selectedFallbackKey;
			const jumpIndex = this.#findOptionIndex(currentKey);
			this.#selectedIndex = Math.max(0, Math.min(jumpIndex, this.#optionCount - 1));
			return;
		}
		if (data === "l" || data === "L") {
			if (this.#activeTarget === "primary") {
				this.#callbacks.onCyclePrimaryThinkingLevel?.();
			} else {
				this.#callbacks.onCycleFallbackThinkingLevel?.();
			}
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
		}
	}

	get #optionCount(): number {
		if (this.#activeTarget === "primary") {
			// No "clear" entry for primary — every model is a valid explicit choice.
			return this.#availableModelKeys.length;
		}
		// Fallback: index 0 = "No fallback" (null); 1+ = model keys.
		return this.#availableModelKeys.length + 1;
	}

	#optionKeyAt(index: number): string | null {
		if (this.#activeTarget === "primary") {
			return this.#availableModelKeys[index] ?? null;
		}
		// Fallback mode: index 0 = null (clear override), 1+ = model keys.
		if (index <= 0) return null;
		return this.#availableModelKeys[index - 1] ?? null;
	}

	#getOptionLabel(index: number, optionKey: string | null): string {
		if (this.#activeTarget === "fallback" && index === 0) {
			return this.#clearOptionLabel;
		}
		return optionKey ?? "";
	}

	#findOptionIndex(optionKey: string | null | undefined): number {
		if (!optionKey) return 0;
		const modelIndex = this.#availableModelKeys.indexOf(optionKey);
		if (this.#activeTarget === "primary") {
			return modelIndex >= 0 ? modelIndex : 0;
		}
		// Fallback: offset by 1 to account for the null entry at index 0.
		return modelIndex >= 0 ? modelIndex + 1 : 0;
	}

	#renderStateTag(index: number, optionKey: string | null): string {
		if (this.#activeTarget === "primary") {
			if (optionKey === null) return theme.fg("dim", "[ ]");
			return optionKey === this.#primaryModelKey ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
		}

		// Fallback mode: index 0 is the "clear" entry; 1+ are model keys.
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

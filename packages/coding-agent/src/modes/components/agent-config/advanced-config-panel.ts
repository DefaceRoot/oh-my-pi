import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Component, extractPrintableText, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AdvancedConfig } from "../../../config/roles-config";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../../../thinking";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

export type AdvancedCompactionStrategy = "context-full" | "handoff" | "off";

type AdvancedFieldId = keyof AdvancedConfigPanelState;
type NumericFieldId = "maxRecursionDepth" | "temperature";

type AdvancedConfigPanelState = {
	thinkingLevel?: ThinkingLevel;
	maxRecursionDepth?: number;
	compactionStrategy?: AdvancedCompactionStrategy;
	temperature?: number;
};

export interface AdvancedConfigPanelGlobalValues {
	thinkingLevel?: ThinkingLevel;
	maxRecursionDepth: number;
	compactionStrategy: AdvancedCompactionStrategy;
	temperature: number;
}

export interface AdvancedConfigPanelCallbacks {
	onConfigChange: (config: AdvancedConfig | null) => void;
	onClose?: () => void;
}

export interface AdvancedConfigPanelOptions {
	advancedConfig: AdvancedConfig | null;
	availableThinkingLevels?: readonly ThinkingLevel[];
	globalValues: AdvancedConfigPanelGlobalValues;
	callbacks: AdvancedConfigPanelCallbacks;
}

const FIELD_LABELS: Record<AdvancedFieldId, string> = {
	thinkingLevel: "Thinking Level",
	maxRecursionDepth: "Max Task Recursion",
	compactionStrategy: "Compaction Strategy",
	temperature: "Temperature",
};

const FIELD_ORDER: AdvancedFieldId[] = ["thinkingLevel", "maxRecursionDepth", "compactionStrategy", "temperature"];
const VALID_COMPACTION_STRATEGIES = new Set<AdvancedCompactionStrategy>(["context-full", "handoff", "off"]);
const DEFAULT_THINKING_LEVELS = [
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
	ThinkingLevel.XHigh,
] as const;

/**
 * Advanced configuration editor for per-role or per-subagent overrides.
 *
 * Each field can either inherit the current global settings value or store an
 * explicit override. Enum fields cycle in-place; numeric fields open a simple
 * inline editor so later modal integration does not need extra input plumbing.
 */
export class AdvancedConfigPanel implements Component {
	#config: AdvancedConfigPanelState;
	#globalValues: AdvancedConfigPanelGlobalValues;
	#thinkingOptions: ThinkingLevel[];
	readonly #callbacks: AdvancedConfigPanelCallbacks;
	#selectedIndex = 0;
	#editingField: NumericFieldId | null = null;
	#draftValue = "";
	#errorMessage: string | null = null;

	constructor(options: AdvancedConfigPanelOptions) {
		this.#config = normalizeConfig(options.advancedConfig);
		this.#globalValues = { ...options.globalValues };
		this.#thinkingOptions = buildThinkingOptions(options.availableThinkingLevels);
		this.#callbacks = options.callbacks;
	}

	update(options: Omit<AdvancedConfigPanelOptions, "callbacks">): void {
		this.#config = normalizeConfig(options.advancedConfig);
		this.#globalValues = { ...options.globalValues };
		this.#thinkingOptions = buildThinkingOptions(options.availableThinkingLevels);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, FIELD_ORDER.length - 1));
		this.#editingField = null;
		this.#draftValue = "";
		this.#errorMessage = null;
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(
			truncateToWidth(theme.fg("dim", "  Global = use current session defaults · r:reset selected field"), width),
		);
		lines.push("");

		const labelWidth = Math.min(24, Math.max(...FIELD_ORDER.map(fieldId => visibleWidth(FIELD_LABELS[fieldId]))));

		for (let i = 0; i < FIELD_ORDER.length; i++) {
			const fieldId = FIELD_ORDER[i];
			if (!fieldId) continue;
			lines.push(this.#renderRow(fieldId, i === this.#selectedIndex, labelWidth, width));
		}

		lines.push("");
		if (this.#editingField) {
			lines.push(truncateToWidth(theme.fg("dim", "  Type a value, Enter to save, Esc to cancel"), width));
			const prompt = `  Editing ${FIELD_LABELS[this.#editingField]}: ${this.#draftValue || theme.fg("dim", "(empty)")}`;
			lines.push(truncateToWidth(prompt, width));
		} else {
			lines.push(
				truncateToWidth(theme.fg("dim", "  ↑/↓ select  space:cycle enums  enter:edit numbers  esc:close"), width),
			);
		}

		if (this.#errorMessage) {
			lines.push(truncateToWidth(theme.fg("error", `  ${this.#errorMessage}`), width));
		}

		return lines;
	}

	handleInput(data: string): void {
		if (this.#editingField) {
			this.#handleEditInput(data);
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#errorMessage = null;
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.min(FIELD_ORDER.length - 1, this.#selectedIndex + 1);
			this.#errorMessage = null;
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
			return;
		}

		const selectedField = FIELD_ORDER[this.#selectedIndex];
		if (!selectedField) return;

		if (data.toLowerCase() === "r") {
			this.#resetField(selectedField);
			return;
		}

		if (selectedField === "thinkingLevel" || selectedField === "compactionStrategy") {
			if (
				data === " " ||
				matchesKey(data, "space") ||
				matchesKey(data, "left") ||
				matchesKey(data, "right") ||
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				data === "\n"
			) {
				this.#cycleField(selectedField);
			}
			return;
		}

		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#beginEdit(selectedField);
		}
	}

	#renderRow(fieldId: AdvancedFieldId, isSelected: boolean, labelWidth: number, width: number): string {
		const isEditing = this.#editingField === fieldId;
		const labelBase = FIELD_LABELS[fieldId];
		const labelText = `${labelBase}${" ".repeat(Math.max(0, labelWidth - visibleWidth(labelBase)))}`;
		const styledLabel = isSelected ? theme.fg("accent", theme.bold(labelText)) : labelText;
		const valueText = isEditing ? this.#renderDraftValue(fieldId) : this.#renderFieldValue(fieldId);
		let line = ` ${styledLabel}  ${valueText}`;
		line = truncateToWidth(line, width);
		if (isSelected) {
			return theme.bg("selectedBg", line);
		}
		return line;
	}

	#renderFieldValue(fieldId: AdvancedFieldId): string {
		switch (fieldId) {
			case "thinkingLevel": {
				const explicit = this.#config.thinkingLevel;
				if (explicit !== undefined) {
					return formatThinkingLevel(explicit);
				}
				return formatGlobalValue(formatThinkingLevel(this.#globalValues.thinkingLevel));
			}
			case "maxRecursionDepth": {
				const explicit = this.#config.maxRecursionDepth;
				if (explicit !== undefined) {
					return formatRecursionDepth(explicit);
				}
				return formatGlobalValue(formatRecursionDepth(this.#globalValues.maxRecursionDepth));
			}
			case "compactionStrategy": {
				const explicit = this.#config.compactionStrategy;
				if (explicit !== undefined) {
					return explicit;
				}
				return formatGlobalValue(this.#globalValues.compactionStrategy);
			}
			case "temperature": {
				const explicit = this.#config.temperature;
				if (explicit !== undefined) {
					return formatTemperature(explicit);
				}
				return formatGlobalValue(formatTemperature(this.#globalValues.temperature));
			}
		}
	}

	#renderDraftValue(fieldId: AdvancedFieldId): string {
		if (fieldId === "thinkingLevel" || fieldId === "compactionStrategy") {
			return this.#renderFieldValue(fieldId);
		}
		const placeholder =
			fieldId === "maxRecursionDepth"
				? formatRecursionDepth(this.#globalValues.maxRecursionDepth)
				: formatTemperature(this.#globalValues.temperature);
		const draft = this.#draftValue.length > 0 ? this.#draftValue : theme.fg("dim", placeholder);
		return `${draft}${theme.fg("accent", " ← editing")}`;
	}

	#cycleField(fieldId: "thinkingLevel" | "compactionStrategy"): void {
		this.#errorMessage = null;
		if (fieldId === "thinkingLevel") {
			const values: Array<ThinkingLevel | undefined> = [undefined, ThinkingLevel.Off, ...this.#thinkingOptions];
			const nextValue = cycleValue(values, this.#config.thinkingLevel);
			this.#config.thinkingLevel = nextValue;
			this.#emitChange();
			return;
		}

		const values: Array<AdvancedCompactionStrategy | undefined> = [undefined, "context-full", "handoff", "off"];
		this.#config.compactionStrategy = cycleValue(values, this.#config.compactionStrategy);
		this.#emitChange();
	}

	#beginEdit(fieldId: AdvancedFieldId): void {
		if (fieldId !== "maxRecursionDepth" && fieldId !== "temperature") return;
		this.#editingField = fieldId;
		this.#draftValue =
			fieldId === "maxRecursionDepth"
				? (this.#config.maxRecursionDepth?.toString() ?? "")
				: (this.#config.temperature?.toString() ?? "");
		this.#errorMessage = null;
	}

	#handleEditInput(data: string): void {
		const fieldId = this.#editingField;
		if (!fieldId) return;

		if (matchesAppInterrupt(data)) {
			this.#editingField = null;
			this.#draftValue = "";
			this.#errorMessage = null;
			return;
		}
		if (data.toLowerCase() === "r") {
			this.#resetField(fieldId);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.#draftValue = this.#draftValue.slice(0, -1);
			this.#errorMessage = null;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#commitEdit(fieldId);
			return;
		}

		const printableText = extractPrintableText(data);
		if (!printableText || printableText.length !== 1) return;
		const charCode = printableText.charCodeAt(0);
		if (charCode <= 32 || charCode >= 127) return;
		this.#draftValue = `${this.#draftValue}${printableText}`;
		this.#errorMessage = null;
	}

	#commitEdit(fieldId: NumericFieldId): void {
		const raw = this.#draftValue.trim();
		if (raw.length === 0) {
			this.#errorMessage = "Enter a value or press r to reset to global.";
			return;
		}

		if (fieldId === "maxRecursionDepth") {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Max Task Recursion must be an integer greater than or equal to -1.";
				return;
			}
			const value = Number(raw);
			if (value < -1) {
				this.#errorMessage = "Max Task Recursion must be an integer greater than or equal to -1.";
				return;
			}
			this.#config.maxRecursionDepth = value;
		} else {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Temperature must be a number greater than or equal to -1.";
				return;
			}
			const value = Number(raw);
			if (!Number.isFinite(value) || value < -1) {
				this.#errorMessage = "Temperature must be a number greater than or equal to -1.";
				return;
			}
			this.#config.temperature = value;
		}

		this.#editingField = null;
		this.#draftValue = "";
		this.#errorMessage = null;
		this.#emitChange();
	}

	#resetField(fieldId: AdvancedFieldId): void {
		this.#errorMessage = null;
		if (fieldId === this.#editingField) {
			this.#editingField = null;
			this.#draftValue = "";
		}
		switch (fieldId) {
			case "thinkingLevel":
				delete this.#config.thinkingLevel;
				break;
			case "maxRecursionDepth":
				delete this.#config.maxRecursionDepth;
				break;
			case "compactionStrategy":
				delete this.#config.compactionStrategy;
				break;
			case "temperature":
				delete this.#config.temperature;
				break;
		}
		this.#emitChange();
	}

	#emitChange(): void {
		this.#callbacks.onConfigChange(toAdvancedConfig(this.#config));
	}
}

function buildThinkingOptions(levels: readonly ThinkingLevel[] | undefined): ThinkingLevel[] {
	const unique = new Set<ThinkingLevel>();
	for (const level of levels ?? DEFAULT_THINKING_LEVELS) {
		if (level === ThinkingLevel.Inherit || level === ThinkingLevel.Off) continue;
		unique.add(level);
	}
	return [...unique];
}

function normalizeConfig(config: AdvancedConfig | null | undefined): AdvancedConfigPanelState {
	const normalized: AdvancedConfigPanelState = {};
	const thinkingLevel = parseThinkingLevel(config?.thinkingLevel ?? undefined);
	if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
		normalized.thinkingLevel = thinkingLevel;
	}
	if (
		typeof config?.maxRecursionDepth === "number" &&
		Number.isInteger(config.maxRecursionDepth) &&
		config.maxRecursionDepth >= -1
	) {
		normalized.maxRecursionDepth = config.maxRecursionDepth;
	}
	if (
		typeof config?.compactionStrategy === "string" &&
		VALID_COMPACTION_STRATEGIES.has(config.compactionStrategy as AdvancedCompactionStrategy)
	) {
		normalized.compactionStrategy = config.compactionStrategy as AdvancedCompactionStrategy;
	}
	if (typeof config?.temperature === "number" && Number.isFinite(config.temperature) && config.temperature >= -1) {
		normalized.temperature = config.temperature;
	}
	return normalized;
}

function toAdvancedConfig(config: AdvancedConfigPanelState): AdvancedConfig | null {
	const next: AdvancedConfig = {};
	if (config.thinkingLevel !== undefined) next.thinkingLevel = config.thinkingLevel;
	if (config.maxRecursionDepth !== undefined) next.maxRecursionDepth = config.maxRecursionDepth;
	if (config.compactionStrategy !== undefined) next.compactionStrategy = config.compactionStrategy;
	if (config.temperature !== undefined) next.temperature = config.temperature;
	return Object.keys(next).length > 0 ? next : null;
}

function cycleValue<T>(values: Array<T | undefined>, current: T | undefined): T | undefined {
	const index = values.indexOf(current);
	const nextIndex = (index + 1 + values.length) % values.length;
	return values[nextIndex];
}

function isCompleteNumericDraft(fieldId: NumericFieldId, draft: string): boolean {
	if (fieldId === "maxRecursionDepth") {
		return /^-?\d+$/.test(draft);
	}
	return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(draft);
}

function formatThinkingLevel(level: ThinkingLevel | undefined): string {
	if (level === undefined) return theme.fg("dim", "unset");
	return getThinkingLevelMetadata(level).label;
}

function formatRecursionDepth(value: number): string {
	return value === -1 ? "unlimited (-1)" : value.toString();
}

function formatTemperature(value: number): string {
	return value === -1 ? "provider default (-1)" : value.toString();
}

function formatGlobalValue(value: string): string {
	return `${theme.fg("dim", "global")} · ${theme.fg("muted", value)}`;
}

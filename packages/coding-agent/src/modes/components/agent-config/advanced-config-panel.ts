import { getTemperatureBounds } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Component, extractPrintableText, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AdvancedConfig } from "../../../config/roles-config";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../../../thinking";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

export type AdvancedCompactionStrategy = "context-full" | "handoff" | "off";

type AdvancedFieldId = keyof AdvancedConfigPanelState;
type ToggleFieldId = "thinkingLevel" | "compactionStrategy" | "memoriesEnabled";
type NumericFieldId =
	| "maxRecursionDepth"
	| "temperature"
	| "grepContextBefore"
	| "grepContextAfter"
	| "compactionThresholdPercent"
	| "compactionThresholdTokens";

type AdvancedConfigPanelState = {
	thinkingLevel?: ThinkingLevel;
	/** Passthrough: set by the model panel, preserved but not displayed here. */
	primaryThinkingLevel?: ThinkingLevel;
	/** Passthrough: set by the model panel, preserved but not displayed here. */
	fallbackThinkingLevel?: ThinkingLevel;
	maxRecursionDepth?: number;
	compactionStrategy?: AdvancedCompactionStrategy;
	temperature?: number;
	memoriesEnabled?: boolean;
	grepContextBefore?: number;
	grepContextAfter?: number;
	compactionThresholdPercent?: number;
	compactionThresholdTokens?: number;
};

export interface AdvancedConfigPanelGlobalValues {
	thinkingLevel?: ThinkingLevel;
	maxRecursionDepth: number;
	compactionStrategy: AdvancedCompactionStrategy;
	temperature: number;
	memoriesEnabled: boolean;
	grepContextBefore: number;
	grepContextAfter: number;
	compactionThresholdPercent: number;
	compactionThresholdTokens: number;
	/** API type of the currently active model, used for temperature bound validation. */
	modelApi?: string;
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
	memoriesEnabled: "Memories",
	grepContextBefore: "Grep Context Before",
	grepContextAfter: "Grep Context After",
	compactionThresholdPercent: "Compaction Threshold %",
	compactionThresholdTokens: "Compaction Token Limit",
	primaryThinkingLevel: "Primary Thinking",
	fallbackThinkingLevel: "Fallback Thinking",
};

const FIELD_ORDER: AdvancedFieldId[] = [
	"thinkingLevel",
	"maxRecursionDepth",
	"compactionStrategy",
	"compactionThresholdPercent",
	"compactionThresholdTokens",
	"temperature",
	"memoriesEnabled",
	"grepContextBefore",
	"grepContextAfter",
];
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
	#modelApi: string | undefined;
	#thinkingOptions: ThinkingLevel[];
	readonly #callbacks: AdvancedConfigPanelCallbacks;
	#selectedIndex = 0;
	#editingField: NumericFieldId | null = null;
	#draftValue = "";
	#errorMessage: string | null = null;

	constructor(options: AdvancedConfigPanelOptions) {
		this.#config = normalizeConfig(options.advancedConfig);
		this.#globalValues = { ...options.globalValues };
		this.#modelApi = options.globalValues.modelApi;
		this.#thinkingOptions = buildThinkingOptions(options.availableThinkingLevels);
		this.#callbacks = options.callbacks;
	}

	update(options: Omit<AdvancedConfigPanelOptions, "callbacks">): void {
		this.#config = normalizeConfig(options.advancedConfig);
		this.#globalValues = { ...options.globalValues };
		this.#modelApi = options.globalValues.modelApi;
		this.#thinkingOptions = buildThinkingOptions(options.availableThinkingLevels);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, FIELD_ORDER.length - 1));
		this.#editingField = null;
		this.#draftValue = "";
		this.#errorMessage = null;
		// If the model changed and an explicit temperature override is now out of bounds,
		// clear it and emit immediately so the stored config is corrected at the model-
		// switch boundary rather than silently re-emitted on the next unrelated edit.
		const storedTemp = this.#config.temperature;
		if (storedTemp !== undefined && storedTemp !== -1) {
			let isInvalid = false;
			if (this.#modelApi === "openai-codex-responses") {
				isInvalid = true;
			} else {
				const bounds = getTemperatureBounds(this.#modelApi ?? "");
				isInvalid = bounds.applicable && (storedTemp < bounds.min || storedTemp > bounds.max);
			}
			if (isInvalid) {
				this.#config.temperature = undefined;
				this.#emitChange();
			}
		}
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

		if (
			selectedField === "thinkingLevel" ||
			selectedField === "compactionStrategy" ||
			selectedField === "memoriesEnabled"
		) {
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
			case "memoriesEnabled": {
				const explicit = this.#config.memoriesEnabled;
				if (explicit !== undefined) {
					return formatBooleanState(explicit, "enabled", "disabled");
				}
				return formatGlobalValue(formatBooleanState(this.#globalValues.memoriesEnabled, "enabled", "disabled"));
			}
			case "grepContextBefore": {
				const explicit = this.#config.grepContextBefore;
				if (explicit !== undefined) {
					return formatContextLines(explicit);
				}
				return formatGlobalValue(formatContextLines(this.#globalValues.grepContextBefore));
			}
			case "grepContextAfter": {
				const explicit = this.#config.grepContextAfter;
				if (explicit !== undefined) {
					return formatContextLines(explicit);
				}
				return formatGlobalValue(formatContextLines(this.#globalValues.grepContextAfter));
			}
			case "compactionThresholdPercent": {
				const explicit = this.#config.compactionThresholdPercent;
				if (explicit !== undefined) {
					return formatThresholdPercent(explicit);
				}
				return formatGlobalValue(formatThresholdPercent(this.#globalValues.compactionThresholdPercent));
			}
			case "compactionThresholdTokens": {
				const explicit = this.#config.compactionThresholdTokens;
				if (explicit !== undefined) {
					return formatThresholdTokens(explicit);
				}
				return formatGlobalValue(formatThresholdTokens(this.#globalValues.compactionThresholdTokens));
			}
			default:
				// Passthrough fields (primaryThinkingLevel, fallbackThinkingLevel) are not displayed.
				return "";
		}
	}

	#renderDraftValue(fieldId: AdvancedFieldId): string {
		if (!this.#isNumericField(fieldId)) {
			// Toggle and passthrough fields do not have a draft editing mode.
			return this.#renderFieldValue(fieldId);
		}
		const placeholder = this.#getNumericFieldPlaceholder(fieldId);
		const draft = this.#draftValue.length > 0 ? this.#draftValue : theme.fg("dim", placeholder);
		return `${draft}${theme.fg("accent", " ← editing")}`;
	}

	#cycleField(fieldId: ToggleFieldId): void {
		this.#errorMessage = null;
		if (fieldId === "thinkingLevel") {
			const values: Array<ThinkingLevel | undefined> = [undefined, ThinkingLevel.Off, ...this.#thinkingOptions];
			const nextValue = cycleValue(values, this.#config.thinkingLevel);
			this.#config.thinkingLevel = nextValue;
			this.#emitChange();
			return;
		}

		if (fieldId === "compactionStrategy") {
			const values: Array<AdvancedCompactionStrategy | undefined> = [undefined, "context-full", "handoff", "off"];
			this.#config.compactionStrategy = cycleValue(values, this.#config.compactionStrategy);
			this.#emitChange();
			return;
		}

		const values: Array<boolean | undefined> = [undefined, true, false];
		this.#config.memoriesEnabled = cycleValue(values, this.#config.memoriesEnabled);
		this.#emitChange();
	}

	#beginEdit(fieldId: AdvancedFieldId): void {
		if (!this.#isNumericField(fieldId)) return;
		this.#editingField = fieldId;
		this.#draftValue = this.#getNumericFieldValue(fieldId);
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
		} else if (fieldId === "temperature") {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Temperature must be a number ≥ -1 (-1 = provider default).";
				return;
			}
			const value = Number(raw);
			if (!Number.isFinite(value) || value < -1) {
				this.#errorMessage = "Temperature must be a number ≥ -1 (-1 = provider default).";
				return;
			}
			// -1 is the sentinel for "use provider default" — skip bounds check
			if (value !== -1) {
				if (this.#modelApi === "openai-codex-responses") {
					this.#errorMessage =
						"This model does not support temperature adjustment. Use -1 for provider default.";
					return;
				}
				const bounds = getTemperatureBounds(this.#modelApi ?? "");
				if (bounds.applicable && (value < bounds.min || value > bounds.max)) {
					const rangeLabel = this.#modelApi ? ` for ${this.#modelApi}` : "";
					this.#errorMessage = `Temperature ${value} is out of range${rangeLabel}. Valid: ${bounds.min}\u2013${bounds.max} (or -1 for provider default).`;
					return;
				}
			}
			this.#config.temperature = value;
		} else if (fieldId === "compactionThresholdPercent") {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Compaction threshold must be an integer (-1 for default, or a value ≥ 0).";
				return;
			}
			const value = Number(raw);
			if (!Number.isInteger(value) || value < -1) {
				this.#errorMessage = "Compaction threshold must be an integer (-1 for default, or a value ≥ 0).";
				return;
			}
			this.#config.compactionThresholdPercent = value;
		} else if (fieldId === "compactionThresholdTokens") {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Token limit must be an integer (-1 for default, or a positive number).";
				return;
			}
			const value = Number(raw);
			if (!Number.isInteger(value) || value < -1) {
				this.#errorMessage = "Token limit must be an integer (-1 for default, or a positive number).";
				return;
			}
			this.#config.compactionThresholdTokens = value;
		} else {
			if (!isCompleteNumericDraft(fieldId, raw)) {
				this.#errorMessage = "Grep context must be a non-negative integer.";
				return;
			}
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 0) {
				this.#errorMessage = "Grep context must be a non-negative integer.";
				return;
			}
			if (fieldId === "grepContextBefore") this.#config.grepContextBefore = value;
			if (fieldId === "grepContextAfter") this.#config.grepContextAfter = value;
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
			case "memoriesEnabled":
				delete this.#config.memoriesEnabled;
				break;
			case "grepContextBefore":
				delete this.#config.grepContextBefore;
				break;
			case "grepContextAfter":
				delete this.#config.grepContextAfter;
				break;
			case "compactionThresholdPercent":
				delete this.#config.compactionThresholdPercent;
				break;
			case "compactionThresholdTokens":
				delete this.#config.compactionThresholdTokens;
				break;
		}
		this.#emitChange();
	}

	#isNumericField(fieldId: AdvancedFieldId): fieldId is NumericFieldId {
		return (
			fieldId === "maxRecursionDepth" ||
			fieldId === "temperature" ||
			fieldId === "grepContextBefore" ||
			fieldId === "grepContextAfter" ||
			fieldId === "compactionThresholdPercent" ||
			fieldId === "compactionThresholdTokens"
		);
	}

	#getNumericFieldValue(fieldId: NumericFieldId): string {
		switch (fieldId) {
			case "maxRecursionDepth":
				return this.#config.maxRecursionDepth?.toString() ?? "";
			case "temperature":
				return this.#config.temperature?.toString() ?? "";
			case "grepContextBefore":
				return this.#config.grepContextBefore?.toString() ?? "";
			case "grepContextAfter":
				return this.#config.grepContextAfter?.toString() ?? "";
			case "compactionThresholdPercent":
				return this.#config.compactionThresholdPercent?.toString() ?? "";
			case "compactionThresholdTokens":
				return this.#config.compactionThresholdTokens?.toString() ?? "";
		}
	}

	#getNumericFieldPlaceholder(fieldId: NumericFieldId): string {
		switch (fieldId) {
			case "maxRecursionDepth":
				return formatRecursionDepth(this.#globalValues.maxRecursionDepth);
			case "temperature":
				return formatTemperature(this.#globalValues.temperature);
			case "grepContextBefore":
				return formatContextLines(this.#globalValues.grepContextBefore);
			case "grepContextAfter":
				return formatContextLines(this.#globalValues.grepContextAfter);
			case "compactionThresholdPercent":
				return formatThresholdPercent(this.#globalValues.compactionThresholdPercent);
			case "compactionThresholdTokens":
				return formatThresholdTokens(this.#globalValues.compactionThresholdTokens);
		}
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
	const primaryThinkingLevel = parseThinkingLevel(config?.primaryThinkingLevel ?? undefined);
	if (primaryThinkingLevel && primaryThinkingLevel !== ThinkingLevel.Inherit) {
		normalized.primaryThinkingLevel = primaryThinkingLevel;
	}
	const fallbackThinkingLevel = parseThinkingLevel(config?.fallbackThinkingLevel ?? undefined);
	if (fallbackThinkingLevel && fallbackThinkingLevel !== ThinkingLevel.Inherit) {
		normalized.fallbackThinkingLevel = fallbackThinkingLevel;
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
	if (typeof config?.memoriesEnabled === "boolean") {
		normalized.memoriesEnabled = config.memoriesEnabled;
	}
	if (
		typeof config?.grepContextBefore === "number" &&
		Number.isInteger(config.grepContextBefore) &&
		config.grepContextBefore >= 0
	) {
		normalized.grepContextBefore = config.grepContextBefore;
	}
	if (
		typeof config?.grepContextAfter === "number" &&
		Number.isInteger(config.grepContextAfter) &&
		config.grepContextAfter >= 0
	) {
		normalized.grepContextAfter = config.grepContextAfter;
	}
	if (
		typeof config?.compactionThresholdPercent === "number" &&
		Number.isInteger(config.compactionThresholdPercent) &&
		config.compactionThresholdPercent >= -1
	) {
		normalized.compactionThresholdPercent = config.compactionThresholdPercent;
	}
	if (
		typeof config?.compactionThresholdTokens === "number" &&
		Number.isInteger(config.compactionThresholdTokens) &&
		config.compactionThresholdTokens >= -1
	) {
		normalized.compactionThresholdTokens = config.compactionThresholdTokens;
	}
	return normalized;
}

function toAdvancedConfig(config: AdvancedConfigPanelState): AdvancedConfig | null {
	const next: AdvancedConfig = {};
	if (config.thinkingLevel !== undefined) next.thinkingLevel = config.thinkingLevel;
	if (config.primaryThinkingLevel !== undefined) next.primaryThinkingLevel = config.primaryThinkingLevel;
	if (config.fallbackThinkingLevel !== undefined) next.fallbackThinkingLevel = config.fallbackThinkingLevel;
	if (config.maxRecursionDepth !== undefined) next.maxRecursionDepth = config.maxRecursionDepth;
	if (config.compactionStrategy !== undefined) next.compactionStrategy = config.compactionStrategy;
	if (config.temperature !== undefined) next.temperature = config.temperature;
	if (config.memoriesEnabled !== undefined) next.memoriesEnabled = config.memoriesEnabled;
	if (config.grepContextBefore !== undefined) next.grepContextBefore = config.grepContextBefore;
	if (config.grepContextAfter !== undefined) next.grepContextAfter = config.grepContextAfter;
	if (config.compactionThresholdPercent !== undefined)
		next.compactionThresholdPercent = config.compactionThresholdPercent;
	if (config.compactionThresholdTokens !== undefined)
		next.compactionThresholdTokens = config.compactionThresholdTokens;
	return Object.keys(next).length > 0 ? next : null;
}

function cycleValue<T>(values: Array<T | undefined>, current: T | undefined): T | undefined {
	const index = values.indexOf(current);
	const nextIndex = (index + 1 + values.length) % values.length;
	return values[nextIndex];
}

function isCompleteNumericDraft(fieldId: NumericFieldId, draft: string): boolean {
	if (
		fieldId === "maxRecursionDepth" ||
		fieldId === "grepContextBefore" ||
		fieldId === "grepContextAfter" ||
		fieldId === "compactionThresholdPercent" ||
		fieldId === "compactionThresholdTokens"
	) {
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

function formatContextLines(value: number): string {
	return value === 1 ? "1 line" : `${value} lines`;
}

function formatBooleanState(value: boolean, trueLabel: string, falseLabel: string): string {
	return value ? trueLabel : falseLabel;
}

function formatGlobalValue(value: string): string {
	return `${theme.fg("dim", "global")} · ${theme.fg("muted", value)}`;
}

function formatThresholdPercent(value: number): string {
	return value === -1 ? "default (-1)" : `${value}%`;
}

function formatThresholdTokens(value: number): string {
	return value === -1 ? "default (-1)" : value.toString();
}

import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ToolsInheritConfig } from "../../../config/roles-config";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

/** Effective state of a single tool from the perspective of the panel. */
export type ToolState = "enabled" | "disabled" | "inherited" | "added" | "removed" | "blocked";

export type ToolsConfigChange =
	| { tools: string[] }
	| { disabledTools: string[] }
	| { inheritConfig: ToolsInheritConfig }
	| { clearInheritConfig: true };

export interface ToolsConfigPanelCallbacks {
	/** Called when tool config changes. For roles: direct list. For subagents: inherit config or clear. */
	onConfigChange: (config: ToolsConfigChange) => void;
	/** Fired on interrupt/escape. Optional: caller decides whether to close. */
	onClose?: () => void;
}

export interface ToolsConfigPanelOptions {
	/** All known tool names in the system. */
	allTools: string[];
	/** Whether this agent is a subagent (uses inherit pattern). */
	isSubagent: boolean;
	/** For subagents: the current inherit config. */
	inheritConfig?: ToolsInheritConfig;
	/** For roles: the current direct tool list. */
	directTools?: string[];
	/** Resolved effective tool list for the current config. */
	resolvedTools: string[];
	/** Tools inherited from the subagent's base before local add/remove overrides. */
	inheritedTools: string[];
	/** MCP-derived tools enabled by the current server selection before per-tool disables. */
	mcpEnabledTools: string[];
	/** MCP tool names known for this role. */
	mcpTools: string[];
	/** Explicit per-tool opt-outs persisted separately from tool allowlists. */
	disabledTools: string[];
	/**
	 * For config-less subagents: the role to use as the inherit source when bootstrapping
	 * a new ToolsInheritConfig. Without this the emitted config falls back to "default",
	 * potentially changing the effective tool set. Provide the subagent's current inherit
	 * base so the first edit preserves existing resolution semantics.
	 */
	inheritBase?: string;
	/**
	 * Whether this editing session began with a persisted subagent tools config.
	 * Pass this when the parent rehydrates local panel changes and needs to preserve
	 * the original missing-config baseline across update() calls.
	 */
	hasPersistedInheritConfig?: boolean;
	callbacks: ToolsConfigPanelCallbacks;
}

/** Maximum rows to show in the visible window before scrolling. */
const MAX_VISIBLE = 15;

/**
 * Tools tab panel for the Agent Configuration modal.
 *
 * Supports two modes:
 *   Role mode   — direct enable/disable toggles.
 *     [✓] = enabled (green)   [ ] = disabled (dim)
 *
 *   Subagent mode — inherit-add-remove pattern.
 *     [~] = inherited (dim)   [+] = added (green)
 *     [-] = removed (red)     [ ] = not in resolved set, not configured
 *
 * Space cycles the state; up/down navigate; escape closes.
 */
export class ToolsConfigPanel implements Component {
	#allTools: string[];
	#isSubagent: boolean;
	#inheritConfig: ToolsInheritConfig;
	#inheritedTools: Set<string>;
	#directTools: Set<string>;
	#mcpEnabledTools: Set<string>;
	#mcpTools: Set<string>;
	#disabledTools: Set<string>;
	#resolvedTools: Set<string>;
	readonly #callbacks: ToolsConfigPanelCallbacks;
	#selectedIndex = 0;
	#scrollOffset = 0;
	/** Whether this editing session began with a persisted subagent tools config. */
	#hadPersistedInheritConfig = false;
	/** Inherit base used when bootstrapping a new config for a config-less subagent. */
	#inheritBase: string | undefined;

	constructor(options: ToolsConfigPanelOptions) {
		this.#allTools = options.allTools;
		this.#isSubagent = options.isSubagent;
		this.#hadPersistedInheritConfig = options.hasPersistedInheritConfig ?? options.inheritConfig !== undefined;
		this.#inheritBase = options.inheritBase;
		this.#inheritConfig = cloneInheritConfig(options.inheritConfig ?? {});
		this.#inheritedTools = new Set(options.inheritedTools);
		this.#directTools = new Set(options.directTools ?? []);
		this.#mcpEnabledTools = new Set(options.mcpEnabledTools);
		this.#mcpTools = new Set(options.mcpTools);
		this.#disabledTools = new Set(options.disabledTools);
		this.#resolvedTools = new Set(options.resolvedTools);
		this.#callbacks = options.callbacks;
	}

	/** Refresh tool lists and config without resetting the cursor position. */
	update(options: {
		allTools: string[];
		isSubagent: boolean;
		inheritConfig?: ToolsInheritConfig;
		directTools?: string[];
		resolvedTools: string[];
		inheritedTools: string[];
		mcpEnabledTools: string[];
		mcpTools: string[];
		disabledTools: string[];
		inheritBase?: string;
		hasPersistedInheritConfig?: boolean;
	}): void {
		this.#allTools = options.allTools;
		this.#isSubagent = options.isSubagent;
		this.#hadPersistedInheritConfig =
			options.hasPersistedInheritConfig ?? (this.#hadPersistedInheritConfig && options.inheritConfig !== undefined);
		this.#inheritBase = options.inheritBase;
		this.#inheritConfig = cloneInheritConfig(options.inheritConfig ?? {});
		this.#inheritedTools = new Set(options.inheritedTools);
		this.#directTools = new Set(options.directTools ?? []);
		this.#mcpEnabledTools = new Set(options.mcpEnabledTools);
		this.#mcpTools = new Set(options.mcpTools);
		this.#disabledTools = new Set(options.disabledTools);
		this.#resolvedTools = new Set(options.resolvedTools);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#allTools.length - 1));
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Summary header: effective count + subagent inherit info.
		const effectiveCount = this.#resolvedTools.size;
		let header = `  Tools: ${effectiveCount} effective`;
		if (this.#isSubagent) {
			const addCount = this.#inheritConfig.add?.length ?? 0;
			const removeCount = (this.#inheritConfig.remove?.length ?? 0) + this.#disabledTools.size;
			const inheritFrom = this.#inheritConfig.inherit ?? this.#inheritBase ?? "default";
			const parts: string[] = [`inherit: ${inheritFrom}`];
			if (addCount > 0) parts.push(`+${addCount}`);
			if (removeCount > 0) parts.push(`-${removeCount}`);
			header += ` (${parts.join(", ")})`;
		}
		lines.push(truncateToWidth(theme.fg("dim", header), width));
		lines.push("");

		// Legend row.
		if (this.#isSubagent) {
			const inherited = theme.fg("dim", "[~]");
			const added = theme.fg("success", "[+]");
			const removed = theme.fg("error", "[-]");
			const off = theme.fg("dim", "[ ]");
			lines.push(
				truncateToWidth(
					` ${inherited}=inherited  ${added}=added  ${removed}=removed/blocked  ${off}=off   space:cycle`,
					width,
				),
			);
		} else {
			const enabled = theme.fg("success", "[✓]");
			const blocked = theme.fg("error", "[-]");
			const disabled = theme.fg("dim", "[ ]");
			lines.push(
				truncateToWidth(` ${enabled}=enabled  ${blocked}=blocked  ${disabled}=disabled   space:toggle`, width),
			);
		}
		lines.push("");
		lines.push("");

		if (this.#allTools.length === 0) {
			lines.push(theme.fg("muted", "  No tools available."));
			return lines;
		}

		this.#ensureVisible(this.#selectedIndex);

		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIdx = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#allTools.length);

		for (let i = this.#scrollOffset; i < endIdx; i++) {
			const tool = this.#allTools[i];
			if (!tool) continue;

			const isSelected = i === this.#selectedIndex;
			const state = this.#getToolState(tool);
			const stateTag = this.#renderStateTag(state);

			// Allocate remaining width to the tool name (tag is 3 chars + 1 space).
			const nameMaxWidth = Math.max(4, width - visibleWidth(stateTag) - 2);
			let nameStr = truncateToWidth(tool, nameMaxWidth);

			if (isSelected) {
				nameStr = theme.fg("accent", theme.bold(nameStr));
			} else if (state === "disabled" || state === "removed" || state === "blocked") {
				nameStr = theme.fg("dim", nameStr);
			}

			let line = ` ${stateTag} ${nameStr}`;
			if (isSelected) {
				line = theme.bg("selectedBg", truncateToWidth(line, width));
			}

			lines.push(truncateToWidth(line, width));
		}

		if (endIdx < this.#allTools.length) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▼ more"), width));
		}

		lines.push("");
		lines.push(truncateToWidth(theme.fg("dim", "  space:cycle  esc:close"), width));

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#selectedIndex = Math.max(0, Math.min(this.#allTools.length - 1, this.#selectedIndex + 1));
			return;
		}
		if (data === " " || matchesKey(data, "space")) {
			this.#cycleToolState();
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
		}
	}

	/**
	 * Determine the current UI state of a tool.
	 *
	 * Role mode: enabled if tool is in directTools, otherwise disabled.
	 *
	 * Subagent mode (ordered by specificity — explicit config beats inherited base):
	 *   add[]      → added
	 *   remove[]   → removed
	 *   inherited  → inherited
	 *   otherwise  → disabled
	 */
	#getToolState(tool: string): ToolState {
		if (this.#disabledTools.has(tool)) return this.#isSubagent ? "removed" : "blocked";
		if (this.#isSubagent) {
			if (this.#inheritConfig.remove?.includes(tool)) return "removed";
			if (this.#inheritConfig.add?.includes(tool)) return "added";
			if (this.#inheritedTools.has(tool) || this.#mcpEnabledTools.has(tool)) return "inherited";
			return "disabled";
		}
		return this.#directTools.has(tool) || this.#mcpEnabledTools.has(tool) ? "enabled" : "disabled";
	}

	#renderStateTag(state: ToolState): string {
		switch (state) {
			case "enabled":
				return theme.fg("success", "[✓]");
			case "disabled":
				return theme.fg("dim", "[ ]");
			case "inherited":
				return theme.fg("dim", "[~]");
			case "added":
				return theme.fg("success", "[+]");
			case "removed":
			case "blocked":
				return theme.fg("error", "[-]");
		}
	}

	/**
	 * Cycle the selected tool's state and emit the updated config.
	 *
	 * Role mode: enabled ↔ disabled (simple toggle).
	 *
	 * Subagent mode:
	 *   inherited → removed  (add to remove[])
	 *   removed   → inherited (remove from remove[])
	 *   added     → disabled  (remove from add[])
	 *   disabled  → added     (add to add[])
	 */
	#cycleToolState(): void {
		const tool = this.#allTools[this.#selectedIndex];
		if (!tool) return;

		if (this.#isSubagent) {
			// Subagents use the inheritance cycle for ALL tools including MCP.
			this.#cycleSubagentToolState(tool);
			return;
		}

		if (this.#mcpTools.has(tool)) {
			if (this.#mcpEnabledTools.has(tool) || this.#disabledTools.has(tool)) {
				this.#toggleMcpToolState(tool);
			}
			return;
		}
		this.#toggleRoleToolState(tool);
	}

	#toggleRoleToolState(tool: string): void {
		const newTools = new Set(this.#directTools);
		if (newTools.has(tool)) {
			newTools.delete(tool);
		} else {
			newTools.add(tool);
		}
		this.#directTools = newTools;
		this.#resolvedTools = this.#computeResolvedSubagentTools(this.#inheritConfig, newTools);
		this.#callbacks.onConfigChange({ tools: Array.from(newTools) });
	}

	#toggleMcpToolState(tool: string): void {
		const nextDisabled = new Set(this.#disabledTools);
		if (nextDisabled.has(tool)) {
			nextDisabled.delete(tool);
		} else {
			nextDisabled.add(tool);
		}
		this.#disabledTools = nextDisabled;
		this.#resolvedTools = this.#computeResolvedSubagentTools(this.#inheritConfig, this.#directTools);
		this.#callbacks.onConfigChange({ disabledTools: Array.from(nextDisabled) });
	}

	#cycleSubagentToolState(tool: string): void {
		const current = this.#getToolState(tool);
		const newConfig: ToolsInheritConfig = cloneInheritConfig(this.#inheritConfig);

		switch (current) {
			case "inherited":
				// inherited → removed: register explicit removal, purge any stale addition.
				newConfig.remove = [...(newConfig.remove ?? []), tool];
				newConfig.add = (newConfig.add ?? []).filter(t => t !== tool);
				if (newConfig.add.length === 0) delete newConfig.add;
				break;
			case "removed":
				// removed → inherited/disabled: drop explicit removal from all sources.
				// "removed" state may come from disabledTools (per-tool opt-out) or
				// inheritConfig.remove; clear both so the tool is no longer suppressed.
				if (this.#disabledTools.has(tool)) {
					const nextDisabled = new Set(this.#disabledTools);
					nextDisabled.delete(tool);
					this.#disabledTools = nextDisabled;
					this.#callbacks.onConfigChange({ disabledTools: Array.from(nextDisabled) });
				}
				newConfig.remove = (newConfig.remove ?? []).filter(t => t !== tool);
				if (newConfig.remove.length === 0) delete newConfig.remove;
				break;
			case "added":
				// added → disabled: drop the explicit addition, purge any stale removal.
				newConfig.add = (newConfig.add ?? []).filter(t => t !== tool);
				if (newConfig.add.length === 0) delete newConfig.add;
				newConfig.remove = (newConfig.remove ?? []).filter(t => t !== tool);
				if (newConfig.remove.length === 0) delete newConfig.remove;
				break;
			case "disabled":
				// disabled → added: register explicit addition, purge any stale removal.
				newConfig.add = [...(newConfig.add ?? []), tool];
				newConfig.remove = (newConfig.remove ?? []).filter(t => t !== tool);
				if (newConfig.remove.length === 0) delete newConfig.remove;
				break;
			// "enabled" only exists in role mode; this branch is unreachable here.
		}

		// When bootstrapping a first config for a config-less subagent, anchor the inherit
		// source explicitly so resolution semantics are preserved (otherwise "inherit" would
		// silently default to the "default" role, potentially changing the effective set).
		const hasOverrides = Boolean(newConfig.add?.length || newConfig.remove?.length);
		if (!this.#hadPersistedInheritConfig && !hasOverrides) {
			delete newConfig.inherit;
		}
		if (!this.#hadPersistedInheritConfig && hasOverrides && !newConfig.inherit && this.#inheritBase !== undefined) {
			newConfig.inherit = this.#inheritBase;
		}

		this.#resolvedTools = this.#computeResolvedSubagentTools(newConfig, this.#directTools);
		this.#inheritConfig = newConfig;

		// If a config-less subagent cycled back to a no-op (no add/remove/inherit), emit
		// an explicit clear signal rather than persisting an empty config.
		const isEmpty = !newConfig.inherit && !newConfig.add?.length && !newConfig.remove?.length;
		if (isEmpty && !this.#hadPersistedInheritConfig) {
			this.#callbacks.onConfigChange({ clearInheritConfig: true });
		} else {
			this.#callbacks.onConfigChange({ inheritConfig: newConfig });
		}
	}

	#computeResolvedSubagentTools(
		config: ToolsInheritConfig,
		directTools: Set<string> = this.#directTools,
	): Set<string> {
		const resolved = new Set(this.#isSubagent ? this.#inheritedTools : directTools);
		for (const tool of this.#mcpEnabledTools) {
			resolved.add(tool);
		}
		for (const tool of config.add ?? []) {
			resolved.add(tool);
		}
		for (const tool of [...(config.remove ?? []), ...this.#disabledTools]) {
			resolved.delete(tool);
		}
		return resolved;
	}

	/** Adjust #scrollOffset so that idx falls within the visible window. */
	#ensureVisible(idx: number): void {
		if (idx < this.#scrollOffset) {
			this.#scrollOffset = idx;
		} else if (idx >= this.#scrollOffset + MAX_VISIBLE) {
			this.#scrollOffset = idx - MAX_VISIBLE + 1;
		}
	}
}

function cloneInheritConfig(config: ToolsInheritConfig): ToolsInheritConfig {
	const clone: ToolsInheritConfig = {};
	if (config.inherit !== undefined) clone.inherit = config.inherit;
	if (config.add !== undefined) clone.add = [...config.add];
	if (config.remove !== undefined) clone.remove = [...config.remove];
	return clone;
}

import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

/** Effective state of a single tool from the perspective of the panel. */
export type ToolState = "enabled" | "disabled" | "blocked";

export type ToolsConfigChange = { tools: string[] } | { disabledTools: string[] };

export interface ToolsConfigPanelCallbacks {
	/** Called when tool config changes. */
	onConfigChange: (config: ToolsConfigChange) => void;
	/** Fired on interrupt/escape. Optional: caller decides whether to close. */
	onClose?: () => void;
}

export interface ToolsConfigPanelOptions {
	/** All known tool names in the system. */
	allTools: string[];
	/** The current direct tool list. */
	directTools?: string[];
	/** Resolved effective tool list for the current config. */
	resolvedTools: string[];
	/** MCP-derived tools enabled by the current server selection before per-tool disables. */
	mcpEnabledTools: string[];
	/** MCP tool names known for this role. */
	mcpTools: string[];
	/** Explicit per-tool opt-outs persisted separately from tool allowlists. */
	disabledTools: string[];
	callbacks: ToolsConfigPanelCallbacks;
}

/** Maximum rows to show in the visible window before scrolling. */
const MAX_VISIBLE = 15;

/**
 * Tools tab panel for the Agent Configuration modal.
 *
 * Simple enable/disable toggle for all agents:
 *   [✓] = enabled (green)   [ ] = disabled (dim)   [-] = blocked (red)
 *
 * Space toggles the state; up/down navigate; escape closes.
 */
export class ToolsConfigPanel implements Component {
	#allTools: string[];
	#directTools: Set<string>;
	#mcpEnabledTools: Set<string>;
	#mcpTools: Set<string>;
	#disabledTools: Set<string>;
	#resolvedTools: Set<string>;
	readonly #callbacks: ToolsConfigPanelCallbacks;
	#selectedIndex = 0;
	#scrollOffset = 0;

	constructor(options: ToolsConfigPanelOptions) {
		this.#allTools = options.allTools;
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
		directTools?: string[];
		resolvedTools: string[];
		mcpEnabledTools: string[];
		mcpTools: string[];
		disabledTools: string[];
	}): void {
		this.#allTools = options.allTools;
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

		// Summary header: effective count.
		const effectiveCount = this.#resolvedTools.size;
		const header = `  Tools: ${effectiveCount} effective`;
		lines.push(truncateToWidth(theme.fg("dim", header), width));
		lines.push("");

		// Legend row.
		const enabled = theme.fg("success", "[✓]");
		const blocked = theme.fg("error", "[-]");
		const disabled = theme.fg("dim", "[ ]");
		lines.push(
			truncateToWidth(` ${enabled}=enabled  ${blocked}=blocked  ${disabled}=disabled   space:toggle`, width),
		);
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
			} else if (state === "disabled" || state === "blocked") {
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
		lines.push(truncateToWidth(theme.fg("dim", "  space:toggle  esc:close"), width));

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
			this.#toggleToolState();
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose?.();
		}
	}

	/**
	 * Determine the current UI state of a tool.
	 * enabled: tool is in directTools or mcpEnabledTools and not disabled
	 * blocked: tool is in disabledTools (MCP tool opt-out)
	 * disabled: tool is not enabled
	 */
	#getToolState(tool: string): ToolState {
		if (this.#disabledTools.has(tool)) return "blocked";
		return this.#directTools.has(tool) || this.#mcpEnabledTools.has(tool) ? "enabled" : "disabled";
	}

	#renderStateTag(state: ToolState): string {
		switch (state) {
			case "enabled":
				return theme.fg("success", "[✓]");
			case "disabled":
				return theme.fg("dim", "[ ]");
			case "blocked":
				return theme.fg("error", "[-]");
		}
	}

	/**
	 * Toggle the selected tool's state and emit the updated config.
	 * For MCP tools: toggles disabled state.
	 * For regular tools: toggles directTools membership.
	 */
	#toggleToolState(): void {
		const tool = this.#allTools[this.#selectedIndex];
		if (!tool) return;

		if (this.#mcpTools.has(tool)) {
			// MCP tools toggle through disabled state
			const nextDisabled = new Set(this.#disabledTools);
			if (nextDisabled.has(tool)) {
				nextDisabled.delete(tool);
			} else {
				nextDisabled.add(tool);
			}
			this.#disabledTools = nextDisabled;
			this.#resolvedTools = this.#computeResolvedTools();
			this.#callbacks.onConfigChange({ disabledTools: Array.from(nextDisabled) });
		} else {
			// Regular tools toggle directTools membership
			const newTools = new Set(this.#directTools);
			if (newTools.has(tool)) {
				newTools.delete(tool);
			} else {
				newTools.add(tool);
			}
			this.#directTools = newTools;
			this.#resolvedTools = this.#computeResolvedTools();
			this.#callbacks.onConfigChange({ tools: Array.from(newTools) });
		}
	}

	#computeResolvedTools(): Set<string> {
		const resolved = new Set(this.#directTools);
		for (const tool of this.#mcpEnabledTools) {
			if (!this.#disabledTools.has(tool)) {
				resolved.add(tool);
			}
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

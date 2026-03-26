import { type Component, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { RolesConfig } from "../../../config/roles-config";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

/** "augment" is pinned and cannot be disabled by the user. */
const ALWAYS_ON_SERVER = "augment";

export interface McpPanelOptions {
	knownServers: string[];
	enabledServers: string[];
	rolesConfig: RolesConfig;
	/** Role name (used when persisting the server list). */
	role: string;
	/**
	 * When true, writes are sent to subagents config via setMcpForSubagent.
	 * When false, writes go to role config via setMcpForRole.
	 */
	isSubagent: boolean;
	onClose?: () => void;
}

/** Maximum rows to show in the visible window before scrolling. */
const MAX_VISIBLE = 15;

/**
 * MCP server toggle panel for the Agent Configuration modal.
 *
 * Renders a checkbox list of known servers. The "augment" server is always
 * enabled and cannot be toggled. Changes are persisted immediately via the
 * provided RolesConfig instance.
 *
 * A restart warning is shown because MCP server changes take effect only
 * when the session is next started.
 */
export class McpPanel implements Component {
	#servers: string[];
	#enabled: Set<string>;
	readonly #rolesConfig: RolesConfig;
	readonly #role: string;
	readonly #isSubagent: boolean;
	readonly #onClose: (() => void) | undefined;
	#selectedIndex = 0;
	#scrollOffset = 0;

	constructor(options: McpPanelOptions) {
		this.#servers = options.knownServers;
		this.#enabled = new Set(options.enabledServers);
		this.#rolesConfig = options.rolesConfig;
		this.#role = options.role;
		this.#isSubagent = options.isSubagent;
		this.#onClose = options.onClose;
	}

	/** Refresh the server list and enabled set without resetting the selection. */
	update(knownServers: string[], enabledServers: string[]): void {
		this.#servers = knownServers;
		this.#enabled = new Set(enabledServers);
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#servers.length - 1));
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Session-restart notice — MCP servers are loaded at startup.
		lines.push(truncateToWidth(theme.fg("warning", "  ⚠ Changes take effect on next session restart"), width));
		lines.push("");

		if (this.#servers.length === 0) {
			lines.push(theme.fg("muted", "  No MCP servers configured."));
			return lines;
		}

		this.#ensureVisible(this.#selectedIndex);

		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		const endIdx = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#servers.length);

		for (let i = this.#scrollOffset; i < endIdx; i++) {
			const server = this.#servers[i];
			if (!server) continue;

			const isSelected = i === this.#selectedIndex;
			const isAlwaysOn = server === ALWAYS_ON_SERVER;
			// Always-on servers count as enabled regardless of the enabled set.
			const isEnabled = isAlwaysOn || this.#enabled.has(server);

			const checkbox = isEnabled
				? theme.fg("success", theme.checkbox.checked)
				: theme.fg("dim", theme.checkbox.unchecked);

			const badge = isAlwaysOn ? theme.fg("dim", " (always on)") : "";
			let line = ` ${checkbox} ${server}${badge}`;

			if (isSelected) {
				// Pad to full width before applying background so the row is solid.
				line = theme.bg("selectedBg", truncateToWidth(line, width));
			} else if (!isEnabled) {
				line = theme.fg("dim", line);
			}

			lines.push(truncateToWidth(line, width));
		}

		if (endIdx < this.#servers.length) {
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
			this.#selectedIndex = Math.max(0, Math.min(this.#servers.length - 1, this.#selectedIndex + 1));
			return;
		}
		if (data === " " || matchesKey(data, "space")) {
			this.#toggleSelected();
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#onClose?.();
		}
	}

	/**
	 * Toggle the selected server and persist immediately.
	 * The "augment" server cannot be removed and is silently skipped.
	 */
	#toggleSelected(): void {
		const server = this.#servers[this.#selectedIndex];
		if (!server || server === ALWAYS_ON_SERVER) return;

		const newEnabled = new Set(this.#enabled);
		if (newEnabled.has(server)) {
			newEnabled.delete(server);
		} else {
			newEnabled.add(server);
		}
		this.#enabled = newEnabled;

		const serverList = Array.from(newEnabled);
		if (this.#isSubagent) {
			this.#rolesConfig.setMcpForSubagent(this.#role, serverList);
		} else {
			this.#rolesConfig.setMcpForRole(this.#role, serverList);
		}
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

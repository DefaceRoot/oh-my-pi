import { type Component, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import {
	MODEL_ROLE_CATEGORIES,
	MODEL_ROLE_IDS_BY_CATEGORY,
	MODEL_ROLES,
	type ModelRole,
	type ModelRoleCategory,
} from "../../../config/model-registry";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";

export interface AgentListPanelCallbacks {
	/** Called when the user confirms an agent selection. */
	onAgentSelect: (role: ModelRole) => void;
	/** Called when the user presses the interrupt/escape key. */
	onClose: () => void;
}

export interface AgentListPanelOptions {
	/** Role to highlight on construction. Defaults to the first agent. */
	selectedRole?: ModelRole;
	/**
	 * Returns true if a role carries non-default configuration. When true, a
	 * dot indicator (●) is shown next to the agent name. The parent modal
	 * computes this from RolesConfig state so the panel stays stateless with
	 * respect to config comparison logic.
	 */
	isCustomConfigured?: (role: ModelRole) => boolean;
	callbacks: AgentListPanelCallbacks;
}

type AgentListItem = { type: "header"; category: ModelRoleCategory } | { type: "agent"; role: ModelRole };

const CATEGORY_ORDER: ModelRoleCategory[] = ["core", "captain", "crew"];

/** Maximum rows to show in the visible window before scrolling. */
const MAX_VISIBLE = 24;

/**
 * Left-panel component for the Agent Configuration modal.
 *
 * Renders agents grouped by Core / Captains / Crew. Category headers are
 * non-selectable; up/down navigation skips them automatically.
 */
export class AgentListPanel implements Component {
	readonly #callbacks: AgentListPanelCallbacks;
	readonly #isCustomConfigured: (role: ModelRole) => boolean;
	/** Flat list of headers and agents in display order. */
	readonly #items: AgentListItem[];
	/** Indices into #items that point to agent entries (in order). */
	readonly #agentIndices: number[];
	/** Current position within #agentIndices. */
	#selectedAgentPos: number;
	#scrollOffset = 0;

	constructor(options: AgentListPanelOptions) {
		this.#callbacks = options.callbacks;
		this.#isCustomConfigured = options.isCustomConfigured ?? (() => false);

		// Build the flat item list once — the category grouping is static.
		const items: AgentListItem[] = [];
		const agentIndices: number[] = [];
		for (const category of CATEGORY_ORDER) {
			const roles = MODEL_ROLE_IDS_BY_CATEGORY[category];
			if (roles.length === 0) continue;
			items.push({ type: "header", category });
			for (const role of roles) {
				agentIndices.push(items.length);
				items.push({ type: "agent", role });
			}
		}
		this.#items = items;
		this.#agentIndices = agentIndices;

		// Resolve initial selection.
		const selectedRole = options.selectedRole;
		if (selectedRole !== undefined) {
			const pos = agentIndices.findIndex(idx => {
				const item = items[idx];
				return item?.type === "agent" && item.role === selectedRole;
			});
			this.#selectedAgentPos = pos >= 0 ? pos : 0;
		} else {
			this.#selectedAgentPos = 0;
		}
	}

	/** The currently highlighted role, or undefined if the list is empty. */
	get selectedRole(): ModelRole | undefined {
		const idx = this.#agentIndices[this.#selectedAgentPos];
		if (idx === undefined) return undefined;
		const item = this.#items[idx];
		return item?.type === "agent" ? item.role : undefined;
	}

	invalidate(): void {
		// Stateless render; nothing to flush.
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const selectedFlatIdx = this.#agentIndices[this.#selectedAgentPos] ?? 0;
		this.#ensureVisible(selectedFlatIdx);

		const endIdx = Math.min(this.#scrollOffset + MAX_VISIBLE, this.#items.length);

		if (this.#scrollOffset > 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▲ more"), width));
		}

		for (let i = this.#scrollOffset; i < endIdx; i++) {
			const item = this.#items[i];
			if (!item) continue;

			if (item.type === "header") {
				const catInfo = MODEL_ROLE_CATEGORIES[item.category];
				const label = theme.fg(catInfo.color, `▸ ${catInfo.label}`);
				lines.push(truncateToWidth(` ${label}`, width));
			} else {
				const roleInfo = MODEL_ROLES[item.role];
				const isSelected = i === selectedFlatIdx;
				const tag = roleInfo.tag ?? item.role.toUpperCase();
				// Custom-config indicator: a small dot next to the agent name.
				const dot = this.#isCustomConfigured(item.role) ? ` ${theme.fg("accent", "●")}` : "";
				const tagStyled = theme.bold(tag);
				let line: string;
				if (isSelected) {
					const cursor = theme.fg("accent", theme.nav.cursor);
					const content = theme.fg("accent", `${tagStyled} ${roleInfo.name}`);
					line = ` ${cursor} ${content}${dot}`;
				} else {
					line = `    ${tagStyled} ${theme.fg("dim", roleInfo.name)}${dot}`;
				}
				lines.push(truncateToWidth(line, width));
			}
		}

		if (endIdx < this.#items.length) {
			lines.push(truncateToWidth(theme.fg("dim", "  ▼ more"), width));
		}

		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || data === "k") {
			this.#move(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const role = this.selectedRole;
			if (role !== undefined) {
				this.#callbacks.onAgentSelect(role);
			}
			return;
		}
		if (matchesAppInterrupt(data)) {
			this.#callbacks.onClose();
		}
	}

	#move(delta: number): void {
		this.#selectedAgentPos = Math.max(0, Math.min(this.#agentIndices.length - 1, this.#selectedAgentPos + delta));
	}

	/** Adjust #scrollOffset so that flatIdx falls within the visible window. */
	#ensureVisible(flatIdx: number): void {
		if (flatIdx < this.#scrollOffset) {
			this.#scrollOffset = Math.max(0, flatIdx);
		} else if (flatIdx >= this.#scrollOffset + MAX_VISIBLE) {
			this.#scrollOffset = flatIdx - MAX_VISIBLE + 1;
		}
	}
}

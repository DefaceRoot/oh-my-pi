import { type Component, matchesKey, padding, TabBar, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { MODEL_ROLE_IDS_BY_CATEGORY, type ModelRole } from "../../../config/model-registry";
import type { RolesConfig } from "../../../config/roles-config";
import type { Settings } from "../../../config/settings";
import type { Skill } from "../../../extensibility/skills";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";
import { DynamicBorder } from "../dynamic-border";
import { AgentListPanel } from "./agent-list-panel";
import { McpPanel } from "./mcp-panel";
import { SkillConfigPanel } from "./skill-config-panel";

/** Fixed width of the agent list panel on the left side of the split. */
const LEFT_PANEL_WIDTH = 28;

/**
 * Core roles are non-subagents. Roles absent from this set use the subagent
 * config accessors when reading/writing skills and MCP settings.
 */
const CORE_ROLES = new Set(MODEL_ROLE_IDS_BY_CATEGORY.core);

/** Which half of the two-panel layout currently owns keyboard focus. */
type ActivePanel = "left" | "right";

export interface AgentConfigModalOptions {
	settings: Settings;
	rolesConfig: RolesConfig;
	/** All MCP server names known to the session. */
	knownMcpServers: string[];
	discoveredSkills: Skill[];
	/** Called when the modal should close. */
	onDismiss: () => void;
	/** Called whenever the modal mutates state that requires a repaint. */
	onRequestRender: () => void;
}

/**
 * Agent Configuration modal.
 *
 * Two-panel layout:
 *   Left  — AgentListPanel (~28 chars wide, fixed)
 *   Right — TabBar (Model / Skills / MCP) + active tab content
 *
 * Focus model:
 *   Tab / Shift+Tab                       — toggle focus between left and right panels
 *   ←/→ arrows (right panel)              — switch between Model / Skills / MCP tabs
 *   ↑/↓ (left panel)                      — navigate the agent list
 *   ↑/↓ (right panel, Skills or MCP tab)  — navigate the active list
 *   Space (right panel, Skills tab)       — cycle skill mode (disabled→auto→frontmatter)
 *   Space (right panel, MCP tab)          — toggle MCP server on/off
 *   Escape                                — close
 */
export class AgentConfigModal implements Component {
	readonly #settings: Settings;
	readonly #rolesConfig: RolesConfig;
	readonly #knownMcpServers: string[];
	readonly #discoveredSkills: Skill[];
	readonly #onDismiss: () => void;
	readonly #onRequestRender: () => void;

	#activeRole: ModelRole = "default";
	#activePanel: ActivePanel = "left";

	readonly #border: DynamicBorder;
	readonly #agentListPanel: AgentListPanel;
	readonly #tabBar: TabBar;
	readonly #skillPanel: SkillConfigPanel;
	#mcpPanel: McpPanel; // rebuilt on each role switch to keep role/isSubagent in sync
	readonly #modelTabPanel: Component;

	/**
	 * Composite right-side component: TabBar rows, a separator line, then the
	 * content of the currently-active tab.  This object is stable across role
	 * switches; switching tabs or roles is reflected because the accessors
	 * (#activeContentPanel, #mcpPanel) are always evaluated at render time.
	 */
	readonly #rightPanel: Component;

	constructor(options: AgentConfigModalOptions) {
		this.#settings = options.settings;
		this.#rolesConfig = options.rolesConfig;
		this.#knownMcpServers = options.knownMcpServers;
		this.#discoveredSkills = options.discoveredSkills;
		this.#onDismiss = options.onDismiss;
		this.#onRequestRender = options.onRequestRender;

		this.#border = new DynamicBorder();

		// Left panel — agent list.  Selection changes drive #switchToRole.
		this.#agentListPanel = new AgentListPanel({
			selectedRole: "default",
			isCustomConfigured: role => this.#isCustomConfigured(role),
			callbacks: {
				onAgentSelect: role => this.#switchToRole(role),
				onClose: () => this.#onDismiss(),
			},
		});

		// Tab bar for the right panel.
		// The shared theme says "(tab to cycle)" but this modal intercepts Tab for
		// panel-focus toggling, so override the hint to show the actual binding.
		const baseTabBarTheme = getTabBarTheme();
		const agentConfigTabBarTheme = {
			...baseTabBarTheme,
			// Only advertise ←/→ when the right panel actually owns focus;
			// when the left panel is active the arrows don't reach the tab bar.
			hint: () => (this.#activePanel === "right" ? theme.fg("dim", "(←/→ to cycle)") : ""),
		};
		this.#tabBar = new TabBar(
			"Config",
			[
				{ id: "model", label: "Model" },
				{ id: "skills", label: "Skills" },
				{ id: "mcp", label: "MCP" },
			],
			agentConfigTabBarTheme,
		);
		this.#tabBar.onTabChange = () => this.#onRequestRender();

		// Skills tab panel — initialised for the default role.
		const initialSkillConfig = this.#rolesConfig.getSkillConfigForRole("default") ?? { auto: [], frontmatter: [] };
		this.#skillPanel = new SkillConfigPanel({
			skills: options.discoveredSkills,
			skillConfig: initialSkillConfig,
			callbacks: {
				onConfigChange: config => {
					// Persist to the correct config section for the current role.
					if (this.#isSubagentRole(this.#activeRole)) {
						this.#rolesConfig.setSkillConfigForSubagent(this.#activeRole, config);
					} else {
						this.#rolesConfig.setSkillConfigForRole(this.#activeRole, config);
					}
					this.#onRequestRender();
				},
				onClose: () => this.#onDismiss(),
			},
		});

		// MCP tab panel — initialised for the default role.
		const initialEnabledServers = this.#rolesConfig.getMcpForRole("default");
		this.#mcpPanel = new McpPanel({
			knownServers: options.knownMcpServers,
			enabledServers: initialEnabledServers,
			rolesConfig: options.rolesConfig,
			role: "default",
			isSubagent: false,
			onClose: () => this.#onDismiss(),
		});

		// Model tab — inline read-only display; no persistent state.
		this.#modelTabPanel = {
			render: (width: number): string[] => {
				const model = this.#settings.getModelRole(this.#activeRole) ?? "(inherited from default)";
				return [
					truncateToWidth(theme.fg("dim", "  Current model:"), width),
					truncateToWidth(`  ${theme.bold(model)}`, width),
					"",
					truncateToWidth(theme.fg("dim", "  Use /model to change model assignments"), width),
				];
			},
			invalidate: () => {},
		};

		// Composite right-side panel: tabs + separator + active content.
		this.#rightPanel = {
			render: (width: number): string[] => {
				const tabLines = this.#tabBar.render(width);
				const sep = theme.fg("border", theme.boxSharp.horizontal.repeat(Math.max(1, width)));
				const contentLines = this.#activeContentPanel.render(width);
				return [...tabLines, sep, ...contentLines];
			},
			handleInput: () => {},
			invalidate: () => {
				this.#tabBar.invalidate();
				this.#skillPanel.invalidate();
				this.#mcpPanel.invalidate();
			},
		};
	}

	// ── Getters ──────────────────────────────────────────────────────────────

	/** Returns the content component for whichever tab is currently active. */
	get #activeContentPanel(): Component {
		const idx = this.#tabBar.getActiveIndex();
		if (idx === 0) return this.#modelTabPanel;
		if (idx === 1) return this.#skillPanel;
		return this.#mcpPanel;
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	#isSubagentRole(role: ModelRole): boolean {
		return !CORE_ROLES.has(role);
	}

	/**
	 * A role is "custom configured" if it has any explicitly enabled skills.
	 * MCP config is intentionally excluded here because every role inherits a
	 * default list; only skills clearly signal user intent.
	 */
	#isCustomConfigured(role: ModelRole): boolean {
		const skillConfig = this.#isSubagentRole(role)
			? this.#rolesConfig.getSkillConfigForSubagent(role)
			: this.#rolesConfig.getSkillConfigForRole(role);
		return skillConfig !== undefined && (skillConfig.auto.length > 0 || skillConfig.frontmatter.length > 0);
	}

	/**
	 * Switch the right panel to show configuration for `role`.
	 *
	 * The McpPanel is rebuilt (not updated) so that its role/isSubagent fields
	 * stay in sync with the new target — McpPanel.update() only refreshes the
	 * server list, not the persistence target.
	 */
	#switchToRole(role: ModelRole): void {
		this.#activeRole = role;
		const isSubagent = this.#isSubagentRole(role);

		// Refresh skills panel in-place (preserves scroll position).
		const skillConfig = (isSubagent
			? this.#rolesConfig.getSkillConfigForSubagent(role)
			: this.#rolesConfig.getSkillConfigForRole(role)) ?? { auto: [], frontmatter: [] };
		this.#skillPanel.update(this.#discoveredSkills, skillConfig);

		// Rebuild MCP panel so the persistence target is correct for the new role.
		const enabledServers = isSubagent
			? this.#rolesConfig.getMcpForSubagent(role)
			: this.#rolesConfig.getMcpForRole(role);
		this.#mcpPanel = new McpPanel({
			knownServers: this.#knownMcpServers,
			enabledServers,
			rolesConfig: this.#rolesConfig,
			role,
			isSubagent,
			onClose: () => this.#onDismiss(),
		});

		this.#onRequestRender();
	}

	// ── Component interface ───────────────────────────────────────────────────

	invalidate(): void {
		this.#agentListPanel.invalidate();
		this.#rightPanel.invalidate?.();
	}

	render(totalWidth: number): string[] {
		const lines: string[] = [];
		const leftWidth = Math.max(0, Math.min(LEFT_PANEL_WIDTH, totalWidth - 2));
		const rightWidth = Math.max(0, totalWidth - leftWidth - 1);

		// ── Top border ──
		lines.push(...this.#border.render(totalWidth));

		// ── Title ──
		lines.push(truncateToWidth(theme.fg("accent", " Agent Configuration"), totalWidth));

		// ── Body: left panel + separator + right panel ──
		const leftLines = this.#agentListPanel.render(leftWidth);
		const rightLines = this.#rightPanel.render(rightWidth);
		const maxLines = Math.max(leftLines.length, rightLines.length);

		for (let i = 0; i < maxLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			// Pad left column to exact width so the separator stays aligned.
			const padAmount = Math.max(0, leftWidth - visibleWidth(left));
			const paddedLeft = padAmount > 0 ? `${left}${padding(padAmount)}` : left;
			if (rightWidth === 0) {
				lines.push(paddedLeft);
			} else {
				// Dim the separator of the non-focused panel's boundary.
				const sep = theme.fg("border", "│");
				lines.push(`${paddedLeft}${sep}${right}`);
			}
		}

		// ── Hint bar ──
		// Show only the controls that are genuinely active in the current state.
		const parts: string[] = [" tab:switch-panel"];
		if (this.#activePanel === "right") {
			parts.push(" ←/→:switch-tab");
			// ↑/∣ and space are only meaningful for the Skills and MCP tabs;
			// the Model tab is a read-only display.
			const activeTabIdx = this.#tabBar.getActiveIndex();
			if (activeTabIdx === 1) {
				// Skills: space cycles disabled → auto → frontmatter
				parts.push(" ↑/↓:navigate  space:cycle");
			} else if (activeTabIdx === 2) {
				// MCP: space toggles the selected server on/off
				parts.push(" ↑/↓:navigate  space:toggle");
			}
		} else {
			parts.push(" ↑/↓:navigate");
		}
		parts.push(" esc:close");
		lines.push(truncateToWidth(theme.fg("dim", parts.join(" ")), totalWidth));

		// ── Bottom border ──
		lines.push(...this.#border.render(totalWidth));

		return lines;
	}

	handleInput(data: string): void {
		// Escape closes the modal before any panel-specific handling.
		if (matchesAppInterrupt(data)) {
			this.#onDismiss();
			return;
		}

		// Tab / Shift+Tab always toggle focus between the two panels.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#activePanel = this.#activePanel === "left" ? "right" : "left";
			this.#onRequestRender();
			return;
		}

		if (this.#activePanel === "left") {
			const prevRole = this.#agentListPanel.selectedRole;
			this.#agentListPanel.handleInput(data);
			// If navigation moved to a different role, update right panels.
			const newRole = this.#agentListPanel.selectedRole;
			if (newRole !== undefined && newRole !== prevRole) {
				this.#switchToRole(newRole);
			} else {
				this.#onRequestRender();
			}
		} else {
			// Right panel: arrows switch tabs; everything else goes to the
			// content panel (skills list / MCP list / model display).
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				this.#tabBar.handleInput(data);
				this.#onRequestRender();
				return;
			}
			this.#activeContentPanel.handleInput?.(data);
			this.#onRequestRender();
		}
	}
}

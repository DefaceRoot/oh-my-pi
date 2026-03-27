import { type Component, matchesKey, padding, TabBar, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { MODEL_ROLE_IDS_BY_CATEGORY, type ModelRole } from "../../../config/model-registry";
import type { RolesConfig, ToolsInheritConfig } from "../../../config/roles-config";
import type { Settings } from "../../../config/settings";
import type { Skill } from "../../../extensibility/skills";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";
import { DynamicBorder } from "../dynamic-border";
import { AgentListPanel } from "./agent-list-panel";
import { McpPanel } from "./mcp-panel";
import { SkillConfigPanel } from "./skill-config-panel";
import { type ToolsConfigChange, ToolsConfigPanel } from "./tools-config-panel";

/** Fixed width of the agent list panel on the left side of the split. */
const LEFT_PANEL_WIDTH = 28;

/**
 * Core roles are non-subagents. Roles absent from this set use the subagent
 * config accessors when reading/writing skills, tools, and MCP settings.
 */
const CORE_ROLES = new Set(MODEL_ROLE_IDS_BY_CATEGORY.core);

/** Which half of the two-panel layout currently owns keyboard focus. */
type ActivePanel = "left" | "right";

type ToolsPanelState = {
	allTools: string[];
	isSubagent: boolean;
	inheritConfig?: ToolsInheritConfig;
	directTools?: string[];
	resolvedTools: string[];
	inheritedTools: string[];
	inheritBase?: string;
	hasPersistedInheritConfig?: boolean;
};

export interface AgentConfigModalOptions {
	settings: Settings;
	rolesConfig: RolesConfig;
	/** All configurable tool names known to the session. */
	knownTools: string[];
	/** Built-in default tool lists for subagents from discovered agent definitions. */
	subagentDefaultTools: Partial<Record<ModelRole, string[]>>;
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
 *   Right — TabBar (Model / Skills / Tools / MCP) + active tab content
 *
 * Focus model:
 *   Tab / Shift+Tab                       — toggle focus between left and right panels
 *   ←/→ arrows (right panel)              — switch between Model / Skills / Tools / MCP tabs
 *   ↑/↓ (left panel)                      — navigate the agent list
 *   ↑/↓ (right panel, Skills / Tools / MCP tab) — navigate the active list
 *   Space (right panel, Skills tab)       — cycle skill mode (disabled→auto→frontmatter)
 *   Space (right panel, Tools tab)        — toggle/cycle the selected tool
 *   Space (right panel, MCP tab)          — toggle MCP server on/off
 *   Escape                                — close
 */
export class AgentConfigModal implements Component {
	readonly #settings: Settings;
	readonly #rolesConfig: RolesConfig;
	readonly #knownTools: string[];
	readonly #knownMcpServers: string[];
	readonly #subagentDefaultTools: Partial<Record<ModelRole, string[]>>;
	readonly #discoveredSkills: Skill[];
	readonly #onDismiss: () => void;
	readonly #onRequestRender: () => void;

	#activeRole: ModelRole = "default";
	#activePanel: ActivePanel = "left";

	readonly #configlessDirectSubagentTools = new Map<ModelRole, string[]>();
	readonly #border: DynamicBorder;
	readonly #agentListPanel: AgentListPanel;
	readonly #tabBar: TabBar;
	readonly #skillPanel: SkillConfigPanel;
	readonly #toolsPanel: ToolsConfigPanel;
	#mcpPanel: McpPanel; // rebuilt on each role switch to keep role/isSubagent in sync
	readonly #modelTabPanel: Component;

	/**
	 * Composite right-side component: TabBar rows, a separator line, then the
	 * content of the currently-active tab. This object is stable across role
	 * switches; switching tabs or roles is reflected because the accessors are
	 * always evaluated at render time.
	 */
	readonly #rightPanel: Component;

	constructor(options: AgentConfigModalOptions) {
		this.#settings = options.settings;
		this.#rolesConfig = options.rolesConfig;
		this.#knownTools = options.knownTools;
		this.#knownMcpServers = options.knownMcpServers;
		this.#subagentDefaultTools = options.subagentDefaultTools;
		this.#discoveredSkills = options.discoveredSkills;
		this.#onDismiss = options.onDismiss;
		this.#onRequestRender = options.onRequestRender;

		this.#border = new DynamicBorder();

		// Left panel — agent list. Selection changes drive #switchToRole.

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
				{ id: "tools", label: "Tools" },
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

		// Tools tab panel — initialised for the default role.

		const initialToolsState = this.#getToolsPanelState("default");
		this.#toolsPanel = new ToolsConfigPanel({
			...initialToolsState,
			callbacks: {
				onConfigChange: change => this.#handleToolsConfigChange(change),
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
				this.#toolsPanel.invalidate();
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
		if (idx === 2) return this.#toolsPanel;
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

	#handleToolsConfigChange(change: ToolsConfigChange): void {
		if (!this.#isSubagentRole(this.#activeRole)) {
			if ("tools" in change) {
				this.#rolesConfig.setToolsForRole(this.#activeRole, change.tools);
				this.#onRequestRender();
			}
			return;
		}

		if ("tools" in change) {
			const configlessDirectBaseline = this.#getConfiglessDirectSubagentBaseline(this.#activeRole);
			if (configlessDirectBaseline !== null && this.#sameToolSet(change.tools, configlessDirectBaseline)) {
				this.#clearSubagentToolsConfig(this.#activeRole);
			} else {
				this.#persistDirectSubagentTools(this.#activeRole, change.tools);
			}
			this.#onRequestRender();
			return;
		}

		if ("clearInheritConfig" in change) {
			this.#clearSubagentToolsConfig(this.#activeRole);
			this.#onRequestRender();
			return;
		}

		if ("inheritConfig" in change) {
			this.#rolesConfig.setToolsForSubagent(this.#activeRole, change.inheritConfig);
			this.#onRequestRender();
		}
	}

	#sameToolSet(left: readonly string[], right: readonly string[]): boolean {
		if (left.length !== right.length) return false;
		const leftSet = new Set(left);
		return right.every(tool => leftSet.has(tool));
	}

	#getConfiglessDirectSubagentBaseline(role: ModelRole): string[] | null {
		const persistedTools = this.#rolesConfig.getFullConfig().subagents[role]?.tools;
		if (persistedTools !== undefined) {
			return this.#configlessDirectSubagentTools.get(role) ?? null;
		}

		const runtimeDefaultTools = this.#subagentDefaultTools[role];
		if (runtimeDefaultTools === undefined) {
			this.#configlessDirectSubagentTools.delete(role);
			return null;
		}

		const inheritBase = this.#resolveDefaultInheritBase(role);
		const inheritedTools = this.#resolveInheritedTools(inheritBase);
		if (this.#sameToolSet(runtimeDefaultTools, inheritedTools)) {
			this.#configlessDirectSubagentTools.delete(role);
			return null;
		}

		const baseline = [...runtimeDefaultTools];
		this.#configlessDirectSubagentTools.set(role, baseline);
		return baseline;
	}

	#isDirectSubagentToolsConfig(role: ModelRole): boolean {
		const persistedTools = this.#rolesConfig.getFullConfig().subagents[role]?.tools;
		return Array.isArray(persistedTools) || this.#getConfiglessDirectSubagentBaseline(role) !== null;
	}

	#persistDirectSubagentTools(role: ModelRole, tools: string[]): void {
		const fullConfig = this.#rolesConfig.getFullConfig();
		const currentConfig = fullConfig.subagents[role] ?? { mcp: this.#rolesConfig.getMcpForSubagent(role) };
		this.#rolesConfig.mergeConfig({
			subagents: {
				[role]: {
					...currentConfig,
					tools: [...tools],
				},
			},
		});
	}

	#clearSubagentToolsConfig(role: ModelRole): void {
		const fullConfig = this.#rolesConfig.getFullConfig();
		const currentConfig = fullConfig.subagents[role];
		if (!currentConfig || currentConfig.tools === undefined) return;

		const nextConfig = { ...currentConfig };
		delete nextConfig.tools;
		this.#rolesConfig.mergeConfig({ subagents: { [role]: nextConfig } });
	}

	#resolveDefaultInheritBase(role: ModelRole): string {
		const fullConfig = this.#rolesConfig.getFullConfig();
		return fullConfig.roles[role] !== undefined ? role : "default";
	}

	#resolveInheritedTools(inheritFrom: string): string[] {
		const fullConfig = this.#rolesConfig.getFullConfig();
		if (fullConfig.roles[inheritFrom] !== undefined) {
			return this.#rolesConfig.getToolsForRole(inheritFrom);
		}
		if (fullConfig.subagents[inheritFrom] !== undefined) {
			return this.#rolesConfig.getToolsForSubagent(inheritFrom) ?? this.#rolesConfig.getToolsForRole("default");
		}
		return this.#rolesConfig.getToolsForRole("default");
	}

	#getToolsPanelState(role: ModelRole): ToolsPanelState {
		if (!this.#isSubagentRole(role)) {
			const directTools = this.#rolesConfig.getToolsForRole(role);
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools,
				resolvedTools: directTools,
				inheritedTools: [],
			};
		}

		const fullConfig = this.#rolesConfig.getFullConfig();
		const persistedTools = fullConfig.subagents[role]?.tools;
		if (Array.isArray(persistedTools)) {
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools: persistedTools,
				resolvedTools: persistedTools,
				inheritedTools: [],
			};
		}

		const configlessDirectBaseline = this.#getConfiglessDirectSubagentBaseline(role);
		if (configlessDirectBaseline !== null) {
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools: configlessDirectBaseline,
				resolvedTools: configlessDirectBaseline,
				inheritedTools: [],
			};
		}

		const defaultInheritBase = this.#resolveDefaultInheritBase(role);
		if (persistedTools === undefined) {
			const inheritedTools = this.#resolveInheritedTools(defaultInheritBase);
			return {
				allTools: this.#knownTools,
				isSubagent: true,
				resolvedTools: inheritedTools,
				inheritedTools,
				inheritBase: defaultInheritBase,
			};
		}

		const inheritBase = persistedTools.inherit ?? defaultInheritBase;
		const inheritedTools = this.#resolveInheritedTools(inheritBase);
		const resolvedTools = this.#rolesConfig.getToolsForSubagent(role) ?? inheritedTools;
		return {
			allTools: this.#knownTools,
			isSubagent: true,
			inheritConfig: persistedTools,
			resolvedTools,
			inheritedTools,
			inheritBase,
			hasPersistedInheritConfig: true,
		};
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

		// Refresh skills and tools panels in-place (preserves scroll position).
		const skillConfig = (isSubagent
			? this.#rolesConfig.getSkillConfigForSubagent(role)
			: this.#rolesConfig.getSkillConfigForRole(role)) ?? { auto: [], frontmatter: [] };
		this.#skillPanel.update(this.#discoveredSkills, skillConfig);
		this.#toolsPanel.update(this.#getToolsPanelState(role));

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
				const sep = theme.fg("border", "│");
				lines.push(`${paddedLeft}${sep}${right}`);
			}
		}

		// ── Hint bar ──

		// Show only the controls that are genuinely active in the current state.

		const parts: string[] = [" tab:switch-panel"];
		if (this.#activePanel === "right") {
			parts.push(" ←/→:switch-tab");
			const activeTabIdx = this.#tabBar.getActiveIndex();
			if (activeTabIdx === 1) {
				parts.push(" ↑/↓:navigate  space:cycle");
			} else if (activeTabIdx === 2) {
				parts.push(
					` ↑/↓:navigate  space:${this.#isDirectSubagentToolsConfig(this.#activeRole) ? "toggle" : this.#isSubagentRole(this.#activeRole) ? "cycle" : "toggle"}`,
				);
			} else if (activeTabIdx === 3) {
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

			// content panel (skills list / tools list / MCP list / model display).

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

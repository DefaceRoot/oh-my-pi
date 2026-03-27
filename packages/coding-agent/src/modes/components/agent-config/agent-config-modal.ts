import { type Component, matchesKey, padding, TabBar, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { MODEL_ROLE_IDS_BY_CATEGORY, type ModelRegistry, type ModelRole } from "../../../config/model-registry";
import {
	findExactModelReferenceMatch,
	formatModelString,
	resolveFallbackModel,
	resolveModelRoleValue,
} from "../../../config/model-resolver";
import type {
	PresetAppliedEvent,
	PresetSnapshot,
	PresetsChangedEvent,
	PresetsConfig,
} from "../../../config/presets-config";
import type { AdvancedConfig, RolesConfig, ToolsInheritConfig } from "../../../config/roles-config";
import type { Settings } from "../../../config/settings";
import type { Skill } from "../../../extensibility/skills";
import { resolveSubagentRole } from "../../../task/model-role";
import { parseThinkingLevel } from "../../../thinking";
import { inferMcpServerNameFromToolName, isHiddenToolName, resolveEffectiveToolNames } from "../../../tools";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";
import { DynamicBorder } from "../dynamic-border";
import { AdvancedConfigPanel } from "./advanced-config-panel";
import { AgentListPanel } from "./agent-list-panel";
import { ModelPanel } from "./model-panel";
import { McpPanel } from "./mcp-panel";
import { PresetBar } from "./preset-bar";
import { PresetSelector } from "./preset-selector";
import { SkillConfigPanel } from "./skill-config-panel";
import { type ToolsConfigChange, ToolsConfigPanel } from "./tools-config-panel";

/** Fixed width of the agent list panel on the left side of the split. */
const LEFT_PANEL_WIDTH = 28;
const MIN_PRESET_SELECTOR_WIDTH = 28;
const MAX_PRESET_SELECTOR_WIDTH = 96;

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
	disabledTools: string[];
	mcpEnabledTools: string[];
	mcpTools: string[];
	inheritBase?: string;
	hasPersistedInheritConfig?: boolean;
};

export interface AgentConfigModalOptions {
	settings: Settings;
	rolesConfig: RolesConfig;
	modelRegistry: ModelRegistry;
	presetsConfig: PresetsConfig;
	/** All configurable tool names known to the session. */
	knownTools: string[];
	/** Built-in default tool lists for subagents from discovered agent definitions. */
	subagentDefaultTools: Partial<Record<ModelRole, string[]>>;
	/** All MCP server names known to the session. */
	knownMcpServers: string[];
	/** Exact MCP tool -> server mapping from the current runtime inventory. */
	mcpToolServerNames?: Record<string, string>;
	discoveredSkills: Skill[];
	/** Called when the modal should close. */
	onDismiss: () => void;
	/** Called whenever the modal mutates state that requires a repaint. */
	onRequestRender: () => void;
	/** Optional status surface owned by the caller (status line, toast, etc.). */
	onShowStatus?: (message: string) => void;
	/** Optional error surface owned by the caller (status line, toast, etc.). */
	onShowError?: (message: string) => void;
	/** Optional callback to apply persisted config to the live session when appropriate. */
	onRoleConfigChanged?: (role: ModelRole, section: "tools" | "advanced") => void;
}

/**
 * Agent Configuration modal.
 *
 * Two-panel layout:
 *   Left  — AgentListPanel (~28 chars wide, fixed)
 *   Right — PresetBar + TabBar (Model / MCP / Skills / Tools / Advanced) + active tab content
 *
 * Focus model:
 *   Tab / Shift+Tab                       — toggle focus between left and right panels
 *   ←/→ arrows (right panel)              — switch between Model / MCP / Skills / Tools / Advanced tabs
 *   ↑/↓ (left panel)                      — navigate the agent list
 *   ↑/↓ (right panel, non-model tabs)     — navigate the active list or field editor
 *   s / p / r                             — save, switch, or revert the active preset when available
 *   Space (right panel, Skills tab)       — cycle skill mode (disabled→auto→frontmatter)
 *   Space (right panel, Tools tab)        — toggle/cycle the selected tool
 *   Space (right panel, MCP tab)          — toggle MCP server on/off
 *   Space / Enter / r (Advanced tab)      — cycle, edit, or reset the selected override
 *   Escape                                — close current overlay or dismiss the modal
 */
export class AgentConfigModal implements Component {
	readonly #settings: Settings;
	readonly #rolesConfig: RolesConfig;
	readonly #modelRegistry: ModelRegistry;
	readonly #presetsConfig: PresetsConfig;
	#knownTools: string[];
	readonly #knownMcpServers: string[];
	readonly #mcpToolServerNames: Record<string, string>;
	readonly #subagentDefaultTools: Partial<Record<ModelRole, string[]>>;
	readonly #discoveredSkills: Skill[];
	readonly #onDismiss: () => void;
	readonly #onRequestRender: () => void;
	readonly #onShowStatus: ((message: string) => void) | undefined;
	readonly #onShowError: ((message: string) => void) | undefined;
	readonly #onRoleConfigChanged: ((role: ModelRole, section: "tools" | "advanced") => void) | undefined;
	readonly #unsubscribePresetApplied: () => void;

	#activeRole: ModelRole = "default";
	#activePanel: ActivePanel = "left";
	#dismissed = false;
	#presetSelector: PresetSelector | undefined;

	readonly #configlessDirectSubagentTools = new Map<ModelRole, string[]>();
	readonly #border: DynamicBorder;
	readonly #agentListPanel: AgentListPanel;
	readonly #tabBar: TabBar;
	readonly #presetBar: PresetBar;
	readonly #skillPanel: SkillConfigPanel;
	readonly #toolsPanel: ToolsConfigPanel;
	#mcpPanel: McpPanel; // rebuilt on each role switch to keep role/isSubagent in sync
	readonly #advancedPanel: AdvancedConfigPanel;
	readonly #modelTabPanel: ModelPanel;

	/**
	 * Composite right-side component: preset bar, tabs, separators, and the content
	 * of the currently-active tab. This object is stable across role switches;
	 * switching tabs or roles is reflected because the accessors are always
	 * evaluated at render time.
	 */
	readonly #rightPanel: Component;

	constructor(options: AgentConfigModalOptions) {
		this.#settings = options.settings;
		this.#rolesConfig = options.rolesConfig;
		this.#modelRegistry = options.modelRegistry;
		this.#presetsConfig = options.presetsConfig;
		this.#knownTools = [...options.knownTools];
		this.#knownMcpServers = options.knownMcpServers;
		this.#mcpToolServerNames = { ...(options.mcpToolServerNames ?? {}) };
		this.#subagentDefaultTools = options.subagentDefaultTools;
		this.#discoveredSkills = options.discoveredSkills;
		this.#onDismiss = options.onDismiss;
		this.#onRequestRender = options.onRequestRender;
		this.#onShowStatus = options.onShowStatus;
		this.#onShowError = options.onShowError;
		this.#onRoleConfigChanged = options.onRoleConfigChanged;
		this.#mergeKnownToolsFromSnapshot(
			this.#presetsConfig.getPreset(this.#presetsConfig.getActivePreset() ?? "") ?? null,
		);

		this.#border = new DynamicBorder();
		this.#presetBar = new PresetBar({
			activePreset: this.#presetsConfig.getActivePreset(),
			isModified: this.#presetsConfig.isModified(),
			onSave: () => {
				void this.#saveActivePreset();
			},
			onSaveAs: () => this.#openPresetSelector({ startCreate: true }),
			onSwitch: () => this.#openPresetSelector(),
			onRevert: () => {
				void this.#revertToActivePreset();
			},
		});
		const unsubscribePresetApplied = this.#presetsConfig.on("preset_applied", event => {
			void this.#handlePresetApplied(event);
		});
		const unsubscribePresetsChanged = this.#presetsConfig.on("presets_changed", (_event: PresetsChangedEvent) => {
			this.#syncPresetState();
			this.#onRequestRender();
		});
		this.#unsubscribePresetApplied = () => {
			unsubscribePresetApplied();
			unsubscribePresetsChanged();
		};

		// Left panel — agent list. Selection changes drive #switchToRole.
		this.#agentListPanel = new AgentListPanel({
			selectedRole: "default",
			isCustomConfigured: role => this.#isCustomConfigured(role),
			callbacks: {
				onAgentSelect: role => this.#switchToRole(role),
				onClose: () => this.#dismiss(),
			},
		});

		// Tab bar for the right panel.
		// The shared theme says "(tab to cycle)" but this modal intercepts Tab for
		// panel-focus toggling, so override the hint to show the actual binding.
		const baseTabBarTheme = getTabBarTheme();
		const agentConfigTabBarTheme = {
			...baseTabBarTheme,
			// Only advertise ←/→ when the right panel actually owns focus; when the
			// left panel is active the arrows don't reach the tab bar.
			hint: () => (this.#activePanel === "right" ? theme.fg("dim", "(←/→ to cycle)") : ""),
		};
		this.#tabBar = new TabBar(
			"Config",
			[
				{ id: "model", label: "Model" },
				{ id: "mcp", label: "MCP" },
				{ id: "skills", label: "Skills" },
				{ id: "tools", label: "Tools" },
				{ id: "advanced", label: "Advanced" },
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
					if (this.#isSubagentRole(this.#activeRole)) {
						this.#rolesConfig.setSkillConfigForSubagent(this.#activeRole, config);
					} else {
						this.#rolesConfig.setSkillConfigForRole(this.#activeRole, config);
					}
					this.#syncPresetState();
					this.#onRequestRender();
				},
				onClose: () => this.#dismiss(),
			},
		});

		// Tools tab panel — initialised for the default role.
		const initialToolsState = this.#getToolsPanelState("default");
		this.#toolsPanel = new ToolsConfigPanel({
			...initialToolsState,
			callbacks: {
				onConfigChange: change => this.#handleToolsConfigChange(change),
				onClose: () => this.#dismiss(),
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
			onServersChange: () => this.#handleMcpConfigChange(),
			onClose: () => this.#dismiss(),
		});

		// Model tab — shows the effective primary and fallback model state, and allows
		// selecting a per-agent fallback override inline.
		this.#modelTabPanel = new ModelPanel({
			...this.#getModelPanelState("default"),
			callbacks: {
				onSelectPrimary: modelKey => this.#persistPrimaryModel(this.#activeRole, modelKey),
				onSelectFallback: fallback => this.#persistFallbackModel(this.#activeRole, fallback),
				onClose: () => this.#dismiss(),
			},
		});

		// Advanced tab — per-agent overrides layered on top of global settings.
		this.#advancedPanel = new AdvancedConfigPanel({
			...this.#getAdvancedPanelState("default"),
			callbacks: {
				onConfigChange: config => this.#handleAdvancedConfigChange(config),
				onClose: () => this.#dismiss(),
			},
		});

		// Composite right-side panel: tabs + preset bar + separators + active content.
		this.#rightPanel = {
			render: (width: number): string[] => this.#renderRightPanel(width),
			handleInput: () => {},
			invalidate: () => {
				this.#tabBar.invalidate();
				this.#presetBar.invalidate();
				this.#modelTabPanel.invalidate();
				this.#mcpPanel.invalidate();
				this.#skillPanel.invalidate();
				this.#toolsPanel.invalidate();
				this.#advancedPanel.invalidate();
				this.#presetSelector?.invalidate();
			},
		};
	}

	// ── Getters ──────────────────────────────────────────────────────────────

	/** Returns the content component for whichever tab is currently active. */
	get #activeContentPanel(): Component {
		const idx = this.#tabBar.getActiveIndex();
		if (idx === 0) return this.#modelTabPanel;
		if (idx === 1) return this.#mcpPanel;
		if (idx === 2) return this.#skillPanel;
		if (idx === 3) return this.#toolsPanel;
		return this.#advancedPanel;
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

	#dismiss(): void {
		if (this.#dismissed) {
			return;
		}
		this.#dismissed = true;
		this.#unsubscribePresetApplied();
		this.#presetSelector = undefined;
		this.#onDismiss();
	}

	#showStatus(message: string): void {
		this.#onShowStatus?.(message);
	}

	#showError(message: string): void {
		this.#onShowError?.(message);
	}

	async #handlePresetApplied(event: PresetAppliedEvent): Promise<void> {
		this.#mergeKnownToolsFromSnapshot(event.snapshot);
		if (this.#presetsConfig.isEventFromThisInstance(event)) {
			this.#switchToRole(this.#activeRole);
			return;
		}
		try {
			await this.#settings.persistModelRolesAtomically(event.snapshot.modelRoles);
			this.#rolesConfig.mergeConfig({ roles: event.snapshot.roles, subagents: event.snapshot.subagents });
			this.#settings.clearOverride("modelRoles");
			this.#switchToRole(this.#activeRole);
		} catch (error) {
			this.#showError(error instanceof Error ? error.message : String(error));
			this.#onRequestRender();
		}
	}

	#mergeKnownTools(tools: Iterable<string>): void {
		const nextTools = [...this.#knownTools];
		const seen = new Set(nextTools);
		for (const tool of tools) {
			if (!tool || isHiddenToolName(tool) || seen.has(tool)) {
				continue;
			}
			seen.add(tool);
			nextTools.push(tool);
		}
		nextTools.sort((left, right) => left.localeCompare(right));
		this.#knownTools = nextTools;
	}

	#mergeKnownToolsFromSnapshot(snapshot: PresetSnapshot | null | undefined): void {
		if (!snapshot) {
			return;
		}
		this.#mergeKnownTools([
			...Object.values(snapshot.roles).flatMap(roleConfig => roleConfig.tools),
			...Object.values(snapshot.subagents).flatMap(subagentConfig => {
				const tools = subagentConfig.tools;
				if (tools === undefined) return [];
				if (Array.isArray(tools)) return tools;
				return [...(tools.add ?? []), ...(tools.remove ?? [])];
			}),
		]);
	}

	#syncPresetState(): void {
		this.#presetBar.update({
			activePreset: this.#presetsConfig.getActivePreset(),
			isModified: this.#presetsConfig.isModified(),
		});
	}

	#openPresetSelector(options: { startCreate?: boolean } = {}): void {
		const createdSelector = this.#presetSelector === undefined;
		if (createdSelector) {
			this.#presetSelector = new PresetSelector({
				presetsConfig: this.#presetsConfig,
				onApply: async name => {
					this.#presetSelector = undefined;
					this.#showStatus(`Applied ${name}.`);
					this.#syncPresetState();
					this.#switchToRole(this.#activeRole);
				},
				onClose: () => {
					this.#presetSelector = undefined;
					this.#onRequestRender();
				},
			});
		}
		if (options.startCreate && createdSelector) {
			this.#presetSelector?.handleInput("n");
		}
		this.#onRequestRender();
	}

	#renderRightPanel(width: number): string[] {
		const tabLines = this.#tabBar.render(width);
		const sep = theme.fg("border", theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const presetLines = this.#presetBar.render(width);
		const contentLines = this.#activeContentPanel.render(width);
		const baseLines = [...tabLines, sep, ...presetLines, sep, ...contentLines];
		return this.#presetSelector ? this.#renderPresetSelectorOverlay(baseLines, width) : baseLines;
	}

	#renderPresetSelectorOverlay(baseLines: string[], width: number): string[] {
		if (!this.#presetSelector || width <= 0) {
			return baseLines;
		}
		const overlayWidth =
			width <= MIN_PRESET_SELECTOR_WIDTH
				? width
				: Math.min(Math.max(MIN_PRESET_SELECTOR_WIDTH, width - 2), MAX_PRESET_SELECTOR_WIDTH);
		const overlayLines = this.#presetSelector.render(overlayWidth);
		const maxTop = Math.max(0, baseLines.length - overlayLines.length);
		const top = Math.min(Math.max(2, Math.floor((baseLines.length - overlayLines.length) / 2)), maxTop);
		return baseLines.map((line, index) => {
			const overlayIndex = index - top;
			if (overlayIndex < 0 || overlayIndex >= overlayLines.length) {
				return line;
			}
			const overlayLine = truncateToWidth(overlayLines[overlayIndex] ?? "", overlayWidth);
			const leftPad = Math.max(0, Math.floor((width - visibleWidth(overlayLine)) / 2));
			const rightPad = Math.max(0, width - leftPad - visibleWidth(overlayLine));
			return `${padding(leftPad)}${overlayLine}${padding(rightPad)}`;
		});
	}

	async #saveActivePreset(): Promise<void> {
		const activePresetName = this.#presetsConfig.getActivePreset();
		if (!activePresetName) {
			this.#openPresetSelector({ startCreate: true });
			return;
		}
		const existing = this.#presetsConfig.getPreset(activePresetName);
		if (!existing) {
			this.#syncPresetState();
			this.#showError(`Preset ${activePresetName} no longer exists.`);
			this.#onRequestRender();
			return;
		}
		try {
			this.#presetsConfig.savePreset(activePresetName, {
				...this.#presetsConfig.captureCurrentConfig(),
				description: existing.description,
				createdAt: existing.createdAt,
				updatedAt: new Date().toISOString(),
			});
			this.#syncPresetState();
			this.#showStatus(`Saved ${activePresetName}.`);
			this.#onRequestRender();
		} catch (error) {
			this.#showError(error instanceof Error ? error.message : String(error));
			this.#onRequestRender();
		}
	}

	async #revertToActivePreset(): Promise<void> {
		const activePresetName = this.#presetsConfig.getActivePreset();
		if (!activePresetName) {
			return;
		}
		try {
			await this.#presetsConfig.applyPreset(activePresetName);
			this.#showStatus(`Reverted ${activePresetName}.`);
		} catch (error) {
			this.#showError(error instanceof Error ? error.message : String(error));
			this.#onRequestRender();
		}
	}

	#handlePresetShortcut(data: string): boolean {
		const isSave = data === "s" || data === "S";
		const isSwitch = data === "p" || data === "P";
		const isRevert = data === "r" || data === "R";
		const allowRevertShortcut = this.#activePanel === "left" || this.#tabBar.getActiveIndex() !== 4;
		if (!isSave && !isSwitch && !(allowRevertShortcut && isRevert)) {
			return false;
		}
		this.#presetBar.handleInput(data);
		return true;
	}

	#persistPrimaryModel(role: ModelRole, modelKey: string): void {
		const existingPrimary = this.#settings.getModelRole(role);
		if (existingPrimary === modelKey) {
			// No change — refresh display in case list state drifted.
			this.#modelTabPanel.update(this.#getModelPanelState(role));
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}
		this.#settings.setModelRole(role, modelKey);
		this.#modelTabPanel.update(this.#getModelPanelState(role));
		this.#syncPresetState();
		this.#onRequestRender();
	}

	#persistFallbackModel(role: ModelRole, fallback: string | null): void {
		const { primaryModelKey } = this.#resolveCurrentModelDisplay(role);
		const normalizedFallback = fallback !== null && fallback === primaryModelKey ? null : fallback;
		const existingFallback = this.#normalizeModelKey(
			this.#isSubagentRole(role)
				? this.#rolesConfig.getFallbackForSubagent(role)
				: this.#rolesConfig.getFallbackForRole(role),
		);
		if (existingFallback === normalizedFallback) {
			this.#modelTabPanel.update(this.#getModelPanelState(role));
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}
		if (this.#isSubagentRole(role)) {
			this.#rolesConfig.setFallbackForSubagent(role, normalizedFallback);
		} else {
			this.#rolesConfig.setFallbackForRole(role, normalizedFallback);
		}
		this.#modelTabPanel.update(this.#getModelPanelState(role));
		this.#syncPresetState();
		this.#onRequestRender();
	}

	#normalizeModelKey(modelKey: string | null | undefined): string | null {
		const trimmed = modelKey?.trim();
		if (!trimmed) return null;
		const resolved = findExactModelReferenceMatch(trimmed, this.#modelRegistry.getAll());
		return resolved ? formatModelString(resolved) : trimmed;
	}

	#getPrimaryModelLookupOrder(role: ModelRole): readonly ModelRole[] {
		if (!this.#isSubagentRole(role)) {
			if (role === "default") return ["default"];
			if (role === "ask") return ["ask", "default"];
			return [role];
		}
		const subagentRole = resolveSubagentRole(role);
		return subagentRole === "implement" ? ["implement", "default"] : [subagentRole, "implement", "default"];
	}

	#resolveCurrentModelDisplay(role: ModelRole): { label: string; sourceLabel: string; primaryModelKey: string } {
		for (const lookupRole of this.#getPrimaryModelLookupOrder(role)) {
			const configured = this.#settings.getModelRole(lookupRole);
			if (!configured) continue;
			const resolved = resolveModelRoleValue(configured, this.#modelRegistry.getAll(), {
				settings: this.#settings,
			}).model;
			const primaryModelKey = resolved ? formatModelString(resolved) : configured;
			const sourceLabel =
				lookupRole === role
					? "explicit assignment"
					: lookupRole === "implement"
						? "inherited from implement"
						: "inherited from default";
			return { label: primaryModelKey, sourceLabel, primaryModelKey };
		}
		return { label: "(not configured)", sourceLabel: "not configured", primaryModelKey: "" };
	}

	#getModelPanelState(role: ModelRole) {
		const isSubagent = this.#isSubagentRole(role);
		const explicitFallback = this.#normalizeModelKey(
			isSubagent ? this.#rolesConfig.getFallbackForSubagent(role) : this.#rolesConfig.getFallbackForRole(role),
		);
		const globalDefault = this.#normalizeModelKey(this.#settings.get("model.defaultFallback") || null);
		const {
			label: currentModelLabel,
			sourceLabel: currentModelSourceLabel,
			primaryModelKey,
		} = this.#resolveCurrentModelDisplay(role);
		const effectiveFallback = resolveFallbackModel(
			role,
			role,
			isSubagent,
			this.#rolesConfig,
			this.#settings,
			this.#modelRegistry,
			primaryModelKey,
		);
		const fallbackSource =
			explicitFallback !== null ? "agent override" : globalDefault !== null ? "global default" : "none";
		const availableModelKeys = [
			...new Set(
				[
					explicitFallback,
					globalDefault,
					...this.#modelRegistry.getAvailable().map(model => formatModelString(model)),
				].filter((modelKey): modelKey is string => Boolean(modelKey)),
			),
		].sort((left, right) => left.localeCompare(right));

		return {
			currentModelLabel,
			currentModelSourceLabel,
			primaryModelKey,
			currentFallbackLabel: effectiveFallback
				? `${formatModelString(effectiveFallback)} (${fallbackSource})`
				: "none",
			overrideLabel: explicitFallback ?? (globalDefault ? "using global default" : "no override"),
			globalDefaultLabel: globalDefault ?? "none",
			clearOptionLabel: globalDefault ? `Use global default (${globalDefault})` : "No fallback",
			availableModelKeys,
			selectedFallbackKey: explicitFallback,
		};
	}

	#getAdvancedPanelState(role: ModelRole) {
		const isSubagent = this.#isSubagentRole(role);
		return {
			advancedConfig: isSubagent
				? this.#rolesConfig.getAdvancedForSubagent(role)
				: this.#rolesConfig.getAdvancedForRole(role),
			globalValues: {
				thinkingLevel: parseThinkingLevel(this.#settings.get("defaultThinkingLevel")),
				maxRecursionDepth: this.#settings.get("task.maxRecursionDepth") ?? 2,
				compactionStrategy: this.#settings.get("compaction.strategy"),
				temperature: this.#settings.get("temperature") ?? -1,
				memoriesEnabled: this.#settings.get("memories.enabled") ?? false,
				grepContextBefore: this.#settings.get("grep.contextBefore") ?? 0,
				grepContextAfter: this.#settings.get("grep.contextAfter") ?? 0,
			},
		};
	}

	#handleAdvancedConfigChange(config: AdvancedConfig | null): void {
		if (this.#isSubagentRole(this.#activeRole)) {
			this.#rolesConfig.setAdvancedForSubagent(this.#activeRole, config);
		} else {
			this.#rolesConfig.setAdvancedForRole(this.#activeRole, config);
			this.#onRoleConfigChanged?.(this.#activeRole, "advanced");
		}
		this.#syncPresetState();
		this.#onRequestRender();
	}

	#handleToolsConfigChange(change: ToolsConfigChange): void {
		if ("disabledTools" in change) {
			if (this.#isSubagentRole(this.#activeRole)) {
				this.#rolesConfig.setDisabledToolsForSubagent(this.#activeRole, change.disabledTools);
			} else {
				this.#rolesConfig.setDisabledToolsForRole(this.#activeRole, change.disabledTools);
				this.#onRoleConfigChanged?.(this.#activeRole, "tools");
			}
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}

		if (!this.#isSubagentRole(this.#activeRole)) {
			if ("tools" in change) {
				this.#rolesConfig.setToolsForRole(this.#activeRole, change.tools);
				this.#onRoleConfigChanged?.(this.#activeRole, "tools");
				this.#syncPresetState();
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
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}

		if ("clearInheritConfig" in change) {
			this.#clearSubagentToolsConfig(this.#activeRole);
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}

		if ("inheritConfig" in change) {
			this.#rolesConfig.setToolsForSubagent(this.#activeRole, change.inheritConfig);
			this.#syncPresetState();
			this.#onRequestRender();
		}
	}

	#handleMcpConfigChange(): void {
		this.#toolsPanel.update(this.#getToolsPanelState(this.#activeRole));
		this.#syncPresetState();
		this.#onRequestRender();
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

	#getMcpServerNameForToolName(toolName: string): string | undefined {
		return this.#mcpToolServerNames[toolName] ?? inferMcpServerNameFromToolName(toolName, this.#knownMcpServers);
	}

	#getAllMcpToolNames(): string[] {
		return this.#knownTools.filter(toolName => this.#getMcpServerNameForToolName(toolName) !== undefined);
	}

	#resolveEnabledMcpToolNames(enabledServers: string[], disabledTools: string[]): string[] {
		return resolveEffectiveToolNames({
			toolNames: this.#knownTools,
			settings: this.#settings,
			roleToolAllowlist: [],
			enabledMcpServers: enabledServers,
			disabledToolNames: disabledTools,
			getMcpServerName: toolName => this.#getMcpServerNameForToolName(toolName),
		}).filter(toolName => this.#getMcpServerNameForToolName(toolName) !== undefined);
	}

	#resolveEffectiveTools(directTools: string[], enabledServers: string[], disabledTools: string[]): string[] {
		const enabledMcpTools = this.#resolveEnabledMcpToolNames(enabledServers, disabledTools);
		const disabledToolSet = new Set(disabledTools);
		return [...new Set([...directTools, ...enabledMcpTools])].filter(toolName => !disabledToolSet.has(toolName));
	}

	#getToolsPanelState(role: ModelRole): ToolsPanelState {
		const mcpTools = this.#getAllMcpToolNames();
		if (!this.#isSubagentRole(role)) {
			const directTools = this.#rolesConfig.getToolsForRole(role);
			const disabledTools = this.#rolesConfig.getDisabledToolsForRole(role);
			const enabledServers = this.#rolesConfig.getMcpForRole(role);
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools,
				resolvedTools: this.#resolveEffectiveTools(directTools, enabledServers, disabledTools),
				inheritedTools: [],
				disabledTools,
				mcpEnabledTools: this.#resolveEnabledMcpToolNames(enabledServers, disabledTools),
				mcpTools,
			};
		}

		const fullConfig = this.#rolesConfig.getFullConfig();
		const persistedTools = fullConfig.subagents[role]?.tools;
		const enabledServers = this.#rolesConfig.getMcpForSubagent(role);
		const disabledTools = this.#rolesConfig.getDisabledToolsForSubagent(role);
		if (Array.isArray(persistedTools)) {
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools: persistedTools,
				resolvedTools: this.#resolveEffectiveTools(persistedTools, enabledServers, disabledTools),
				inheritedTools: [],
				disabledTools,
				mcpEnabledTools: this.#resolveEnabledMcpToolNames(enabledServers, disabledTools),
				mcpTools,
			};
		}

		const configlessDirectBaseline = this.#getConfiglessDirectSubagentBaseline(role);
		if (configlessDirectBaseline !== null) {
			return {
				allTools: this.#knownTools,
				isSubagent: false,
				directTools: configlessDirectBaseline,
				resolvedTools: this.#resolveEffectiveTools(configlessDirectBaseline, enabledServers, disabledTools),
				inheritedTools: [],
				disabledTools,
				mcpEnabledTools: this.#resolveEnabledMcpToolNames(enabledServers, disabledTools),
				mcpTools,
			};
		}

		const defaultInheritBase = this.#resolveDefaultInheritBase(role);
		if (persistedTools === undefined) {
			const inheritedTools = this.#resolveInheritedTools(defaultInheritBase);
			return {
				allTools: this.#knownTools,
				isSubagent: true,
				resolvedTools: this.#resolveEffectiveTools(inheritedTools, enabledServers, disabledTools),
				inheritedTools,
				disabledTools,
				mcpEnabledTools: this.#resolveEnabledMcpToolNames(enabledServers, disabledTools),
				mcpTools,
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
			resolvedTools: this.#resolveEffectiveTools(resolvedTools, enabledServers, disabledTools),
			inheritedTools,
			disabledTools,
			mcpEnabledTools: this.#resolveEnabledMcpToolNames(enabledServers, disabledTools),
			mcpTools,
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

		// Refresh model, MCP, skills, tools, and advanced panels in-place (preserves cursor position where possible).
		this.#modelTabPanel.update(this.#getModelPanelState(role));
		const skillConfig = (isSubagent
			? this.#rolesConfig.getSkillConfigForSubagent(role)
			: this.#rolesConfig.getSkillConfigForRole(role)) ?? { auto: [], frontmatter: [] };
		this.#skillPanel.update(this.#discoveredSkills, skillConfig);
		this.#toolsPanel.update(this.#getToolsPanelState(role));
		this.#advancedPanel.update(this.#getAdvancedPanelState(role));

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
			onServersChange: () => this.#handleMcpConfigChange(),
			onClose: () => this.#dismiss(),
		});

		this.#syncPresetState();
		this.#onRequestRender();
	}

	#getPresetHintParts(): string[] {
		if (this.#presetSelector) {
			return [];
		}
		const activePreset = this.#presetsConfig.getActivePreset();
		if (activePreset === null) {
			return [" s:save-as", " p:switch"];
		}
		const parts = [" p:switch"];
		if (this.#presetsConfig.isModified()) {
			parts.unshift(" s:save");
			if (this.#activePanel === "left" || this.#tabBar.getActiveIndex() !== 4) {
				parts.push(" r:revert");
			}
		}
		return parts;
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
		const parts: string[] = [" tab:switch-panel"];
		if (this.#activePanel === "right" && !this.#presetSelector) {
			parts.push(" ←/→:switch-tab");
			const activeTabIdx = this.#tabBar.getActiveIndex();
			if (activeTabIdx === 0) {
				parts.push(" ↑/↓:navigate  space:select");
			} else if (activeTabIdx === 1) {
				parts.push(" ↑/↓:navigate  space:toggle");
			} else if (activeTabIdx === 2) {
				parts.push(" ↑/↓:navigate  space:cycle");
			} else if (activeTabIdx === 3) {
				parts.push(
					` ↑/↓:navigate  space:${this.#isDirectSubagentToolsConfig(this.#activeRole) ? "toggle" : this.#isSubagentRole(this.#activeRole) ? "cycle" : "toggle"}`,
				);
			} else if (activeTabIdx === 4) {
				parts.push(" ↑/↓:navigate  space:cycle  enter:edit  r:reset");
			}
		} else if (!this.#presetSelector) {
			parts.push(" ↑/↓:navigate");
		}
		parts.push(...this.#getPresetHintParts());
		parts.push(" esc:close");
		lines.push(truncateToWidth(theme.fg("dim", parts.join(" ")), totalWidth));

		// ── Bottom border ──
		lines.push(...this.#border.render(totalWidth));

		return lines;
	}

	handleInput(data: string): void {
		if (this.#presetSelector) {
			this.#presetSelector.handleInput(data);
			this.#syncPresetState();
			this.#onRequestRender();
			return;
		}

		// Escape closes the modal before any panel-specific handling.
		if (matchesAppInterrupt(data)) {
			this.#dismiss();
			return;
		}

		// Tab / Shift+Tab always toggle focus between the two panels.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#activePanel = this.#activePanel === "left" ? "right" : "left";
			this.#onRequestRender();
			return;
		}

		if (this.#handlePresetShortcut(data)) {
			this.#onRequestRender();
			return;
		}

		if (this.#activePanel === "left") {
			const prevRole = this.#agentListPanel.selectedRole;
			this.#agentListPanel.handleInput(data);
			const newRole = this.#agentListPanel.selectedRole;
			if (newRole !== undefined && newRole !== prevRole) {
				this.#switchToRole(newRole);
			} else {
				this.#onRequestRender();
			}
		} else {
			if (matchesKey(data, "left") || matchesKey(data, "right")) {
				this.#tabBar.handleInput(data);
				this.#onRequestRender();
				return;
			}
			this.#activeContentPanel.handleInput?.(data);
			this.#syncPresetState();
			this.#onRequestRender();
		}
	}
}

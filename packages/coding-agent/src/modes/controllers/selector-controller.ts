import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders, modelsAreEqual, type OAuthProvider } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Input, Loader, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getAgentDbPath, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { resolveAdvancedThinkingLevel, syncAdvancedConfigToSettings } from "../../config/advanced-config";
import { MODEL_ROLE_IDS_BY_CATEGORY, MODEL_ROLES, type ModelRole } from "../../config/model-registry";
import { PresetsConfig } from "../../config/presets-config";
import { RolesConfig } from "../../config/roles-config";

import { type Settings, settings } from "../../config/settings";
import { DebugSelectorComponent } from "../../debug";
import { disableProvider, enableProvider } from "../../discovery";
import { discoverMCPServerNames } from "../../mcp/config";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { type SessionInfo, SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { discoverAgents } from "../../task/discovery";
import { parseThinkingLevel } from "../../thinking";
import {
	getManagedToolNames,
	inferMcpServerNameFromToolName,
	isCodeSearchProviderId,
	isHiddenToolName,
	isSearchProviderPreference,
	setPreferredCodeSearchProvider,
	setPreferredImageProvider,
	setPreferredSearchProvider,
} from "../../tools";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { AgentConfigModal } from "../components/agent-config";
import { PresetSelector } from "../components/agent-config/preset-selector";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { ModelSelectorComponent } from "../components/model-selector";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";

const CALLBACK_SERVER_PROVIDERS = new Set<OAuthProvider>([
	"anthropic",
	"openai-codex",
	"gitlab-duo",
	"google-gemini-cli",
	"google-antigravity",
]);

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

const MAIN_AGENT_ROLES = ["default", "ask", "orchestrator", "plan"] as const satisfies readonly ModelRole[];

type MainAgentRole = (typeof MAIN_AGENT_ROLES)[number];

function isMainAgentRole(role: string | undefined): role is MainAgentRole {
	return role === "default" || role === "ask" || role === "orchestrator" || role === "plan";
}
export class SelectorController {
	#sharedAgentConfigDir?: string;
	#sharedRolesConfig?: RolesConfig;
	#sharedPresetsConfig?: PresetsConfig;

	constructor(private ctx: InteractiveModeContext) {}

	#getAgentConfigStores(): { rolesConfig: RolesConfig; presetsConfig: PresetsConfig } {
		const agentDir = this.ctx.settings.getAgentDir();
		if (this.#sharedAgentConfigDir !== agentDir || !this.#sharedRolesConfig || !this.#sharedPresetsConfig) {
			const rolesConfig = new RolesConfig(path.join(agentDir, "roles.yml"));
			this.#sharedAgentConfigDir = agentDir;
			this.#sharedRolesConfig = rolesConfig;
			this.#sharedPresetsConfig = new PresetsConfig(
				path.join(agentDir, "presets.yml"),
				this.ctx.settings,
				rolesConfig,
				this.ctx.session.modelRegistry,
			);
			// Wire the new instance so the preset status-line segment stays current.
			this.ctx.statusLine.setPresetsConfig(this.#sharedPresetsConfig);
		}
		// Reuse one shared store instance so modal and standalone selectors stay in sync,
		// but drop cached file contents each time either surface reopens.
		this.#sharedRolesConfig.invalidateCache();
		this.#sharedPresetsConfig.invalidateCache();

		return { rolesConfig: this.#sharedRolesConfig, presetsConfig: this.#sharedPresetsConfig };
	}

	/**
	 * Eagerly create the presetsConfig and wire it to the status line.
	 * Called once at startup so the preset segment is visible immediately.
	 */
	initPresetsForStatusLine(): void {
		const agentDir = this.ctx.settings.getAgentDir();
		if (this.#sharedAgentConfigDir !== agentDir || !this.#sharedPresetsConfig) {
			const rolesConfig = new RolesConfig(path.join(agentDir, "roles.yml"));
			this.#sharedAgentConfigDir = agentDir;
			this.#sharedRolesConfig = rolesConfig;
			this.#sharedPresetsConfig = new PresetsConfig(
				path.join(agentDir, "presets.yml"),
				this.ctx.settings,
				rolesConfig,
				this.ctx.session.modelRegistry,
			);
		}
		this.ctx.statusLine.setPresetsConfig(this.#sharedPresetsConfig);
	}
	/**
	 * Applies the default preset if one is configured.
	 *
	 * @param options.forceApply - When true, applies even if a preset is already active.
	 *   Use for explicit new-session operations (/clear, extension-triggered). The startup
	 *   call passes false (default) so a resumed session's last-active preset is preserved.
	 */
	async applyDefaultPresetIfConfigured(options?: { forceApply?: boolean }): Promise<void> {
		const { presetsConfig } = this.#getAgentConfigStores();
		const defaultPreset = presetsConfig.getDefaultPreset();
		const shouldApply = defaultPreset && (options?.forceApply || !presetsConfig.getActivePreset());
		if (!shouldApply) {
			return;
		}
		try {
			await presetsConfig.applyPreset(defaultPreset);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("Unknown preset:")) {
				// Preset was deleted after being set as default — safe to skip.
				logger.warn("Default preset no longer exists, skipping", { name: defaultPreset });
			} else {
				// Unexpected failure after partial state mutation — log at error level.
				logger.error("Failed to apply default preset", { name: defaultPreset, error });
			}
		}
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}
	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			this.showSelector(done => {
				const selector = new SettingsSelectorComponent(
					{
						availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
						thinkingLevel: this.ctx.session.thinkingLevel,
						availableThemes,
						cwd: getProjectDir(),
					},
					{
						onChange: (id, value) => this.handleSettingChange(id, value),
						onThemePreview: async themeName => {
							const result = await previewTheme(themeName);
							if (result.success) {
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorTopBorder();
								this.ctx.ui.invalidate();
								this.ctx.ui.requestRender();
							}
						},
						onStatusLinePreview: previewSettings => {
							// Update status line with preview settings
							this.ctx.statusLine.updateSettings({
								preset: settings.get("statusLine.preset"),
								leftSegments: settings.get("statusLine.leftSegments"),
								rightSegments: settings.get("statusLine.rightSegments"),
								separator: settings.get("statusLine.separator"),
								showHookStatus: settings.get("statusLine.showHookStatus"),
								...previewSettings,
							});
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
						getStatusLinePreview: () => {
							// Return the rendered status line for inline preview
							const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
							return this.ctx.statusLine.getTopBorder(availableWidth).content;
						},
						onPluginsChanged: () => {
							this.ctx.ui.requestRender();
						},
						onCancel: () => {
							done();
							// Restore status line to saved settings
							this.ctx.statusLine.updateSettings({
								preset: settings.get("statusLine.preset"),
								leftSegments: settings.get("statusLine.leftSegments"),
								rightSegments: settings.get("statusLine.rightSegments"),
								separator: settings.get("statusLine.separator"),
								showHookStatus: settings.get("statusLine.showHookStatus"),
							});
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
					},
				);
				return { component: selector, focus: selector };
			});
		});
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern,
		});
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			dashboard.onRequestRender = () => {
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;

			case "clearOnShrink":
				this.ctx.ui.setClearOnShrink(value as boolean);
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinking":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(value as boolean);
					}
				}
				this.ctx.chatContainer.clear();
				this.ctx.rebuildChatFromMessages();
				break;
			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "statusLinePreset":
			case "statusLineSeparator":
			case "statusLineShowHooks":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "providers.codeSearch":
				if (typeof value === "string" && isCodeSearchProviderId(value)) {
					setPreferredCodeSearchProvider(value);
				}
				break;
			case "providers.image":
				if (value === "auto" || value === "gemini" || value === "openrouter") {
					setPreferredImageProvider(value);
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.showSelector(done => {
			const selector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async (model, role, thinkingLevel) => {
					try {
						if (role === null) {
							// Temporary: update agent state but don't persist to settings
							await this.ctx.session.setModelTemporary(model);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Temporary model: ${model.id}`);
							done();
							this.ctx.ui.requestRender();
						} else if (role === "default") {
							// Default: update agent state and persist
							await this.ctx.session.setModel(model, role);
							if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
								this.ctx.session.setThinkingLevel(thinkingLevel);
							}
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Default model: ${model.id}`);
							// Don't call done() - selector stays open for role assignment
						} else {
							// Other roles (smol, slow): just update settings, not current model
							const roleInfo = MODEL_ROLES[role];
							const roleLabel = roleInfo?.name ?? role;
							this.ctx.showStatus(`${roleLabel} model: ${model.id}`);
							// Don't call done() - selector stays open
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				options,
			);
			return { component: selector, focus: selector };
		});
	}
	showPresetSelector(): void {
		const { presetsConfig } = this.#getAgentConfigStores();
		this.showSelector(done => {
			const selector = new PresetSelector({
				presetsConfig,
				onApply: async name => {
					done();
					this.ctx.showStatus(`Applied ${name}.`);
					this.ctx.ui.requestRender();
				},
				onClose: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	#captureConfiguredMainModels(): Record<MainAgentRole, string | undefined> {
		return {
			default: this.ctx.settings.getModelRole("default"),
			ask: this.ctx.settings.getModelRole("ask"),
			orchestrator: this.ctx.settings.getModelRole("orchestrator"),
			plan: this.ctx.settings.getModelRole("plan"),
		};
	}

	#didConfiguredMainModelsChange(initialConfiguredModels: Record<MainAgentRole, string | undefined>): boolean {
		return MAIN_AGENT_ROLES.some(role => this.ctx.settings.getModelRole(role) !== initialConfiguredModels[role]);
	}

	async #refreshLiveConfiguredModel(): Promise<void> {
		const activeRole = this.ctx.sessionManager.getLastModelChangeRole();
		if (!isMainAgentRole(activeRole)) return;

		const defaultModel = activeRole === "ask" ? this.ctx.session.resolveRoleModel("default") : undefined;
		const nextModel =
			activeRole === "ask" ? this.ctx.session.resolveRoleModel("ask") ?? defaultModel : this.ctx.session.resolveRoleModel(activeRole);
		if (!nextModel) return;
		const currentModel = this.ctx.session.model;
		if (currentModel && modelsAreEqual(currentModel, nextModel)) return;

		await this.ctx.session.setModelTemporary(nextModel, activeRole);
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
	}
	async #applyLiveAgentConfigChange(
		role: ModelRole,
		section: "tools" | "advanced",
		rolesConfig: RolesConfig,
	): Promise<void> {
		if (!isMainAgentRole(role)) return;
		if (this.ctx.sessionManager.getLastModelChangeRole() !== role) return;
		const session = this.ctx.session as InteractiveModeContext["session"] & {
			settings: Settings;
			applyRoleToolAllowlist?: (role: string) => Promise<void>;
			refreshBaseSystemPrompt?: () => Promise<void>;
			setThinkingLevel?: (level: ThinkingLevel, persist?: boolean) => void;
			agent?: { temperature?: number };
		};
		if (section === "tools") {
			await session.applyRoleToolAllowlist?.(role);
			return;
		}
		const advancedConfig = rolesConfig.getAdvancedForRole(role);
		syncAdvancedConfigToSettings(session.settings, advancedConfig);
		const nextThinkingLevel =
			resolveAdvancedThinkingLevel(advancedConfig) ??
			parseThinkingLevel(this.ctx.settings.get("defaultThinkingLevel")) ??
			ThinkingLevel.Off;
		session.setThinkingLevel?.(nextThinkingLevel);
		if (session.agent) {
			session.agent.temperature = session.settings.get("temperature") ?? undefined;
		}
		await session.refreshBaseSystemPrompt?.();
	}

	async showAgentConfig(): Promise<void> {
		const initialConfiguredModels = this.#captureConfiguredMainModels();
		const { rolesConfig, presetsConfig } = this.#getAgentConfigStores();
		// Build the canonical known-server list as the union of sources that cover
		// all four namespaces where server names can be persisted:
		//  1. project-config discovery (servers in .mcp.json / mcp.json files)
		//  2. runtime-known servers from mcpManager (connected/connecting/pending)
		//  3. persisted servers for core roles (reads roles[role] in roles.yml)
		//  4. persisted servers for captain/crew roles (reads subagents[role] in roles.yml)
		//  5. the default subagent template (subagents._default, fallback for unnamed agents)
		// This prevents the modal from hiding MCP assignments that exist only in roles.yml
		// and are no longer present in project config or the current runtime session.
		const discovered = await discoverMCPServerNames(
			this.ctx.settings.getCwd(),
			this.ctx.settings.get("mcp.enableProjectConfig") ?? true,
		).catch(() => []);
		const runtimeServers = this.ctx.mcpManager?.getAllServerNames() ?? [];
		const coreRoleServers = MODEL_ROLE_IDS_BY_CATEGORY.core.flatMap(role => rolesConfig.getMcpForRole(role));
		const subagentRoleServers = [...MODEL_ROLE_IDS_BY_CATEGORY.captain, ...MODEL_ROLE_IDS_BY_CATEGORY.crew].flatMap(
			role => rolesConfig.getMcpForSubagent(role),
		);
		const defaultSubagentServers = rolesConfig.getMcpForSubagent("_default");
		const knownMcpServers = [
			...new Set([
				...discovered,
				...runtimeServers,
				...coreRoleServers,
				...subagentRoleServers,
				...defaultSubagentServers,
			]),
		];
		const { agents } = await discoverAgents(this.ctx.settings.getCwd());
		const subagentDefaultTools = Object.fromEntries(
			agents.filter(agent => agent.tools !== undefined).map(agent => [agent.name, [...(agent.tools ?? [])]]),
		) as Partial<Record<string, string[]>>;
		const rolesSnapshot = rolesConfig.getFullConfig();
		const runtimeMcpTools = this.ctx.mcpManager?.getTools?.() ?? [];
		const mcpToolServerNames = Object.fromEntries(
			runtimeMcpTools.flatMap(tool => {
				const name =
					typeof (tool as { name?: unknown }).name === "string" ? (tool as { name: string }).name : undefined;
				if (!name) return [];
				const serverName =
					typeof (tool as { mcpServerName?: unknown }).mcpServerName === "string"
						? ((tool as { mcpServerName: string }).mcpServerName ?? undefined)
						: inferMcpServerNameFromToolName(name, knownMcpServers);
				return serverName ? [[name, serverName] as const] : [];
			}),
		) as Record<string, string>;
		const configuredSubagentTools = Object.values(rolesSnapshot.subagents).flatMap(subagentConfig => {
			if (subagentConfig.tools === undefined) return [];
			if (Array.isArray(subagentConfig.tools)) return subagentConfig.tools.filter(tool => !isHiddenToolName(tool));
			return [...(subagentConfig.tools.add ?? []), ...(subagentConfig.tools.remove ?? [])].filter(
				tool => !isHiddenToolName(tool),
			);
		});
		const configuredDisabledTools = [
			...Object.values(rolesSnapshot.roles).flatMap(roleConfig => roleConfig.disabledTools ?? []),
			...Object.values(rolesSnapshot.subagents).flatMap(subagentConfig => subagentConfig.disabledTools ?? []),
		];
		const knownTools = [
			...new Set([
				...getManagedToolNames(),
				...agents.flatMap(agent => (agent.tools ?? []).filter(tool => !isHiddenToolName(tool))),
				...Object.values(rolesSnapshot.roles).flatMap(roleConfig =>
					roleConfig.tools.filter(tool => !isHiddenToolName(tool)),
				),
				...configuredSubagentTools,
				...runtimeMcpTools.flatMap(tool => {
					const name =
						typeof (tool as { name?: unknown }).name === "string" ? (tool as { name: string }).name : undefined;
					return name ? [name] : [];
				}),
				...configuredDisabledTools,
			]),
		];

		const discoveredSkills = [...this.ctx.session.skills];
		this.showSelector(done => {
			const modal = new AgentConfigModal({
				settings: this.ctx.settings,
				rolesConfig,
				modelRegistry: this.ctx.session.modelRegistry,
				presetsConfig,
				knownTools,
				subagentDefaultTools,
				knownMcpServers,
				mcpToolServerNames,
				onRoleConfigChanged: (role, section) => {
					void this.#applyLiveAgentConfigChange(role, section, rolesConfig);
				},

				discoveredSkills,
				onDismiss: async () => {
					done();
					this.ctx.ui.requestRender();
					if (!this.#didConfiguredMainModelsChange(initialConfiguredModels)) return;
					try {
						await this.#refreshLiveConfiguredModel();
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onRequestRender: () => {
					this.ctx.ui.requestRender();
				},
				onShowStatus: message => {
					this.ctx.showStatus(message);
				},
				onShowError: message => {
					this.ctx.showError(message);
				},
			});
			return { component: modal, focus: modal };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.handleSessionRootChange();

					this.ctx.chatContainer.clear();
					this.ctx.renderInitialMessages();
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.ctx.chatContainer.clear();
						this.ctx.renderInitialMessages();
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.clear();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
		this.showSelector(done => {
			const selector = new SessionSelectorComponent(
				sessions,
				async sessionPath => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				() => {
					void this.ctx.shutdown();
				},
				async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
						return true;
					} catch (err) {
						throw new Error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, {
							cause: err,
						});
					}
				},
			);
			selector.setOnRequestRender(() => this.ctx.ui.requestRender());
			return { component: selector, focus: selector };
		});
	}

	#clearTransientSessionUi(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.clear();
		this.ctx.pendingMessagesContainer.clear();
		this.ctx.compactionQueuedMessages = [];
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		this.ctx.pendingTools.clear();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.#clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.renderInitialMessages();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.#clearTransientSessionUi();

		// Switch session via AgentSession (emits hook and tool session events)
		await this.ctx.session.switchSession(sessionPath);
		this.ctx.handleSessionRootChange();
		this.#refreshSessionTerminalTitle();

		// Clear and re-render the chat
		this.ctx.chatContainer.clear();
		this.ctx.renderInitialMessages();
		await this.ctx.reloadTodos();
		this.ctx.showStatus("Resumed session");
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	async #handleOAuthLogin(providerId: string): Promise<void> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = CALLBACK_SERVER_PROVIDERS.has(providerId as OAuthProvider);
		try {
			await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				onAuth: (info: { url: string; instructions?: string }) => {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(new Text(theme.fg("dim", info.url), 1, 0));
					const hyperlink = `\x1b]8;;${info.url}\x07Click here to login\x1b]8;;\x07`;
					this.ctx.chatContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
					if (info.instructions) {
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
					}
					if (useManualInput) {
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(new Text(theme.fg("dim", MANUAL_LOGIN_TIP), 1, 0));
					}
					this.ctx.ui.requestRender();
					this.ctx.openInBrowser(info.url);
				},
				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(new Text(theme.fg("warning", prompt.message), 1, 0));
					if (prompt.placeholder) {
						this.ctx.chatContainer.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
					}
					this.ctx.ui.requestRender();
					const { promise, resolve } = Promise.withResolvers<string>();
					const codeInput = new Input();
					codeInput.onSubmit = () => {
						const code = codeInput.getValue();
						this.ctx.editorContainer.clear();
						this.ctx.editorContainer.addChild(this.ctx.editor);
						this.ctx.ui.setFocus(this.ctx.editor);
						resolve(code);
					};
					this.ctx.editorContainer.clear();
					this.ctx.editorContainer.addChild(codeInput);
					this.ctx.ui.setFocus(codeInput);
					this.ctx.ui.requestRender();
					return promise;
				},
				onProgress: (message: string) => {
					this.ctx.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
					this.ctx.ui.requestRender();
				},
				onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
			});
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
		}
	}

	async #handleOAuthLogout(providerId: string): Promise<void> {
		try {
			await this.ctx.session.modelRegistry.authStorage.logout(providerId);
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged out of ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", `Credentials removed from ${getAgentDbPath()}`), 1, 0),
			);
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#handleOAuthLogout(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.hasAuth(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#handleOAuthLogout(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	showDebugSelector(): void {
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}
}

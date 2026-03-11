import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getSupportedEfforts, type Model, modelsAreEqual } from "@oh-my-pi/pi-ai";
import { Container, Input, matchesKey, Spacer, type Tab, TabBar, Text, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { MODEL_ROLE_IDS, MODEL_ROLES, type ModelRegistry, type ModelRole } from "../../config/model-registry";
import { resolveModelRoleValue } from "../../config/model-resolver";
import { RolesConfig } from "../../config/roles-config";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { fuzzyFilter } from "../../utils/fuzzy";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";

function makeInvertedBadge(label: string, color: ThemeColor): string {
	const fgAnsi = theme.getFgAnsi(color);
	const bgAnsi = fgAnsi.replace(/\x1b\[38;/g, "\x1b[48;");
	return `${bgAnsi}\x1b[30m ${label} \x1b[39m\x1b[49m`;
}

function formatDisplayId(id: string): string {
	return /^gpt-/i.test(id) ? `GPT-${id.slice(4)}` : id;
}

interface ModelItem {
	provider: string;
	id: string;
	model: Model;
}

interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;
}

interface PendingRoleSelection {
	model: Model;
	role: ModelRole;
	thinkingLevel: ThinkingLevel;
}

type RoleSelectCallback = (model: Model, role: ModelRole | null, thinkingLevel?: ThinkingLevel) => void;
type CancelCallback = () => void;

const ALL_TAB = "ALL";

export class ModelSelectorComponent extends Container {
	#searchInput: Input;
	#headerContainer: Container;
	#summaryContainer: Container;
	#searchContainer: Container;
	#tabBar: TabBar | null = null;
	#listContainer: Container;
	#menuContainer: Container;
	#allModels: ModelItem[] = [];
	#filteredModels: ModelItem[] = [];
	#selectedIndex: number = 0;
	#selectedRoleIndex: number = 0;
	#roles = {} as Record<ModelRole, RoleAssignment | undefined>;
	#settings = null as unknown as Settings;
	#rolesConfig: RolesConfig;
	#modelRegistry = null as unknown as ModelRegistry;
	#onSelectCallback = (() => {}) as RoleSelectCallback;
	#onCancelCallback = (() => {}) as CancelCallback;
	#errorMessage?: unknown;
	#tui: TUI;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#temporaryOnly: boolean;
	#editingRole: ModelRole | null = null;
	#isThinkingMenuOpen: boolean = false;
	#isMcpMenuOpen: boolean = false;
	#menuSelectedIndex: number = 0;
	#mcpServers: string[] = [];
	#mcpSelectedServers = new Set<string>();
	#pendingRoleSelection: PendingRoleSelection | null = null;
	// Tab state
	#providers: string[] = [ALL_TAB];
	#activeTabIndex: number = 0;

	constructor(
		tui: TUI,
		_currentModel: Model | undefined,
		settings: Settings,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model, role: ModelRole | null, thinkingLevel?: ThinkingLevel) => void,
		onCancel: () => void,
		options?: { temporaryOnly?: boolean; initialSearchInput?: string },
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#rolesConfig = new RolesConfig(path.join(this.#settings.getAgentDir(), "roles.yml"));
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		const initialSearchInput = options?.initialSearchInput;
		if (this.#temporaryOnly) {
			this.#editingRole = null;
		}

		this.#loadRoleModels();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const hintText =
			scopedModels.length > 0
				? "Showing models from --models scope"
				: "Only showing models with configured API keys (see README for details)";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		this.#headerContainer = new Container();
		this.addChild(this.#headerContainer);
		this.addChild(new Spacer(1));

		this.#summaryContainer = new Container();
		this.addChild(this.#summaryContainer);
		this.addChild(new Spacer(1));

		this.#searchContainer = new Container();
		this.addChild(this.#searchContainer);
		this.addChild(new Spacer(1));

		this.#searchInput = new Input();
		if (initialSearchInput) {
			this.#searchInput.setValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			if (this.#isRoleSummaryMode()) {
				this.#enterRoleModelBrowser();
				return;
			}

			const selectedModel = this.#filteredModels[this.#selectedIndex];
			if (!selectedModel) return;
			if (this.#temporaryOnly) {
				this.#handleSelect(selectedModel.model, null);
				return;
			}
			this.#openThinkingMenu();
		};

		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		this.#menuContainer = new Container();
		this.addChild(this.#menuContainer);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#loadModels().then(() => {
			this.#buildProviderTabs();
			this.#updateTabBar();
			if (this.#temporaryOnly) {
				const currentQuery = this.#searchInput.getValue();
				if (currentQuery) {
					this.#filterModels(currentQuery);
				} else {
					this.#updateView();
				}
			} else {
				this.#updateView();
			}
			this.#tui.requestRender();
		});
	}

	#isRoleSummaryMode(): boolean {
		return !this.#temporaryOnly && this.#editingRole === null;
	}

	#selectedRole(): ModelRole {
		return MODEL_ROLE_IDS[this.#selectedRoleIndex] ?? MODEL_ROLE_IDS[0]!;
	}

	#loadRoleModels(): void {
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		for (const role of MODEL_ROLE_IDS) {
			const roleValue = this.#settings.getModelRole(role);
			if (!roleValue) continue;

			const { model, thinkingLevel, explicitThinkingLevel } = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
			});
			if (model) {
				this.#roles[role] = {
					model,
					thinkingLevel:
						explicitThinkingLevel && thinkingLevel !== undefined ? thinkingLevel : ThinkingLevel.Inherit,
				};
			}
		}
	}

	#sortModels(models: ModelItem[]): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (model: ModelItem) => {
			let i = 0;
			while (i < MODEL_ROLE_IDS.length) {
				const role = MODEL_ROLE_IDS[i];
				const assigned = this.#roles[role];
				if (assigned && modelsAreEqual(assigned.model, model.model)) {
					break;
				}
				i++;
			}
			return i;
		};

		const dateRe = /-(\d{8})$/;
		const latestRe = /-latest$/;

		models.sort((a, b) => {
			const aKey = `${a.provider}/${a.id}`;
			const bKey = `${b.provider}/${b.id}`;

			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			const aMru = mruIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;

			const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
			const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
			if (aPri !== bPri) return aPri - bPri;

			const aVer = extractVersionNumber(a.id);
			const bVer = extractVersionNumber(b.id);
			if (aVer !== bVer) return bVer - aVer;

			const aIsLatest = latestRe.test(a.id);
			const bIsLatest = latestRe.test(b.id);
			const aDate = a.id.match(dateRe)?.[1] ?? "";
			const bDate = b.id.match(dateRe)?.[1] ?? "";

			const aHasRecency = aIsLatest || aDate !== "";
			const bHasRecency = bIsLatest || bDate !== "";
			if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;
			if (!aHasRecency) return a.id.localeCompare(b.id);
			if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;
			if (aDate && bDate) return bDate.localeCompare(aDate);
			return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
		});
	}

	async #loadModels(): Promise<void> {
		let models: ModelItem[];

		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			}));
		} else {
			await this.#modelRegistry.refresh();
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			}

			try {
				const availableModels = this.#modelRegistry.getAvailable();
				models = availableModels.map((model: Model) => ({
					provider: model.provider,
					id: model.id,
					model,
				}));
			} catch (error) {
				this.#allModels = [];
				this.#filteredModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		this.#sortModels(models);
		this.#allModels = models;
		this.#filteredModels = models;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, models.length - 1));
	}

	#buildProviderTabs(): void {
		const providerSet = new Set<string>();
		for (const item of this.#allModels) {
			providerSet.add(item.provider.toUpperCase());
		}
		const sortedProviders = Array.from(providerSet).sort();
		this.#providers = [ALL_TAB, ...sortedProviders];
	}

	#updateTabBar(): void {
		this.#headerContainer.clear();
		if (this.#isRoleSummaryMode()) return;

		const tabs: Tab[] = this.#providers.map(provider => ({ id: provider, label: provider }));
		const tabBar = new TabBar("Providers", tabs, getTabBarTheme(), this.#activeTabIndex);
		tabBar.onTabChange = (_tab, index) => {
			this.#activeTabIndex = index;
			this.#selectedIndex = 0;
			this.#applyTabFilter();
		};
		this.#tabBar = tabBar;
		this.#headerContainer.addChild(tabBar);
	}

	#getActiveProvider(): string {
		return this.#providers[this.#activeTabIndex] ?? ALL_TAB;
	}

	#filterModels(query: string): void {
		const activeProvider = this.#getActiveProvider();
		let baseModels = this.#allModels;
		if (activeProvider !== ALL_TAB) {
			baseModels = this.#allModels.filter(m => m.provider.toUpperCase() === activeProvider);
		}

		if (query.trim()) {
			if (activeProvider !== ALL_TAB) {
				this.#activeTabIndex = 0;
				if (this.#tabBar && this.#tabBar.getActiveIndex() !== 0) {
					this.#tabBar.setActiveIndex(0);
					return;
				}
				this.#updateTabBar();
				baseModels = this.#allModels;
			}
			const fuzzyMatches = fuzzyFilter(baseModels, query, ({ id, provider }) => `${id} ${provider}`);
			this.#sortModels(fuzzyMatches);
			this.#filteredModels = fuzzyMatches;
		} else {
			this.#filteredModels = baseModels;
		}

		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredModels.length - 1));
		this.#syncSelectedModelToRole();
		this.#updateView();
	}

	#applyTabFilter(): void {
		const query = this.#searchInput.getValue();
		this.#filterModels(query);
	}

	#syncSelectedModelToRole(): void {
		if (!this.#editingRole) return;
		const assignedModel = this.#roles[this.#editingRole]?.model;
		if (!assignedModel) {
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredModels.length - 1));
			return;
		}
		const matchedIndex = this.#filteredModels.findIndex(item => modelsAreEqual(item.model, assignedModel));
		this.#selectedIndex =
			matchedIndex >= 0 ? matchedIndex : Math.min(this.#selectedIndex, Math.max(0, this.#filteredModels.length - 1));
	}

	#formatCurrentAssignment(role: ModelRole): string {
		const assignment = this.#roles[role];
		if (!assignment) return "unassigned";
		const modelKey = `${assignment.model.provider}/${assignment.model.id}`;
		const thinkingLabel = getThinkingLevelMetadata(assignment.thinkingLevel).label;
		return `${modelKey} (${thinkingLabel})`;
	}

	#updateRoleSummary(): void {
		this.#headerContainer.clear();
		this.#searchContainer.clear();
		this.#listContainer.clear();
		this.#menuContainer.clear();
		this.#summaryContainer.clear();
		this.#tabBar = null;

		this.#summaryContainer.addChild(new Text(theme.bold("Model Roles:"), 1, 0));
		this.#summaryContainer.addChild(new Spacer(1));

		for (let index = 0; index < MODEL_ROLE_IDS.length; index++) {
			const role = MODEL_ROLE_IDS[index]!;
			const roleInfo = MODEL_ROLES[role];
			const isSelected = index === this.#selectedRoleIndex;
			const prefix = isSelected ? `${theme.nav.cursor} ` : "  ";
			const tag = roleInfo.tag ?? role.toUpperCase();
			const line = `${prefix}${theme.bold(tag)} ${roleInfo.name} ${this.#formatCurrentAssignment(role)}`;
			this.#summaryContainer.addChild(new Text(isSelected ? theme.fg("accent", line) : line, 0, 0));
		}

		this.#listContainer.addChild(new Text(theme.fg("dim", "  enter choose role  esc cancel"), 0, 0));
	}

	#updateModelList(hintText: string): void {
		this.#listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredModels.length);

		const activeProvider = this.#getActiveProvider();
		const showProvider = activeProvider === ALL_TAB;

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.#filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.#selectedIndex;
			const roleBadgeTokens: string[] = [];
			for (const role of MODEL_ROLE_IDS) {
				const { tag, color } = MODEL_ROLES[role];
				const assigned = this.#roles[role];
				if (!tag || !assigned || !modelsAreEqual(assigned.model, item.model)) continue;
				const badge = makeInvertedBadge(tag, color ?? "success");
				const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
				roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
			}

			const badgeText = roleBadgeTokens.length > 0 ? ` ${roleBadgeTokens.join(" ")}` : "";
			const displayId = formatDisplayId(item.id);
			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				if (showProvider) {
					const providerPrefix = theme.fg("dim", `${item.provider}/`);
					line = `${prefix}${providerPrefix}${theme.fg("accent", displayId)}${badgeText}`;
				} else {
					line = `${prefix}${theme.fg("accent", displayId)}${badgeText}`;
				}
			} else {
				const prefix = "  ";
				if (showProvider) {
					const providerPrefix = theme.fg("dim", `${item.provider}/`);
					line = `${prefix}${providerPrefix}${displayId}${badgeText}`;
				} else {
					line = `${prefix}${displayId}${badgeText}`;
				}
			}
			this.#listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.#filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${this.#filteredModels.length})`);
			this.#listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		if (this.#errorMessage) {
			const errorLines = String(this.#errorMessage).split("\n");
			for (const line of errorLines) {
				this.#listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.#filteredModels.length === 0) {
			this.#listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.#filteredModels[this.#selectedIndex];
			this.#listContainer.addChild(new Spacer(1));
			if (selected) {
				const selectedDisplayName = selected.model.name
					? formatDisplayId(selected.model.name)
					: formatDisplayId(selected.model.id);
				this.#listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selectedDisplayName}`), 0, 0));
			}
		}

		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(new Text(theme.fg("dim", `  ${hintText}`), 0, 0));
	}

	#updateModelBrowser(): void {
		this.#summaryContainer.clear();
		this.#searchContainer.clear();
		this.#menuContainer.clear();
		this.#updateTabBar();
		this.#searchContainer.addChild(this.#searchInput);

		if (!this.#temporaryOnly && this.#editingRole) {
			const roleInfo = MODEL_ROLES[this.#editingRole];
			this.#summaryContainer.addChild(new Text(theme.bold(`Editing ${roleInfo.name}`), 1, 0));
			this.#summaryContainer.addChild(
				new Text(theme.fg("dim", `Current: ${this.#formatCurrentAssignment(this.#editingRole)}`), 1, 0),
			);
		}

		const hintText = this.#temporaryOnly
			? "tab/←/→ providers  up/down models  enter select  esc cancel"
			: "tab/←/→ providers  up/down models  enter choose  esc back";
		this.#updateModelList(hintText);
	}

	#updateView(): void {
		if (this.#isRoleSummaryMode()) {
			this.#updateRoleSummary();
			return;
		}
		this.#updateModelBrowser();
		if (this.#isThinkingMenuOpen) {
			this.#updateThinkingMenu();
		} else if (this.#isMcpMenuOpen) {
			this.#updateMcpMenu();
		}
	}

	#getThinkingLevelsForModel(model: Model): ReadonlyArray<ThinkingLevel> {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
	}

	#getCurrentRoleThinkingLevel(role: ModelRole): ThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}

	#getThinkingPreselectIndex(role: ModelRole, model: Model): number {
		const options = this.#getThinkingLevelsForModel(model);
		const currentLevel = this.#getCurrentRoleThinkingLevel(role);
		const foundIndex = options.indexOf(currentLevel);
		return foundIndex >= 0 ? foundIndex : 0;
	}

	#enterRoleModelBrowser(): void {
		this.#editingRole = this.#selectedRole();
		this.#isThinkingMenuOpen = false;
		this.#isMcpMenuOpen = false;
		this.#pendingRoleSelection = null;
		this.#searchInput.setValue("");
		this.#activeTabIndex = 0;
		this.#selectedIndex = 0;
		this.#applyTabFilter();
	}

	#openThinkingMenu(): void {
		if (!this.#editingRole) return;
		const selectedModel = this.#filteredModels[this.#selectedIndex];
		if (!selectedModel) return;
		this.#isThinkingMenuOpen = true;
		this.#menuSelectedIndex = this.#getThinkingPreselectIndex(this.#editingRole, selectedModel.model);
		this.#updateView();
	}

	#closeThinkingMenu(): void {
		this.#isThinkingMenuOpen = false;
		this.#menuContainer.clear();
	}

	#updateThinkingMenu(): void {
		this.#menuContainer.clear();
		const selectedModel = this.#filteredModels[this.#selectedIndex];
		const selectedRole = this.#editingRole;
		if (!selectedModel || !selectedRole) return;

		const thinkingOptions = this.#getThinkingLevelsForModel(selectedModel.model);
		const optionLines = thinkingOptions.map((thinkingLevel, index) => {
			const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
			const label = getThinkingLevelMetadata(thinkingLevel).label;
			return `${prefix}${label}`;
		});

		const roleName = MODEL_ROLES[selectedRole].name;
		const headerText = `  Thinking for: ${roleName} (${selectedModel.id})`;
		const hintText = "  Enter: confirm  Esc: back";
		const menuWidth = Math.max(
			visibleWidth(headerText),
			visibleWidth(hintText),
			...optionLines.map(line => visibleWidth(line)),
		);

		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
		this.#menuContainer.addChild(
			new Text(theme.fg("text", `  Thinking for: ${theme.bold(roleName)} (${theme.bold(selectedModel.id)})`), 0, 0),
		);
		this.#menuContainer.addChild(new Spacer(1));
		for (let i = 0; i < optionLines.length; i++) {
			const lineText = optionLines[i];
			if (!lineText) continue;
			const isSelected = i === this.#menuSelectedIndex;
			const line = isSelected ? theme.fg("accent", lineText) : theme.fg("muted", lineText);
			this.#menuContainer.addChild(new Text(line, 0, 0));
		}
		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
	}

	#openMcpMenu(model: Model, role: ModelRole, thinkingLevel: ThinkingLevel): void {
		this.#pendingRoleSelection = { model, role, thinkingLevel };
		this.#mcpServers = this.#rolesConfig.getKnownMcpServers();
		this.#mcpSelectedServers = new Set(this.#rolesConfig.getMcpForRole(role));
		this.#menuSelectedIndex = 0;
		this.#isThinkingMenuOpen = false;
		this.#isMcpMenuOpen = true;
		this.#updateView();
	}

	#closeMcpMenu(): void {
		this.#isMcpMenuOpen = false;
		this.#menuContainer.clear();
	}

	#updateMcpMenu(): void {
		this.#menuContainer.clear();
		const pending = this.#pendingRoleSelection;
		if (!pending) return;
		const roleName = MODEL_ROLES[pending.role].name;
		const optionLines = this.#mcpServers.map((serverName, index) => {
			const prefix = index === this.#menuSelectedIndex ? `  ${theme.nav.cursor} ` : "    ";
			const checked = this.#mcpSelectedServers.has(serverName) ? "[x]" : "[ ]";
			const lockLabel = serverName === "augment" ? theme.fg("dim", " (required)") : "";
			return `${prefix}${checked} ${serverName}${lockLabel}`;
		});
		const headerText = `  MCP for: ${roleName} (${pending.model.id})`;
		const hintText = "  Space: toggle  Enter: confirm  Esc: back";
		const restartWarning = "  MCP server changes require session restart to take effect";
		const menuWidth = Math.max(
			visibleWidth(headerText),
			visibleWidth(hintText),
			visibleWidth(restartWarning),
			...optionLines.map(line => visibleWidth(line)),
		);
		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("text", `  MCP for: ${theme.bold(roleName)} (${theme.bold(pending.model.id)})`), 0, 0));
		this.#menuContainer.addChild(new Spacer(1));
		for (let i = 0; i < optionLines.length; i++) {
			const lineText = optionLines[i];
			if (!lineText) continue;
			const isSelected = i === this.#menuSelectedIndex;
			const line = isSelected ? theme.fg("accent", lineText) : theme.fg("muted", lineText);
			this.#menuContainer.addChild(new Text(line, 0, 0));
		}
		this.#menuContainer.addChild(new Spacer(1));
		this.#menuContainer.addChild(new Text(theme.fg("warning", restartWarning), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("dim", hintText), 0, 0));
		this.#menuContainer.addChild(new Text(theme.fg("border", theme.boxSharp.horizontal.repeat(menuWidth)), 0, 0));
	}

	#handleMcpMenuInput(keyData: string): void {
		const optionCount = this.#mcpServers.length;
		if (optionCount === 0) return;
		if (matchesKey(keyData, "up")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex - 1 + optionCount) % optionCount;
			this.#updateView();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex + 1) % optionCount;
			this.#updateView();
			return;
		}
		if (keyData === " " || matchesKey(keyData, "space")) {
			const serverName = this.#mcpServers[this.#menuSelectedIndex];
			if (!serverName || serverName === "augment") return;
			if (this.#mcpSelectedServers.has(serverName)) {
				this.#mcpSelectedServers.delete(serverName);
			} else {
				this.#mcpSelectedServers.add(serverName);
			}
			this.#updateView();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const pending = this.#pendingRoleSelection;
			if (!pending) return;
			this.#rolesConfig.setMcpForRole(pending.role, Array.from(this.#mcpSelectedServers));
			this.#closeMcpMenu();
			this.#pendingRoleSelection = null;
			this.#handleSelect(pending.model, pending.role, pending.thinkingLevel);
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.#closeMcpMenu();
			this.#pendingRoleSelection = null;
			this.#isThinkingMenuOpen = true;
			this.#updateView();
		}
	}

	handleInput(keyData: string): void {
		if (this.#isMcpMenuOpen) {
			this.#handleMcpMenuInput(keyData);
			return;
		}
		if (this.#isThinkingMenuOpen) {
			this.#handleThinkingMenuInput(keyData);
			return;
		}

		if (this.#isRoleSummaryMode()) {
			this.#handleRoleSummaryInput(keyData);
			return;
		}

		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}

		if (matchesKey(keyData, "up")) {
			if (this.#filteredModels.length === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredModels.length - 1 : this.#selectedIndex - 1;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "down")) {
			if (this.#filteredModels.length === 0) return;
			this.#selectedIndex = this.#selectedIndex === this.#filteredModels.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedModel = this.#filteredModels[this.#selectedIndex];
			if (!selectedModel) return;
			if (this.#temporaryOnly) {
				this.#handleSelect(selectedModel.model, null);
				return;
			}
			this.#openThinkingMenu();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			if (this.#temporaryOnly) {
				this.#onCancelCallback();
				return;
			}
			this.#editingRole = null;
			this.#closeMcpMenu();
			this.#closeThinkingMenu();
			this.#pendingRoleSelection = null;
			this.#updateView();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}

	#handleRoleSummaryInput(keyData: string): void {
		if (matchesKey(keyData, "up")) {
			this.#selectedRoleIndex =
				this.#selectedRoleIndex === 0 ? MODEL_ROLE_IDS.length - 1 : this.#selectedRoleIndex - 1;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#selectedRoleIndex =
				this.#selectedRoleIndex === MODEL_ROLE_IDS.length - 1 ? 0 : this.#selectedRoleIndex + 1;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#enterRoleModelBrowser();
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.#onCancelCallback();
		}
	}

	#handleThinkingMenuInput(keyData: string): void {
		const selectedModel = this.#filteredModels[this.#selectedIndex];
		const selectedRole = this.#editingRole;
		if (!selectedModel || !selectedRole) return;

		const optionCount = this.#getThinkingLevelsForModel(selectedModel.model).length;
		if (optionCount === 0) return;

		if (matchesKey(keyData, "up")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex - 1 + optionCount) % optionCount;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#menuSelectedIndex = (this.#menuSelectedIndex + 1) % optionCount;
			this.#updateView();
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const thinkingOptions = this.#getThinkingLevelsForModel(selectedModel.model);
			const thinkingLevel = thinkingOptions[this.#menuSelectedIndex];
			if (!thinkingLevel) return;
			this.#openMcpMenu(selectedModel.model, selectedRole, thinkingLevel);
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+c")) {
			this.#closeThinkingMenu();
			this.#updateView();
		}
	}

	#formatRoleModelValue(model: Model, thinkingLevel: ThinkingLevel): string {
		const modelKey = `${model.provider}/${model.id}`;
		if (thinkingLevel === ThinkingLevel.Inherit) return modelKey;
		return `${modelKey}:${thinkingLevel}`;
	}

	#handleSelect(model: Model, role: ModelRole | null, thinkingLevel?: ThinkingLevel): void {
		if (role === null) {
			this.#onSelectCallback(model, null);
			return;
		}

		const selectedThinkingLevel = thinkingLevel ?? this.#getCurrentRoleThinkingLevel(role);
		this.#settings.setModelRole(role, this.#formatRoleModelValue(model, selectedThinkingLevel));
		this.#roles[role] = { model, thinkingLevel: selectedThinkingLevel };
		this.#onSelectCallback(model, role, selectedThinkingLevel);
		this.#editingRole = null;
		this.#pendingRoleSelection = null;
		this.#closeMcpMenu();
		this.#closeThinkingMenu();
		this.#updateView();
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
}

/** Extract the first version number from a model ID (e.g. "gemini-2.5-pro" → 2.5, "claude-sonnet-4-6" → 4.6). */
function extractVersionNumber(id: string): number {
	// Dot-separated version: "gemini-2.5-pro" → 2.5
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	// Dash-separated short segments: "claude-sonnet-4-6" → 4.6, "llama-3-1-8b" → 3.1
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	// Single number after separator: "gpt-4o" → 4
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}

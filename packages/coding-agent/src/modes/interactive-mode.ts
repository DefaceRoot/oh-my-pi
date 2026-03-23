/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as path from "node:path";
import { type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, UsageReport } from "@oh-my-pi/pi-ai";
import type { Component, Loader, OverlayHandle, SlashCommand, TerminalMouseEvent } from "@oh-my-pi/pi-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TUI,
} from "@oh-my-pi/pi-tui";
import { $env, isEnoent, logger, parseJsonlLenient, postmortem } from "@oh-my-pi/pi-utils";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";
import { KeybindingsManager } from "../config/keybindings";
import { parseModelString } from "../config/model-resolver";
import { renderPromptTemplate } from "../config/prompt-templates";
import { type Settings, settings } from "../config/settings";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../internal-urls";
import type { MCPManager } from "../mcp";
import { mergePlanModeMainAgentTools } from "../plan-mode/main-agent-tools";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import {
	getRecentSessions,
	type SessionContext,
	type SessionEntry,
	type SessionInitEntry,
	SessionManager,
} from "../session/session-manager";
import { resumeSubagentRuntime, stopSubagentRuntime } from "../task/subagent-runtime-registry";
import { buildUserStoppedAbortReason } from "../task/subagent-stop";
import { TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, TASK_SUBAGENT_STOP_REQUEST_CHANNEL } from "../task/types";
import type { ExitPlanModeDetails } from "../tools";
import { shortenPath } from "../tools/render-utils";
import { getModifiedFiles } from "../utils/git-diff-summary";
import { setTerminalTitle } from "../utils/title-generator";
import { getTotalUsageTokens } from "../utils/usage-tokens";
import {
	ACTION_BUTTONS,
	type ActionButtonUi,
	FORK_MERGE_BUTTON,
	getActionButtonAtMouse,
	hasSameVisibleText,
	LAZYGIT_BUTTON,
	WORKTREE_MENU_BUTTON,
} from "./action-buttons";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import type { PythonExecutionComponent } from "./components/python-execution";
import type { SidebarModel, SidebarSubagent } from "./components/sidebar/model";
import { SidebarPanelComponent } from "./components/sidebar/sidebar-panel";
import { StatusLineComponent } from "./components/status-line";
import { SubagentSessionViewerComponent } from "./components/subagent-session-viewer";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { WelcomeComponent } from "./components/welcome";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { SelectorController } from "./controllers/selector-controller";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { ResumeModal } from "./resume-modal/resume-modal";
import { SubagentIndex } from "./subagent-view/subagent-index";
import { SubagentNavigatorModal } from "./subagent-view/subagent-navigator-modal";
import { SubagentArtifactsWatchManager } from "./subagent-view/subagent-watch";
import { extractTaskContextPreview } from "./subagent-view/task-preview";
import type {
	SubagentIndexSnapshot,
	SubagentNavigatorSelection,
	SubagentViewGroup,
	SubagentViewRef,
} from "./subagent-view/types";
import { setMermaidRenderCallback } from "./theme/mermaid-cache";
import type { Theme, ThemeColor } from "./theme/theme";
import { getEditorTheme, getMarkdownTheme, onThemeChange, theme } from "./theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, TodoItem } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

/** Conditional startup debug prints (stderr) when PI_DEBUG_STARTUP is set */
const debugStartup = $env.PI_DEBUG_STARTUP ? (stage: string) => process.stderr.write(`[startup] ${stage}\n`) : () => {};

const TODO_FILE_NAME = "todos.json";
const SUBAGENT_VIEWER_STATUS_KEY = "subagent-viewer";
const SIDEBAR_WIDTH = 38;
const SIDEBAR_MIN_WIDTH = 120;
const SIDEBAR_SUBAGENT_LIMIT = 8;
const SIDEBAR_MODIFIED_FILES_REFRESH_MS = 5_000;

const SUBAGENT_EMPTY_STATE_MESSAGE = "No subagent transcripts found in this session yet.";
type SubagentRefreshReason = "manual" | "watch" | "bootstrap";

type SidebarSessionLspServer = {
	name: string;
	status: "ready" | "error";
	fileTypes: string[];
	error?: string;
};

type SidebarMcpToolRef = {
	name: string;
	mcpServerName?: string;
};

export function getActiveSidebarMcpServers(
	activeToolNames: string[],
	mcpManager?: {
		getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
		getTools(): SidebarMcpToolRef[];
	},
): SidebarModel["mcpServers"] {
	if (!mcpManager) return undefined;

	const activeToolSet = new Set(activeToolNames);
	const serverNames = new Set<string>();
	for (const tool of mcpManager.getTools() as SidebarMcpToolRef[]) {
		if (!tool.mcpServerName || !activeToolSet.has(tool.name)) continue;
		if (mcpManager.getConnectionStatus(tool.mcpServerName) === "connected") {
			serverNames.add(tool.mcpServerName);
		}
	}

	const servers = Array.from(serverNames)
		.sort((left, right) => left.localeCompare(right))
		.map(name => ({ name, connected: true }));

	return servers.length > 0 ? servers : undefined;
}

export function getActiveSidebarLspServers(
	lspServers: SidebarSessionLspServer[] | undefined,
): SidebarModel["lspServers"] {
	if (!lspServers || lspServers.length === 0) return undefined;

	const activeServers = lspServers
		.filter(server => server.status === "ready")
		.map(server => ({ name: server.name, active: true }));

	return activeServers.length > 0 ? activeServers : undefined;
}

interface LoadedSubagentTranscript {
	source: string;
	content: string;
	sessionContext?: SessionContext;
	agentName?: string;
	role?: string;
	model?: string;
	tokens?: number;
	contextPreview?: string;
	skillsUsed?: string[];
	sessionId?: string;
	assignment?: string;
	toolNames?: string[];
	mcpServers?: string[];
	mcpAllowlist?: string[];
	contextFilePath?: string;
	parentContext?: string;
	delegationHistory?: string[];
	/** File edit statistics computed from transcript entries */
	editStats?: { filesChanged: number; linesAdded: number; linesDeleted: number };
}

function renderSubagentStatusBadge(): string {
	return theme.bg("statusLineBg", theme.bold(theme.fg("statusLineSubagents", " SUBAGENT VIEW ")));
}

function renderSubagentStatusField(label: string, value: string, color: ThemeColor): string {
	return `${theme.fg("dim", `${label}:`)}${theme.fg(color, value)}`;
}

function splitSubagentModelLabel(model?: string): { provider?: string; model?: string } {
	if (!model) return {};
	const parsed = parseModelString(model);
	return { provider: parsed?.provider, model: parsed?.id ?? model };
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

export class InteractiveMode implements InteractiveModeContext {
	public session: AgentSession;
	public sessionManager: SessionManager;
	public settings: Settings;
	public keybindings: KeybindingsManager;
	public agent: AgentSession["agent"];
	public historyStorage?: HistoryStorage;

	public ui: TUI;
	public chatContainer: Container;
	public pendingMessagesContainer: Container;
	public statusContainer: Container;
	public todoContainer: Container;
	public editor: CustomEditor;
	public editorContainer: Container;
	public statusLine: StatusLineComponent;
	public oauthManualInput = new OAuthManualInputManager();
	private readonly mainLayoutContainer: Container;
	private readonly sidebarPanel: SidebarPanelComponent;
	private readonly responsiveLayout: Component;
	private sidebarOverlay: OverlayHandle | undefined;

	public isInitialized = false;
	public isBackgrounded = false;
	public isBashMode = false;
	public toolOutputExpanded = false;
	public todoExpanded = false;
	public planModeEnabled = false;
	public planModePaused = false;
	public planModePlanFilePath: string | undefined = undefined;
	public todoItems: TodoItem[] = [];
	public hideThinkingBlock = false;
	public pendingImages: ImageContent[] = [];
	public compactionQueuedMessages: CompactionQueuedMessage[] = [];
	public pendingTools = new Map<string, ToolExecutionHandle>();
	public pendingBashComponents: BashExecutionComponent[] = [];
	public bashComponent: BashExecutionComponent | undefined = undefined;
	public pendingPythonComponents: PythonExecutionComponent[] = [];
	public pythonComponent: PythonExecutionComponent | undefined = undefined;
	public isPythonMode = false;
	public streamingComponent: AssistantMessageComponent | undefined = undefined;
	public streamingMessage: AssistantMessage | undefined = undefined;
	public loadingAnimation: Loader | undefined = undefined;
	public autoCompactionLoader: Loader | undefined = undefined;
	public retryLoader: Loader | undefined = undefined;
	private pendingWorkingMessage: string | undefined;
	private readonly defaultWorkingMessage = `Working… (esc to interrupt)`;
	public autoCompactionEscapeHandler?: () => void;
	public retryEscapeHandler?: () => void;
	public unsubscribe?: () => void;
	public onInputCallback?: (input: { text: string; images?: ImageContent[] }) => void;
	public lastSigintTime = 0;
	public lastEscapeTime = 0;
	public shutdownRequested = false;
	private isShuttingDown = false;
	public hookSelector: HookSelectorComponent | undefined = undefined;
	public hookInput: HookInputComponent | undefined = undefined;
	public hookEditor: HookEditorComponent | undefined = undefined;
	public lastStatusSpacer: Spacer | undefined = undefined;
	public lastStatusText: Text | undefined = undefined;
	public fileSlashCommands: Set<string> = new Set();
	public skillCommands: Map<string, string> = new Map();

	private pendingSlashCommands: SlashCommand[] = [];
	private cleanupUnsubscribe?: () => void;
	private readonly version: string;
	private readonly changelogMarkdown: string | undefined;
	private planModePreviousTools: string[] | undefined;
	private planModePreviousModel: Model | undefined;
	private pendingModelSwitch: Model | undefined;
	private hoveredActionButtonLabel: string | undefined;
	private subagentIndex: SubagentIndex;
	private subagentSnapshot: SubagentIndexSnapshot = {
		version: 0,
		updatedAt: 0,
		refs: [],
		groups: [],
	};
	private subagentRefreshInFlight: Promise<void> | undefined;
	private subagentRefreshQueuedReason: SubagentRefreshReason | undefined;
	private subagentRefreshGeneration = 0;
	private subagentWatchCleanup: (() => void) | undefined;
	private subagentWatchManager: SubagentArtifactsWatchManager | undefined;
	private subagentCycleSignature: string | undefined;
	private subagentCycleIndex = -1;
	private subagentNestedCycleIndex = -1;
	private subagentNestedArrowMode = false;
	private subagentSessionViewer: SubagentSessionViewerComponent | undefined;
	private subagentSessionOverlay: OverlayHandle | undefined;
	private subagentViewRequestToken = 0;
	private subagentViewActiveId: string | undefined;
	private subagentNavigatorComponent: SubagentNavigatorModal | undefined;
	private subagentNavigatorOverlay: ReturnType<TUI["showOverlay"]> | undefined;
	private subagentNavigatorGroups: SubagentViewGroup[] = [];
	private resumeModalComponent: ResumeModal | undefined;
	private resumeModalOverlay: ReturnType<TUI["showOverlay"]> | undefined;
	private sidebarModifiedFiles: SidebarModel["modifiedFiles"] = [];
	private sidebarModifiedFilesLastRefreshMs = 0;
	private sidebarModifiedFilesCwd: string | undefined;
	private sidebarModifiedFilesRefreshPromise: Promise<void> | undefined;
	private planModeHasEntered = false;
	public readonly lspServers: SidebarSessionLspServer[] | undefined = undefined;
	public mcpManager?: MCPManager;
	private readonly toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	private sidebarAnimationFrame = 0;
	private sidebarAnimationInterval: ReturnType<typeof setInterval> | undefined;

	private readonly commandController: CommandController;
	private readonly eventController: EventController;
	private readonly extensionUiController: ExtensionUiController;
	private readonly inputController: InputController;
	private readonly selectorController: SelectorController;
	private readonly uiHelpers: UiHelpers;

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: SidebarSessionLspServer[] | undefined = undefined,
		mcpManager?: MCPManager,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.version = version;
		this.changelogMarkdown = changelogMarkdown;
		this.toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.subagentIndex = this.createSubagentIndex();
		this.subagentSnapshot = this.subagentIndex.getSnapshot();

		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		setMermaidRenderCallback(() => this.ui.requestRender());
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.todoContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender(true);
		};
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.statusLine.setHookStatus(FORK_MERGE_BUTTON.statusKey, FORK_MERGE_BUTTON.normalText);
		this.statusLine.setHookStatus(LAZYGIT_BUTTON.statusKey, LAZYGIT_BUTTON.normalText);
		this.statusLine.setHookStatus(WORKTREE_MENU_BUTTON.statusKey, WORKTREE_MENU_BUTTON.normalText);
		this.mainLayoutContainer = new Container();
		this.mainLayoutContainer.addChild(this.chatContainer);
		this.mainLayoutContainer.addChild(this.pendingMessagesContainer);
		this.mainLayoutContainer.addChild(this.statusContainer);
		this.mainLayoutContainer.addChild(this.todoContainer);
		this.mainLayoutContainer.addChild(new Spacer(1));
		this.mainLayoutContainer.addChild(this.editorContainer);
		this.sidebarPanel = new SidebarPanelComponent();
		this.responsiveLayout = {
			render: width => {
				const mainWidth = this.getMainContentWidth(width);
				if (width >= SIDEBAR_MIN_WIDTH) {
					this.sidebarPanel.update(this.buildSidebarModel(SIDEBAR_WIDTH));
					return this.mainLayoutContainer.render(mainWidth);
				}
				return this.mainLayoutContainer.render(width);
			},
			invalidate: () => {
				this.mainLayoutContainer.invalidate();
				this.sidebarPanel.invalidate();
			},
		};

		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		// Store pending commands for init() where file commands are loaded async
		this.pendingSlashCommands = [...BUILTIN_SLASH_COMMANDS, ...hookCommands, ...customCommands, ...skillCommandList];

		this.uiHelpers = new UiHelpers(this);
		this.extensionUiController = new ExtensionUiController(this);
		this.eventController = new EventController(this);
		this.commandController = new CommandController(this);
		this.selectorController = new SelectorController(this);
		this.inputController = new InputController(this);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;
		debugStartup("InteractiveMode.init:entry");

		this.keybindings = await KeybindingsManager.create();
		debugStartup("InteractiveMode.init:keybindings");

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		this.cleanupUnsubscribe = postmortem.register("session-manager-flush", () => this.sessionManager.flush());
		debugStartup("InteractiveMode.init:cleanupRegistered");

		// Load and convert file commands to SlashCommand format (async)
		const fileCommands = await loadSlashCommands({ cwd: process.cwd() });
		debugStartup("InteractiveMode.init:slashCommands");
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Setup autocomplete with all commands
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[...this.pendingSlashCommands, ...fileSlashCommands],
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = (await getRecentSessions(this.sessionManager.getSessionDir())).map(s => ({
			name: s.name,
			timeAgo: s.timeAgo,
		}));
		debugStartup("InteractiveMode.init:recentSessions");

		// Convert LSP servers to welcome format
		const lspServerInfo =
			this.lspServers?.map(s => ({
				name: s.name,
				status: s.status as "ready" | "error" | "connecting",
				fileTypes: s.fileTypes,
			})) ?? [];

		const startupQuiet = settings.get("startup.quiet");

		if (!startupQuiet) {
			// Add welcome header
			debugStartup("InteractiveMode.init:welcomeComponent:start");
			const welcome = new WelcomeComponent(this.version, modelName, providerName, recentSessions, lspServerInfo);
			debugStartup("InteractiveMode.init:welcomeComponent:created");

			// Setup UI layout
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(welcome);
			this.ui.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.changelogMarkdown) {
				this.ui.addChild(new DynamicBorder());
				if (settings.get("collapseChangelog")) {
					const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.ui.addChild(new Text(condensedText, 1, 0));
				} else {
					this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.ui.addChild(new Spacer(1));
					this.ui.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
					this.ui.addChild(new Spacer(1));
				}
				this.ui.addChild(new DynamicBorder());
			}
		}

		// Set terminal title if session already has one (resumed session)
		const existingTitle = this.sessionManager.getSessionName();
		if (existingTitle) {
			setTerminalTitle(`pi: ${existingTitle}`);
		}

		this.ui.addChild(this.responsiveLayout);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.setFocus(this.editor);

		this.inputController.setupKeyHandlers();
		this.inputController.setupEditorSubmitHandler();

		// Load initial todos
		await this.loadTodoList();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;
		this.ensureSidebarOverlay();
		this.ui.setFocus(this.editor);
		this.ui.requestRender(true);

		// Set initial terminal title (will be updated when session title is generated)
		this.ui.terminal.setTitle("π");

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Enable click-to-launch for footer plan button rendered via extension status text.
		this.ui.onMouse = event => this.handleFooterMouseClick(event);

		// Restore mode from session (e.g. plan mode on resume)
		await this.restoreModeFromSession();

		// Subscribe to agent events
		this.subscribeToAgent();
		this.requestSubagentRefresh("bootstrap");

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.updateEditorTopBorder();
			this.ui.requestRender();
		});

		// Initial top border update
		this.updateEditorTopBorder();
	}

	async getUserInput(): Promise<{ text: string; images?: ImageContent[] }> {
		const { promise, resolve } = Promise.withResolvers<{ text: string; images?: ImageContent[] }>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		return promise;
	}

	updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	updateEditorTopBorder(): void {
		const width = this.getMainContentWidth(this.ui.terminal.columns);
		const topBorder = this.statusLine.getTopBorder(width);
		this.editor.setTopBorder(topBorder);
	}

	private ensureSidebarOverlay(): void {
		if (this.sidebarOverlay) return;
		this.sidebarOverlay = this.ui.showOverlay(this.sidebarPanel, {
			anchor: "top-right",
			width: SIDEBAR_WIDTH,
			visible: termWidth => termWidth >= SIDEBAR_MIN_WIDTH,
		});
	}

	private getMainContentWidth(totalWidth = this.ui.terminal.columns): number {
		const safeWidth = Math.max(1, totalWidth);
		if (safeWidth < SIDEBAR_MIN_WIDTH) return safeWidth;
		return Math.max(1, safeWidth - SIDEBAR_WIDTH - 1);
	}

	private buildSidebarModel(width = SIDEBAR_WIDTH): SidebarModel {
		return {
			width,
			tokens: this.buildSidebarTokenSection(),
			mcpServers: this.buildSidebarMcpServers(),
			lspServers: this.buildSidebarLspServers(),
			todos: this.buildSidebarTodos(),
			subagents: this.buildSidebarSubagents(),
			modifiedFiles: this.buildSidebarModifiedFiles(),
			animationFrame: this.sidebarAnimationFrame,
		};
	}

	private buildSidebarTokenSection(): SidebarModel["tokens"] {
		const contextUsage = this.session.getContextUsage();
		if (!contextUsage) return undefined;

		const contextWindow = Number.isFinite(contextUsage.contextWindow) ? Math.round(contextUsage.contextWindow) : 0;
		if (contextWindow <= 0) return undefined;

		if (typeof contextUsage.tokens !== "number" || !Number.isFinite(contextUsage.tokens)) {
			return undefined;
		}

		const tokensUsed = Math.max(0, Math.round(contextUsage.tokens));
		const tokensTotal = Math.max(tokensUsed, contextWindow);
		const contextUsedPercent =
			typeof contextUsage.percent === "number" && Number.isFinite(contextUsage.percent)
				? contextUsage.percent
				: tokensTotal > 0
					? (tokensUsed / tokensTotal) * 100
					: 0;

		const usageStats = this.sessionManager.getUsageStatistics();
		const costUsd = Number.isFinite(usageStats.cost) && usageStats.cost > 0 ? usageStats.cost : undefined;

		return {
			contextUsedPercent,
			tokensUsed,
			tokensTotal,
			costUsd,
		};
	}

	private buildSidebarMcpServers(): SidebarModel["mcpServers"] {
		return getActiveSidebarMcpServers(this.session.getActiveToolNames(), this.mcpManager);
	}

	private buildSidebarLspServers(): SidebarModel["lspServers"] {
		return getActiveSidebarLspServers(this.lspServers);
	}
	private buildSidebarTodos(): SidebarModel["todos"] {
		if (this.todoItems.length === 0) {
			this.stopSidebarAnimation();
			return undefined;
		}

		const hasInProgress = this.todoItems.some(t => t.status === "in_progress");
		if (hasInProgress) {
			this.startSidebarAnimation();
		} else {
			this.stopSidebarAnimation();
		}

		return this.todoItems.slice(0, SIDEBAR_SUBAGENT_LIMIT).map(todo => ({
			id: todo.id,
			content: todo.content,
			status: todo.status,
		}));
	}

	private startSidebarAnimation(): void {
		if (this.sidebarAnimationInterval) return;
		this.sidebarAnimationInterval = setInterval(() => {
			this.sidebarAnimationFrame = (this.sidebarAnimationFrame + 1) % 10;
			if (this.isInitialized) {
				this.ui.requestRender();
			}
		}, 100);
	}

	private stopSidebarAnimation(): void {
		if (!this.sidebarAnimationInterval) return;
		clearInterval(this.sidebarAnimationInterval);
		this.sidebarAnimationInterval = undefined;
		this.sidebarAnimationFrame = 0;
	}

	private buildSidebarSubagents(): SidebarModel["subagents"] {
		const groups = this.getSnapshotGroups().slice(0, SIDEBAR_SUBAGENT_LIMIT);
		if (groups.length === 0) return undefined;
		const now = Date.now();
		const rows: SidebarSubagent[] = [];

		for (const group of groups) {
			const rootRef = this.getSubagentRootRef(group);
			if (!rootRef) continue;

			const children = this.getSubagentNestedRefs(group).map(ref => ({
				kind: "child" as const,
				id: ref.id,
				agentName: this.getSubagentAgentLabel(ref.agent),
				status: this.getSidebarSubagentStatus(ref, now),
				tokens: ref.tokens,
				outcome: ref.outcome,
			}));

			const parentStatus = this.getSidebarSubagentGroupStatus([
				this.getSidebarSubagentStatus(rootRef, now),
				...children.map(child => child.status),
			]);

			rows.push({
				kind: "parent",
				id: rootRef.id,
				agentName: this.getSubagentAgentLabel(rootRef.agent),
				status: parentStatus,
				title: rootRef.description ?? rootRef.contextPreview,
				tokens: rootRef.tokens,
				outcome: rootRef.outcome,
				children: children.length > 0 ? children : undefined,
			});
		}

		return rows.length > 0 ? rows : undefined;
	}

	private getSidebarSubagentStatus(ref: SubagentViewRef, now: number): SidebarSubagent["status"] {
		const statusFromRef = ref.status;
		if (statusFromRef === "user_stopped") {
			return "user_stopped";
		}
		if (statusFromRef === "failed" || statusFromRef === "cancelled") {
			return "failed";
		}
		if (statusFromRef === "running" || statusFromRef === "pending") {
			return "running";
		}
		if (statusFromRef === "completed") {
			return "completed";
		}
		const isRecent =
			typeof ref.lastUpdatedMs === "number" &&
			Number.isFinite(ref.lastUpdatedMs) &&
			now - ref.lastUpdatedMs <= 30_000;
		return ref.id === this.subagentViewActiveId || isRecent ? "running" : "completed";
	}

	private getSidebarSubagentGroupStatus(statuses: SidebarSubagent["status"][]): SidebarSubagent["status"] {
		if (statuses.includes("running")) return "running";
		if (statuses.includes("failed")) return "failed";
		if (statuses.includes("user_stopped")) return "user_stopped";
		return "completed";
	}

	private buildSidebarModifiedFiles(): SidebarModel["modifiedFiles"] {
		this.refreshSidebarModifiedFilesIfNeeded();
		return this.sidebarModifiedFiles;
	}

	private refreshSidebarModifiedFilesIfNeeded(): void {
		const cwd = this.sessionManager.getCwd();
		const cwdChanged = this.sidebarModifiedFilesCwd !== cwd;
		const needsInitialFetch = this.sidebarModifiedFilesLastRefreshMs === 0;
		const isStale = Date.now() - this.sidebarModifiedFilesLastRefreshMs >= SIDEBAR_MODIFIED_FILES_REFRESH_MS;
		if (this.sidebarModifiedFilesRefreshPromise || (!cwdChanged && !needsInitialFetch && !isStale)) return;
		this.sidebarModifiedFilesRefreshPromise = this.refreshSidebarModifiedFiles(cwd);
	}

	private async refreshSidebarModifiedFiles(cwd: string): Promise<void> {
		try {
			const modifiedFiles = await getModifiedFiles(cwd);
			const hasChanged = !this.isSameSidebarModifiedFiles(this.sidebarModifiedFiles, modifiedFiles);
			this.sidebarModifiedFiles = modifiedFiles;
			this.sidebarModifiedFilesCwd = cwd;
			this.sidebarModifiedFilesLastRefreshMs = Date.now();
			if (hasChanged && this.isInitialized) {
				this.ui.requestRender();
			}
		} finally {
			this.sidebarModifiedFilesRefreshPromise = undefined;
			if (this.sessionManager.getCwd() !== this.sidebarModifiedFilesCwd) {
				this.sidebarModifiedFilesLastRefreshMs = 0;
				this.refreshSidebarModifiedFilesIfNeeded();
			}
		}
	}

	private isSameSidebarModifiedFiles(
		left: SidebarModel["modifiedFiles"],
		right: SidebarModel["modifiedFiles"],
	): boolean {
		const leftFiles = left ?? [];
		const rightFiles = right ?? [];
		if (leftFiles.length !== rightFiles.length) return false;
		for (let i = 0; i < leftFiles.length; i += 1) {
			const leftFile = leftFiles[i];
			const rightFile = rightFiles[i];
			if (!leftFile || !rightFile) return false;
			if (leftFile.path !== rightFile.path || leftFile.status !== rightFile.status) return false;
		}
		return true;
	}

	rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	private formatTodoLine(todo: TodoItem, prefix: string): string {
		const checkbox = theme.checkbox;
		const label = todo.content;
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`);
			case "in_progress":
				return theme.fg("accent", `${prefix}${checkbox.unchecked} ${label}`);
			default:
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${label}`);
		}
	}

	private getCollapsedTodos(todos: TodoItem[]): TodoItem[] {
		let startIndex = 0;
		for (let i = todos.length - 1; i >= 0; i -= 1) {
			if (todos[i].status === "completed") {
				startIndex = i;
				break;
			}
		}
		return todos.slice(startIndex, startIndex + 5);
	}

	private renderTodoList(): void {
		this.todoContainer.clear();
		if (this.todoItems.length === 0) {
			return;
		}

		const visibleTodos = this.todoExpanded ? this.todoItems : this.getCollapsedTodos(this.todoItems);
		const indent = "  ";
		const hook = theme.tree.hook;
		const lines = [indent + theme.bold(theme.fg("accent", "Todos"))];

		visibleTodos.forEach((todo, index) => {
			const prefix = `${indent}${index === 0 ? hook : " "} `;
			lines.push(this.formatTodoLine(todo, prefix));
		});

		if (!this.todoExpanded && visibleTodos.length < this.todoItems.length) {
			const remaining = this.todoItems.length - visibleTodos.length;
			lines.push(theme.fg("muted", `${indent}  ${hook} +${remaining} more (Ctrl+T to expand)`));
		}

		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	private async loadTodoList(): Promise<void> {
		const sessionFile = this.sessionManager.getSessionFile() ?? null;
		if (!sessionFile) {
			this.todoItems = [];
			this.renderTodoList();
			return;
		}
		const artifactsDir = sessionFile.slice(0, -6);
		const todoPath = path.join(artifactsDir, TODO_FILE_NAME);
		try {
			const data = (await Bun.file(todoPath).json()) as { todos?: TodoItem[] };
			if (data?.todos && Array.isArray(data.todos)) {
				this.todoItems = data.todos;
			} else {
				this.todoItems = [];
			}
		} catch (error) {
			if (isEnoent(error)) {
				this.todoItems = [];
				this.renderTodoList();
				return;
			}
			logger.warn("Failed to load todos", { path: todoPath, error: String(error) });
		}
		this.renderTodoList();
	}

	private getPlanFilePath(): string {
		return ".omp/sessions/plans/manual/plan.md";
	}

	private resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local://")) {
			return resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	private updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	private async applyPlanModeModel(): Promise<void> {
		const planModel = this.session.resolveRoleModel("plan");
		if (!planModel) return;
		const currentModel = this.session.model;
		if (currentModel && currentModel.provider === planModel.provider && currentModel.id === planModel.id) {
			return;
		}
		this.planModePreviousModel = currentModel;
		if (this.session.isStreaming) {
			this.pendingModelSwitch = planModel;
			return;
		}
		try {
			await this.session.setModelTemporary(planModel);
		} catch (error) {
			this.showWarning(
				`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const model = this.pendingModelSwitch;
		if (!model) return;
		this.pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(model);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Restore mode state from session entries on resume (e.g. plan mode). */
	private async restoreModeFromSession(): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.planModeHasEntered = true;
			this.updatePlanModeStatus();
		}
	}

	private async enterPlanMode(options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
	}): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? this.getPlanFilePath();
		const previousTools = this.session.getActiveToolNames();
		const uniquePlanTools = mergePlanModeMainAgentTools(
			previousTools,
			toolName => this.session.getToolByName(toolName) !== undefined,
		);

		this.planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.planModeHasEntered,
		});
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.planModeHasEntered = true;
		await this.applyPlanModeModel();
		this.updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	private async exitPlanMode(options?: { silent?: boolean; paused?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.planModePreviousModel) {
			if (this.session.isStreaming) {
				this.pendingModelSwitch = this.planModePreviousModel;
			} else {
				await this.session.setModelTemporary(this.planModePreviousModel);
			}
		}

		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.planModePreviousTools = undefined;
		this.planModePreviousModel = undefined;
		this.updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	private async readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	private renderPlanPreview(planContent: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Plan Review")), 1, 1));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(planContent, 1, 1, getMarkdownTheme()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async approvePlan(planContent: string, finalPlanFilePath: string): Promise<void> {
		const previousTools = this.planModePreviousTools ?? this.session.getActiveToolNames();
		await this.exitPlanMode({ silent: true, paused: false });
		await this.handleClearCommand();
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.markPlanReferenceSent();
		const prompt = renderPromptTemplate(planModeApprovedPrompt, { planContent, finalPlanFilePath });
		await this.session.prompt(prompt);
	}

	async handlePlanModeCommand(): Promise<void> {
		if (this.planModeEnabled) {
			const confirmed = await this.showHookConfirm(
				"Exit plan mode?",
				"This exits plan mode without approving a plan.",
			);
			if (!confirmed) return;
			await this.exitPlanMode({ paused: true });
			return;
		}
		await this.enterPlanMode();
	}

	async handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		const planFilePath = details.planFilePath || this.planModePlanFilePath || this.getPlanFilePath();
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		this.renderPlanPreview(planContent);
		const choice = await this.showHookSelector("Plan mode - next step", [
			"Approve and execute",
			"Refine plan",
			"Stay in plan mode",
		]);

		if (choice === "Approve and execute") {
			await this.approvePlan(planContent, details.finalPlanFilePath || planFilePath);
			return;
		}
		if (choice === "Refine plan") {
			const refinement = await this.showHookInput("What should be refined?");
			if (refinement) {
				this.editor.setText(refinement);
			}
		}
	}

	stop(): void {
		this.inputController.dispose();
		this.stopSidebarAnimation();
		this.exitSubagentView();
		this.disposeSubagentWatchCleanup();
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusLine.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.cleanupUnsubscribe) {
			this.cleanupUnsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
	async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();
		// Flush pending settings writes (e.g., model role changes via /model) before shutdown
		await this.settings.flush();

		// Emit shutdown event to hooks
		await this.emitCustomToolSessionEvent("shutdown");

		if (this.isInitialized) {
			this.ui.requestRender(true);
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise(resolve => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	createBackgroundUiContext(): ExtensionUIContext {
		return this.extensionUiController.createBackgroundUiContext();
	}

	// Event handling
	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		await this.eventController.handleBackgroundEvent(event);
	}

	private getActionButtonUnderMouse(event: TerminalMouseEvent): ActionButtonUi | undefined {
		const rawLine = event.lineText ?? "";
		return getActionButtonAtMouse(rawLine, event.x);
	}

	private shouldUpdateActionButtonStatus(button: ActionButtonUi): boolean {
		const currentText = this.statusLine.getHookStatus(button.statusKey);
		if (!currentText) return false;
		return (
			currentText === button.normalText ||
			currentText === button.hoverText ||
			hasSameVisibleText(currentText, button.normalText) ||
			hasSameVisibleText(currentText, button.hoverText)
		);
	}

	private setActionButtonHoverState(button: ActionButtonUi | undefined): void {
		const previousLabel = this.hoveredActionButtonLabel;
		const nextLabel = button?.label;
		if (previousLabel === nextLabel) return;

		if (previousLabel) {
			const prev = ACTION_BUTTONS.find(candidate => candidate.label === previousLabel);
			const previousStatusText = prev ? this.statusLine.getHookStatus(prev.statusKey) : undefined;
			if (prev && previousStatusText && hasSameVisibleText(previousStatusText, prev.hoverText)) {
				this.statusLine.setHookStatus(prev.statusKey, prev.normalText);
			}
		}

		if (button && this.shouldUpdateActionButtonStatus(button)) {
			this.statusLine.setHookStatus(button.statusKey, button.hoverText);
		}

		this.hoveredActionButtonLabel = nextLabel;
	}

	private handleFooterMouseClick(event: TerminalMouseEvent): boolean {
		const hoveredButton = this.getActionButtonUnderMouse(event);
		this.setActionButtonHoverState(hoveredButton);

		if (!hoveredButton) {
			return false;
		}

		if (event.action !== "release" || event.button !== "left") {
			return true;
		}

		if (hoveredButton.editorText) {
			this.editor.setText(hoveredButton.editorText);
			return true;
		}

		if (hoveredButton.command === "/lazygit") {
			void this.inputController.openLazygit();
			return true;
		}

		if (hoveredButton.command === "/worktree-menu") {
			this.statusLine.toggleMenu("worktree");
			this.ui.requestRender();
			return true;
		}

		const commandName = hoveredButton.command.slice(1);
		const hasExtensionCommand = Boolean(this.session.extensionRunner?.getCommand(commandName));
		const hasKnownSlashCommand = this.isKnownSlashCommand(hoveredButton.command);
		if (!hasExtensionCommand && !hasKnownSlashCommand) {
			return true;
		}

		void this.session.prompt(hoveredButton.command).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(`Failed to run ${hoveredButton.command}: ${message}`);
		});

		return true;
	}

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void {
		this.uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.uiHelpers.showError(message);
	}

	showWarning(message: string): void {
		this.uiHelpers.showWarning(message);
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.pendingWorkingMessage;
		this.pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.uiHelpers.queueCompactionMessage(text, mode);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		this.uiHelpers.addMessageToChat(message, options);
		const toolMessage = message as { role?: string; toolName?: string };
		if (toolMessage.role === "toolResult" && toolMessage.toolName === "task") {
			this.requestSubagentRefresh("watch");
		}
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(): void {
		this.closeResumeModal();
		this.subagentNavigatorOverlay?.hide();
		this.subagentSessionOverlay?.hide();
		this.subagentViewRequestToken += 1;
		this.subagentCycleSignature = undefined;
		this.subagentCycleIndex = -1;
		this.subagentNestedCycleIndex = -1;
		this.subagentNestedArrowMode = false;
		this.subagentSessionViewer = undefined;
		this.subagentSessionOverlay = undefined;
		this.subagentViewActiveId = undefined;
		this.subagentNavigatorComponent = undefined;
		this.subagentNavigatorOverlay = undefined;
		this.subagentNavigatorGroups = [];
		this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
		this.uiHelpers.renderInitialMessages();
	}

	getUserMessageText(message: Message): string {
		return this.uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.commandController.handleExportCommand(text);
	}

	handleDumpCommand(): void {
		this.commandController.handleDumpCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.commandController.handleShareCommand();
	}

	handleCopyCommand(): void {
		this.commandController.handleCopyCommand();
	}

	handleSessionCommand(): Promise<void> {
		return this.commandController.handleSessionCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(): Promise<void> {
		await this.commandController.handleChangelogCommand();
	}

	handleHotkeysCommand(): void {
		this.commandController.handleHotkeysCommand();
	}

	handleClearCommand(): Promise<void> {
		return this.commandController.handleClearCommand();
	}

	handleForkCommand(): Promise<void> {
		return this.commandController.handleForkCommand();
	}

	mergeUpstreamFork(): Promise<void> {
		return this.commandController.handleMergeUpstreamFork();
	}

	showDebugSelector(): void {
		this.selectorController.showDebugSelector();
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.commandController.handlePythonCommand(code, excludeFromContext);
	}

	handleCompactCommand(customInstructions?: string): Promise<void> {
		return this.commandController.handleCompactCommand(customInstructions);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.commandController.handleHandoffCommand(customInstructions);
	}

	executeCompaction(customInstructionsOrOptions?: string | CompactOptions, isAuto?: boolean): Promise<void> {
		return this.commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.selectorController.showSettingsSelector();
	}

	showHistorySearch(): void {
		this.selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.selectorController.showExtensionsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.selectorController.showModelSelector(options);
	}

	showUserMessageSelector(): void {
		this.selectorController.showUserMessageSelector();
	}

	showTreeSelector(): void {
		this.selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		this.selectorController.showSessionSelector();
	}

	async openResumeModal(): Promise<void> {
		const grouped = await SessionManager.listAllGroupedByProject();
		const currentCwd = this.sessionManager.getCwd();

		if (this.resumeModalComponent && this.resumeModalOverlay) {
			this.resumeModalComponent.updateSessions(grouped, currentCwd);
			if (this.resumeModalOverlay.isHidden()) {
				this.resumeModalOverlay.setHidden(false);
			}
			this.ui.requestRender();
			return;
		}

		const modal = new ResumeModal(grouped, currentCwd, {
			onSelect: (sessionPath, sessionCwd) => {
				this.closeResumeModal();
				void this.handleResumeModalSelection(sessionPath, sessionCwd);
			},
			onClose: () => {
				this.closeResumeModal();
				this.ui.requestRender();
			},
		});

		this.resumeModalComponent = modal;
		this.resumeModalOverlay = this.ui.showOverlay(modal, {
			width: "92%",
			maxHeight: "85%",
			anchor: "center",
			margin: 1,
		});
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		return this.selectorController.handleResumeSession(sessionPath);
	}

	private closeResumeModal(): void {
		this.resumeModalOverlay?.hide();
		this.resumeModalOverlay = undefined;
		this.resumeModalComponent = undefined;
	}

	private async handleResumeModalSelection(
		sessionPath: string,
		sessionCwd: string,
	): Promise<void> {
		const previousCwd = process.cwd();
		let switchedCwd = false;

		if (sessionCwd) {
			try {
				process.chdir(sessionCwd);
				switchedCwd = process.cwd() !== previousCwd;
			} catch {
				// Keep current cwd when target no longer exists or is inaccessible.
			}
		}

		try {
			await this.selectorController.handleResumeSession(sessionPath);
		} catch (error) {
			if (switchedCwd) {
				try {
					process.chdir(previousCwd);
				} catch {
					// Ignore restore failures; report original error below.
				}
			}
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}
	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.selectorController.showOAuthSelector(mode, providerId);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.inputController.handleDequeue();
	}

	openSubagentNavigator(): void {
		this.openSubagentNavigatorOverlay({ scope: "root", direction: 1 });
	}

	async openSubagentViewerForRoot(direction: 1 | -1): Promise<void> {
		await this.navigateSubagentView("root", direction);
	}

	async openSubagentViewerNewest(): Promise<void> {
		const groups = this.getSnapshotGroups();
		if (groups.length === 0) {
			this.showStatus(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}
		this.subagentNavigatorGroups = groups;
		await this.openSubagentTranscriptFromNavigator({ groupIndex: 0, nestedIndex: -1 });
	}

	requestSubagentRefresh(reason: SubagentRefreshReason): void {
		this.requestIndexRefresh(reason);
	}

	ingestTaskToolResult(results: unknown[]): void {
		this.subagentIndex.ingestTaskResults(results);
		this.requestSubagentRefresh("watch");
	}

	handleSessionRootChange(): void {
		this.closeResumeModal();
		this.exitSubagentView();
		this.disposeSubagentWatchCleanup();
		this.subagentRefreshGeneration += 1;
		this.subagentRefreshQueuedReason = undefined;
		this.subagentIndex = this.createSubagentIndex();
		this.subagentSnapshot = this.subagentIndex.getSnapshot();
		this.requestSubagentRefresh("bootstrap");
	}

	private openSubagentNavigatorOverlay(options: { scope: "root" | "nested"; direction: 1 | -1 }): void {
		const groups = this.getSnapshotGroups();
		if (groups.length === 0) {
			this.showStatus(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}

		this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
		this.subagentNavigatorGroups = groups;

		const currentSelection =
			this.subagentViewActiveId !== undefined
				? this.findSubagentSelection(groups, this.subagentViewActiveId)
				: undefined;
		if (currentSelection) {
			this.subagentCycleIndex = currentSelection.groupIndex;
			this.subagentNestedCycleIndex = currentSelection.refIndex;
		} else {
			const latestSelection = this.findMostRecentSubagentSelection(groups);
			if (latestSelection) {
				this.subagentCycleIndex = latestSelection.groupIndex;
				this.subagentNestedCycleIndex = latestSelection.refIndex;
			} else {
				this.subagentCycleIndex = options.scope === "root" && options.direction < 0 ? groups.length - 1 : 0;
				this.subagentNestedCycleIndex = -1;
			}
		}

		const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(selectedGroup, this.subagentNestedCycleIndex);
		const selected = this.getSubagentSelectionRef(selectedGroup, this.subagentNestedCycleIndex);
		if (!selected) {
			this.showStatus(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}

		if (this.subagentNavigatorComponent) {
			// Navigator already exists — update data in-place and unhide if hidden
			this.subagentNavigatorComponent.setGroups(groups, {
				groupIndex: this.subagentCycleIndex,
				nestedIndex: this.subagentNestedCycleIndex,
			});
			if (this.subagentNavigatorOverlay?.isHidden()) {
				this.subagentNavigatorOverlay.setHidden(false);
			}
			return;
		}

		this.applySubagentNavigatorSelection(
			{ groupIndex: this.subagentCycleIndex, nestedIndex: this.subagentNestedCycleIndex },
			groups,
		);
		const navigator = new SubagentNavigatorModal(
			groups,
			{ groupIndex: this.subagentCycleIndex, nestedIndex: this.subagentNestedCycleIndex },
			{
				onSelectionChange: selection => this.applySubagentNavigatorSelection(selection),
				onOpenSelection: selection => {
					void this.openSubagentTranscriptFromNavigator(selection);
				},
				onStopSelection: selection => {
					void this.stopSubagentFromNavigatorSelection(selection);
				},
				onClose: () => this.exitSubagentView(),
			},
		);
		this.subagentNavigatorComponent = navigator;
		this.subagentNavigatorOverlay = this.ui.showOverlay(navigator, {
			width: "92%",
			maxHeight: "80%",
			anchor: "center",
			margin: 1,
		});
		this.ui.requestRender();
		void this.loadMissingTokensForGroups(groups);
	}

	private applySubagentNavigatorSelection(
		selection: SubagentNavigatorSelection,
		groups: SubagentViewGroup[] = this.subagentNavigatorGroups,
	): void {
		if (groups.length === 0) {
			this.subagentViewActiveId = undefined;
			this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
			this.ui.requestRender();
			return;
		}
		const previousGroupIndex = this.subagentCycleIndex;
		this.subagentCycleIndex = Math.max(0, Math.min(selection.groupIndex, groups.length - 1));
		const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		const nestedRefs = this.getSubagentNestedRefs(selectedGroup);
		const nestedCount = nestedRefs.length;
		const didRootSelectionChange = this.subagentCycleIndex !== previousGroupIndex;
		const requestedNestedIndex = didRootSelectionChange ? -1 : selection.nestedIndex;
		this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(selectedGroup, requestedNestedIndex);
		const selected = this.getSubagentSelectionRef(selectedGroup, this.subagentNestedCycleIndex);
		if (!selected) {
			this.subagentViewActiveId = undefined;
			this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
			this.ui.requestRender();
			return;
		}

		this.subagentViewActiveId = selected.id;
		const taskPosition = this.subagentCycleIndex + 1;
		const isParentSelection = this.subagentNestedCycleIndex < 0;
		const nestedLabel =
			nestedCount === 0
				? "nested 0/0 (root implied)"
				: isParentSelection
					? `nested 0/${nestedCount} (root implied)`
					: `nested ${this.subagentNestedCycleIndex + 1}/${nestedCount} ${selected.agent ?? "subagent"}`;
		const statusSeparator = theme.fg("statusLineSep", theme.sep.dot);
		const modelLabel = this.clipPreview(selected.model ?? "default", 32);
		this.statusLine.setHookStatus(
			SUBAGENT_VIEWER_STATUS_KEY,
			[
				renderSubagentStatusBadge(),
				`${theme.bold(theme.fg("statusLineSubagents", `task ${taskPosition}/${groups.length}`))} ${theme.bold(theme.fg("accent", selected.id))}`,
				renderSubagentStatusField("agent", nestedLabel, "statusLineSubagents"),
				renderSubagentStatusField("model", modelLabel, "statusLineModel"),
			].join(statusSeparator),
		);
		this.ui.requestRender();
	}

	private async openSubagentTranscriptFromNavigator(selection: SubagentNavigatorSelection): Promise<void> {
		await this.openSubagentTranscriptFromGroups(this.subagentNavigatorGroups, selection);
	}

	private async stopSubagentFromNavigatorSelection(selection: SubagentNavigatorSelection): Promise<void> {
		const groups = this.subagentNavigatorGroups;
		if (groups.length === 0) return;
		const group = groups[selection.groupIndex] ?? groups[0];
		if (!group) return;
		const ref = this.getSubagentSelectionRef(group, selection.nestedIndex);
		if (!ref) return;
		await this.stopSubagentSession(ref);
	}

	private async stopSubagentSession(ref: SubagentViewRef): Promise<void> {
		const reason = await this.showHookInput("Why was this session stopped?", "Optional reason");
		if (reason === undefined) return;

		const abortReason = buildUserStoppedAbortReason(reason);
		let handled = false;
		this.session.eventBus?.emit(TASK_SUBAGENT_STOP_REQUEST_CHANNEL, {
			id: ref.id,
			sessionId: ref.sessionId,
			sessionPath: ref.sessionPath,
			reason: abortReason,
			respond: (wasHandled: boolean) => {
				handled = handled || wasHandled;
			},
		});
		if (!handled) {
			handled = await stopSubagentRuntime(
				{ id: ref.id, sessionId: ref.sessionId, sessionPath: ref.sessionPath },
				abortReason,
			);
		}
		if (!handled) {
			this.showWarning(`Unable to stop subagent '${ref.id}'.`);
			return;
		}

		this.markSubagentAsUserStopped(ref.id, abortReason);
		this.showStatus(`Stopping subagent ${ref.id}...`);
		if (this.subagentViewActiveId === ref.id) {
			await this.refreshActiveViewerTranscript();
		} else {
			this.ui.requestRender();
		}
	}

	private async resumeSubagentSession(ref: SubagentViewRef): Promise<void> {
		const continueMessage = await this.showHookInput("Continue message (optional)", "Optional message");
		if (continueMessage === undefined) return;

		let handled = false;
		this.session.eventBus?.emit(TASK_SUBAGENT_RESUME_REQUEST_CHANNEL, {
			id: ref.id,
			sessionId: ref.sessionId,
			sessionPath: ref.sessionPath,
			respond: (wasHandled: boolean) => {
				handled = handled || wasHandled;
			},
		});
		if (!handled) {
			handled = await resumeSubagentRuntime({
				id: ref.id,
				sessionId: ref.sessionId,
				sessionPath: ref.sessionPath,
			});
		}
		if (!handled) {
			this.showWarning(`Unable to resume subagent '${ref.id}'.`);
			return;
		}

		this.showStatus(`Resuming subagent ${ref.id}...`);
		if (this.subagentViewActiveId === ref.id) {
			await this.refreshActiveViewerTranscript();
		} else {
			this.ui.requestRender();
		}
	}

	private markSubagentAsUserStopped(id: string, abortReason: string): void {
		const now = Date.now();
		for (const ref of this.subagentSnapshot.refs) {
			if (ref.id !== id) continue;
			ref.status = "user_stopped";
			ref.abortReason = abortReason;
			ref.lastUpdatedMs = now;
			if (typeof ref.startedAt === "number") {
				ref.elapsedMs = Math.max(0, now - ref.startedAt);
			}
		}
		for (const group of this.subagentSnapshot.groups) {
			for (const ref of group.refs) {
				if (ref.id !== id) continue;
				ref.status = "user_stopped";
				ref.abortReason = abortReason;
				ref.lastUpdatedMs = now;
				if (typeof ref.startedAt === "number") {
					ref.elapsedMs = Math.max(0, now - ref.startedAt);
				}
			}
			group.lastUpdatedMs = Math.max(group.lastUpdatedMs, now);
		}
	}

	private async openSubagentTranscriptFromGroups(
		groups: SubagentViewGroup[],
		selection: SubagentNavigatorSelection,
	): Promise<void> {
		if (groups.length === 0) {
			this.showWarning(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}
		const groupIndex = Math.max(0, Math.min(selection.groupIndex, groups.length - 1));
		const selectedGroup = groups[groupIndex] ?? groups[0];
		if (!selectedGroup) {
			this.showWarning(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}
		const nestedIndex = this.clampSubagentNestedSelection(selectedGroup, selection.nestedIndex);
		const openedFromRootSelection = nestedIndex < 0;
		const selected = this.getSubagentSelectionRef(selectedGroup, nestedIndex);
		if (!selected) {
			this.showWarning(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}
		const requestToken = ++this.subagentViewRequestToken;
		const transcript = await this.loadSubagentTranscript(selected);
		if (requestToken !== this.subagentViewRequestToken) return;
		if (!transcript) {
			this.showWarning(`No transcript found for subagent '${selected.id}'.`);
			return;
		}

		// Hide the navigator overlay (do not destroy) — viewer close returns to it
		this.subagentNavigatorOverlay?.setHidden(true);
		this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
		const confirmedSelection = this.findSubagentSelection(groups, selected.id);
		if (confirmedSelection) {
			this.subagentCycleIndex = confirmedSelection.groupIndex;
			this.subagentNestedCycleIndex = confirmedSelection.refIndex;
		}
		this.subagentNestedArrowMode = openedFromRootSelection;
		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
	}

	private closeSubagentNavigator(): void {
		this.subagentNavigatorOverlay?.hide();
		this.subagentNavigatorOverlay = undefined;
		this.subagentNavigatorComponent = undefined;
		this.subagentNavigatorGroups = [];
		this.subagentNestedArrowMode = false;
	}

	private async navigateSubagentView(scope: "root" | "nested", direction: 1 | -1): Promise<void> {
		const groups = this.getSnapshotGroups();
		if (groups.length === 0) {
			this.exitSubagentView();
			this.showStatus(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}

		const signature = this.buildSubagentCycleSignature(groups);
		if (signature !== this.subagentCycleSignature) {
			this.subagentCycleSignature = signature;
			this.subagentCycleIndex = direction > 0 ? -1 : 0;
			this.subagentNestedCycleIndex = -1;
		}

		const currentSelection =
			this.subagentViewActiveId !== undefined
				? this.findSubagentSelection(groups, this.subagentViewActiveId)
				: undefined;
		if (currentSelection) {
			this.subagentCycleIndex = currentSelection.groupIndex;
			this.subagentNestedCycleIndex = currentSelection.refIndex;
		}

		if (scope === "root") {
			this.subagentCycleIndex = (this.subagentCycleIndex + direction + groups.length) % groups.length;
			this.subagentNestedCycleIndex = -1;
		} else {
			if (this.subagentCycleIndex < 0 || this.subagentCycleIndex >= groups.length) {
				this.subagentCycleIndex = 0;
				this.subagentNestedCycleIndex = -1;
			}
			const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
			const nestedRefs = this.getSubagentNestedRefs(selectedGroup);
			if (nestedRefs.length === 0) {
				this.subagentNestedCycleIndex = -1;
			} else if (this.subagentNestedCycleIndex < 0 || this.subagentNestedCycleIndex >= nestedRefs.length) {
				this.subagentNestedCycleIndex = direction > 0 ? 0 : nestedRefs.length - 1;
			} else {
				this.subagentNestedCycleIndex =
					(this.subagentNestedCycleIndex + direction + nestedRefs.length) % nestedRefs.length;
			}
		}

		const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(selectedGroup, this.subagentNestedCycleIndex);
		const selected = this.getSubagentSelectionRef(selectedGroup, this.subagentNestedCycleIndex);
		if (!selected) {
			this.showWarning(SUBAGENT_EMPTY_STATE_MESSAGE);
			return;
		}
		const requestToken = ++this.subagentViewRequestToken;
		const transcript = await this.loadSubagentTranscript(selected);
		if (requestToken !== this.subagentViewRequestToken) return;
		if (!transcript) {
			this.showWarning(`No transcript found for subagent '${selected.id}'.`);
			return;
		}

		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
	}

	exitSubagentView(): void {
		this.closeSubagentNavigator();
		this.subagentViewRequestToken += 1;
		this.closeSubagentSessionViewer();
		this.subagentViewActiveId = undefined;
		this.subagentCycleSignature = undefined;
		this.subagentCycleIndex = -1;
		this.subagentNestedCycleIndex = -1;
		this.subagentNestedArrowMode = false;
		this.subagentNavigatorComponent = undefined;
		this.subagentNavigatorOverlay = undefined;
		this.subagentNavigatorGroups = [];
		this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
		this.ui.requestRender();
	}

	/**
	 * Called when the viewer's Esc is pressed. If a hidden navigator exists,
	 * close the current viewer and return to the navigator. Otherwise, perform a full exit.
	 */
	private returnToNavigatorOrExit(): void {
		if (this.subagentNavigatorComponent && this.subagentNavigatorOverlay) {
			this.subagentViewRequestToken += 1;
			const selection = this.subagentNavigatorComponent.getSelection();
			this.closeSubagentSessionViewer();
			this.subagentNavigatorOverlay.setHidden(false);
			this.subagentNestedArrowMode = false;
			this.applySubagentNavigatorSelection(selection);
			return;
		}
		this.exitSubagentView();
	}

	isSubagentViewActive(): boolean {
		return Boolean(this.subagentNavigatorOverlay || this.subagentSessionOverlay);
	}

	private async refreshActiveViewerTranscript(): Promise<void> {
		if (!this.subagentViewActiveId) return;
		const groups = this.getSnapshotGroups();
		if (groups.length === 0) {
			this.exitSubagentView();
			return;
		}

		this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
		const currentSelection = this.findSubagentSelection(groups, this.subagentViewActiveId);
		if (!currentSelection) {
			this.subagentCycleIndex = 0;
			this.subagentNestedCycleIndex = -1;
		} else {
			this.subagentCycleIndex = currentSelection.groupIndex;
			this.subagentNestedCycleIndex = currentSelection.refIndex;
		}

		const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(selectedGroup, this.subagentNestedCycleIndex);
		const selected = this.getSubagentSelectionRef(selectedGroup, this.subagentNestedCycleIndex);
		if (!selected) return;
		const requestToken = ++this.subagentViewRequestToken;
		const transcript = await this.loadSubagentTranscript(selected);
		if (requestToken !== this.subagentViewRequestToken || !transcript) return;
		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
	}

	private createSubagentIndex(): SubagentIndex {
		const sessionFile = this.sessionManager.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : undefined;
		return new SubagentIndex({ artifactsDir });
	}

	private getSnapshotGroups(): SubagentViewGroup[] {
		if (Array.isArray(this.subagentSnapshot?.groups) && this.subagentSnapshot.groups.length > 0) {
			return this.subagentSnapshot.groups;
		}
		if (Array.isArray(this.subagentSnapshot?.refs) && this.subagentSnapshot.refs.length > 0) {
			return this.buildSubagentViewGroups(this.subagentSnapshot.refs);
		}
		return [];
	}

	private collectTaskResultsFromSessionEntries(): unknown[] {
		const results: unknown[] = [];
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "task") continue;
			const details = message.details as Record<string, unknown> | undefined;
			const entries = Array.isArray(details?.results) ? details.results : [];
			results.push(...entries);
		}
		return results;
	}

	private requestIndexRefresh(reason: SubagentRefreshReason): void {
		this.subagentRefreshQueuedReason = reason;
		if (this.subagentRefreshInFlight) return;
		this.subagentRefreshInFlight = this.runRequestedSubagentRefreshes();
	}

	private async runRequestedSubagentRefreshes(): Promise<void> {
		try {
			while (this.subagentRefreshQueuedReason) {
				const reason = this.subagentRefreshQueuedReason;
				this.subagentRefreshQueuedReason = undefined;
				await this.refreshSubagentIndex(reason);
			}
		} finally {
			this.subagentRefreshInFlight = undefined;
		}
	}

	private async refreshSubagentIndex(reason: SubagentRefreshReason): Promise<void> {
		const refreshGeneration = this.subagentRefreshGeneration;
		const isBootstrap = reason === "bootstrap";

		// Show loading state during bootstrap so the UI signals activity
		if (isBootstrap && this.isInitialized) {
			this.statusLine?.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, "loading\u2026");
		}

		const taskResults = this.collectTaskResultsFromSessionEntries();
		if (taskResults.length > 0) {
			this.subagentIndex.ingestTaskResults(taskResults);
		}
		const snapshot = await this.subagentIndex.reconcile();
		if (refreshGeneration !== this.subagentRefreshGeneration) return;

		// Clear bootstrap loading state
		if (isBootstrap && this.isInitialized) {
			this.statusLine?.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
		}

		// Start watch manager after first bootstrap if not already watching
		if (isBootstrap && !this.subagentWatchManager) {
			this.startSubagentWatchManager();
		}

		const previousVersion = this.subagentSnapshot.version;
		this.subagentSnapshot = snapshot;
		if (snapshot.version !== previousVersion) {
			await this.syncSubagentOverlaysForSnapshotChange(snapshot, reason);
			return;
		}
		// Even if snapshot version hasn't changed (same refs), refresh viewer
		// content as transcript files may have grown
		if (this.subagentSessionViewer && this.subagentViewActiveId) {
			await this.refreshActiveViewerTranscript();
			return;
		}
		if (this.isInitialized) {
			this.ui.requestRender();
		}
	}

	private async syncSubagentOverlaysForSnapshotChange(
		snapshot: SubagentIndexSnapshot,
		reason: SubagentRefreshReason,
	): Promise<void> {
		const groups = snapshot.groups;
		if (this.subagentNavigatorComponent) {
			if (groups.length === 0) {
				this.exitSubagentView();
				if (reason !== "bootstrap") {
					this.showStatus(SUBAGENT_EMPTY_STATE_MESSAGE);
				}
				return;
			}
			const selection =
				this.subagentViewActiveId !== undefined
					? this.findSubagentSelection(groups, this.subagentViewActiveId)
					: undefined;
			if (selection) {
				this.subagentCycleIndex = selection.groupIndex;
				this.subagentNestedCycleIndex = selection.refIndex;
			} else if (this.subagentCycleIndex < 0 || this.subagentCycleIndex >= groups.length) {
				this.subagentCycleIndex = 0;
				this.subagentNestedCycleIndex = -1;
			}
			const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
			this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(
				selectedGroup,
				this.subagentNestedCycleIndex,
			);
			this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
			this.subagentNavigatorGroups = groups;
			const selectionState = { groupIndex: this.subagentCycleIndex, nestedIndex: this.subagentNestedCycleIndex };
			this.subagentNavigatorComponent.setGroups(groups, selectionState);
			this.applySubagentNavigatorSelection(selectionState, groups);
			void this.loadMissingTokensForGroups(groups);
			// Background: compute edit stats for completed sessions not yet scanned
			void this.subagentIndex.computeAllEditStats().then(hasUpdates => {
				if (!hasUpdates || !this.subagentNavigatorComponent) return;
				const updatedGroups = this.getSnapshotGroups();
				this.subagentNavigatorGroups = updatedGroups;
				this.subagentNavigatorComponent.setGroups(updatedGroups);
				this.ui.requestRender();
			});
		}
		if (this.subagentSessionViewer && this.subagentViewActiveId) {
			await this.refreshActiveViewerTranscript();
			return;
		}
		if (this.isInitialized) {
			this.ui.requestRender();
		}
	}

	private disposeSubagentWatchCleanup(): void {
		if (this.subagentWatchManager) {
			this.subagentWatchManager.dispose();
			this.subagentWatchManager = undefined;
		}
		if (this.subagentWatchCleanup) {
			const disposeWatch = this.subagentWatchCleanup;
			this.subagentWatchCleanup = undefined;
			disposeWatch();
		}
	}

	private startSubagentWatchManager(): void {
		const sessionFile = this.sessionManager.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : undefined;
		if (!artifactsDir) return;

		const manager = new SubagentArtifactsWatchManager({
			artifactsDir,
			onInvalidate: () => {
				this.requestSubagentRefresh("watch");
			},
		});

		this.subagentWatchManager = manager;
		manager
			.start()
			.then(() => {
				if (manager.state === "degraded") {
					const hint = this.keybindings?.getDisplayString("cycleSubagentForward") ?? "Ctrl+X";
					try {
						this.showWarning(`Watch unavailable. Use ${hint} then Ctrl+R to manually refresh subagent data.`);
					} catch {
						// UI may not be fully initialized yet
					}
					logger.warn("Subagent watch entered degraded mode", { reason: manager.degradedReason });
				}
			})
			.catch(() => {
				// Watch startup failures are non-fatal
			});
	}

	private buildSubagentViewGroups(refs: SubagentViewRef[]): SubagentViewGroup[] {
		const groups = new Map<string, SubagentViewGroup>();

		for (const ref of refs) {
			const hierarchy = this.getSubagentHierarchy(ref.id);
			const rootId = ref.rootId ?? hierarchy.rootId;
			const activityScore = this.getSubagentLastActivityScore(ref);
			const existing = groups.get(rootId);
			if (existing) {
				existing.refs.push(ref);
				if (activityScore > existing.lastUpdatedMs) {
					existing.lastUpdatedMs = activityScore;
				}
				continue;
			}
			groups.set(rootId, { rootId, refs: [ref], lastUpdatedMs: activityScore });
		}

		const sortedGroups = Array.from(groups.values()).sort((a, b) => {
			const sortDelta = this.getSubagentGroupSortScore(b) - this.getSubagentGroupSortScore(a);
			if (sortDelta !== 0) return sortDelta;
			return a.rootId.localeCompare(b.rootId);
		});

		for (const group of sortedGroups) {
			const rootRef = group.refs.find(ref => ref.id === group.rootId);
			const descendants = group.refs
				.filter(ref => ref.id !== group.rootId)
				.sort((a, b) => {
					const recencyDelta = this.getSubagentRecencyScore(b) - this.getSubagentRecencyScore(a);
					if (recencyDelta !== 0) return recencyDelta;
					return a.id.localeCompare(b.id);
				});
			group.refs = rootRef ? [rootRef, ...descendants] : descendants;
		}

		return sortedGroups.filter(group => group.refs.length > 0);
	}

	private getSubagentRootRef(group: SubagentViewGroup): SubagentViewRef | undefined {
		return group.refs.find(ref => ref.id === group.rootId) ?? group.refs[0];
	}

	private getSubagentGroupSortScore(group: SubagentViewGroup): number {
		const rootRef = this.getSubagentRootRef(group);
		if (rootRef) return this.getSubagentRecencyScore(rootRef);
		let best = 0;
		for (const ref of group.refs) {
			best = Math.max(best, this.getSubagentRecencyScore(ref));
		}
		return best;
	}

	private getSubagentNestedRefs(group: SubagentViewGroup): SubagentViewRef[] {
		const rootRef = this.getSubagentRootRef(group);
		const parentId = rootRef?.id ?? group.rootId;
		return group.refs.filter(ref => ref.id !== parentId);
	}

	private clampSubagentNestedSelection(group: SubagentViewGroup, nestedIndex: number): number {
		const nestedRefs = this.getSubagentNestedRefs(group);
		if (nestedRefs.length === 0) return -1;
		if (nestedIndex < 0) return -1;
		return Math.max(0, Math.min(nestedIndex, nestedRefs.length - 1));
	}

	private getSubagentSelectionRef(group: SubagentViewGroup, nestedIndex: number): SubagentViewRef | undefined {
		const rootRef = this.getSubagentRootRef(group);
		if (nestedIndex < 0) return rootRef;
		const nestedRefs = this.getSubagentNestedRefs(group);
		return nestedRefs[nestedIndex];
	}

	private buildSubagentCycleSignature(groups: SubagentViewGroup[]): string {
		return groups.map(group => `${group.rootId}:${group.refs.map(ref => ref.id).join(",")}`).join("|");
	}

	private findSubagentSelection(
		groups: SubagentViewGroup[],
		id: string,
	): { groupIndex: number; refIndex: number } | undefined {
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const group = groups[groupIndex];
			if (!group) continue;
			if (id === group.rootId) {
				return { groupIndex, refIndex: -1 };
			}
			const nestedRefs = this.getSubagentNestedRefs(group);
			const refIndex = nestedRefs.findIndex(ref => ref.id === id);
			if (refIndex >= 0) {
				return { groupIndex, refIndex };
			}
		}
		return undefined;
	}

	private findMostRecentSubagentSelection(
		groups: SubagentViewGroup[],
	): { groupIndex: number; refIndex: number } | undefined {
		let best: { groupIndex: number; refIndex: number; score: number } | undefined;
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const group = groups[groupIndex];
			if (!group) continue;
			const rootRef = this.getSubagentRootRef(group);
			if (rootRef) {
				const rootScore = this.getSubagentRecencyScore(rootRef);
				if (!best || rootScore > best.score) {
					best = { groupIndex, refIndex: -1, score: rootScore };
				}
			}
			const nestedRefs = this.getSubagentNestedRefs(group);
			for (let refIndex = 0; refIndex < nestedRefs.length; refIndex += 1) {
				const ref = nestedRefs[refIndex];
				if (!ref) continue;
				const score = this.getSubagentRecencyScore(ref);
				if (!best || score > best.score) {
					best = { groupIndex, refIndex, score };
				}
			}
		}
		if (!best) return undefined;
		return { groupIndex: best.groupIndex, refIndex: best.refIndex };
	}

	private getSubagentHierarchy(id: string): { rootId: string; parentId?: string; depth: number } {
		const segments = id.split(".").filter(Boolean);
		const rootId = segments[0] ?? id;
		const parentId = segments.length > 1 ? segments.slice(0, -1).join(".") : undefined;
		return { rootId, parentId, depth: Math.max(0, segments.length - 1) };
	}

	private getSubagentRecencyScore(ref: SubagentViewRef): number {
		return ref.startedAt ?? ref.lastUpdatedMs ?? ref.lastSeenOrder ?? 0;
	}

	private getSubagentLastActivityScore(ref: SubagentViewRef): number {
		return ref.lastUpdatedMs ?? ref.lastSeenOrder ?? this.getSubagentRecencyScore(ref);
	}

	private closeSubagentSessionViewer(): void {
		const overlay = this.subagentSessionOverlay;
		this.subagentSessionOverlay = undefined;
		overlay?.hide();
		this.subagentSessionViewer = undefined;
	}

	private renderSubagentTextSection(title: string, bodyLines: string[]): string[] {
		if (bodyLines.length === 0) return [];
		return [
			theme.bold(theme.fg("warning", title)),
			...bodyLines.map(line => (line.length > 0 ? theme.fg("dim", line) : "")),
		];
	}

	private renderSubagentHeaderField(label: string, value: string, valueColor: ThemeColor = "text"): string {
		return `${theme.bold(theme.fg("accent", `${label}`))} ${theme.fg(valueColor, value)}`;
	}

	private renderSubagentTranscriptLines(transcript: LoadedSubagentTranscript, width: number): string[] {
		const lines: string[] = [];
		const pushSection = (title: string, bodyLines: string[]) => {
			const section = this.renderSubagentTextSection(title, bodyLines);
			if (section.length === 0) return;
			if (lines.length > 0) lines.push("");
			lines.push(...section);
		};
		const fallbackLines = transcript.content.split("\n").filter(line => line.length > 0);

		pushSection("Parent Session Context", transcript.parentContext?.split("\n").map(line => line.trimEnd()) ?? []);
		pushSection("Assignment", transcript.assignment?.split("\n").map(line => line.trimEnd()) ?? []);
		pushSection("Delegations", transcript.delegationHistory ?? []);

		const renderedTranscript =
			transcript.sessionContext && transcript.sessionContext.messages.length > 0
				? this.uiHelpers.renderSessionContextToLines(transcript.sessionContext, width)
				: fallbackLines;
		if (renderedTranscript.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(theme.bold(theme.fg("warning", "Transcript")));
			lines.push(...renderedTranscript);
		}

		return lines.length > 0 ? lines : [theme.fg("dim", "(no transcript content)")];
	}

	private buildSubagentDelegationHistory(selected: SubagentViewRef, group: SubagentViewGroup): string[] | undefined {
		const refsById = new Map(group.refs.map(ref => [ref.id, ref]));
		const selectedDepth = selected.depth ?? 0;
		const descendants = group.refs.filter(
			ref => ref.id !== selected.id && this.isSubagentDescendantOf(ref, selected.id, refsById),
		);
		if (descendants.length === 0) return undefined;
		return descendants.map(ref => {
			const relativeDepth = Math.max(0, (ref.depth ?? 0) - selectedDepth - 1);
			const indent = "  ".repeat(Math.min(relativeDepth, 6));
			const ordinal = this.extractSubagentOrdinal(ref.id);
			const title = this.clipPreview(
				ref.description ?? ref.contextPreview ?? this.extractSubagentTitleFromId(ref.id),
				80,
			);
			const outcome = ref.outcome ? ` [${ref.outcome.status.replace(/_/g, "-").toUpperCase()}]` : "";
			return `${indent}↳ (${ordinal}) ${ref.agent ?? "subagent"}${outcome} | ${title}`;
		});
	}

	private buildSubagentDelegationRoleChain(selected: SubagentViewRef, group: SubagentViewGroup): string[] | undefined {
		const refsById = new Map(group.refs.map(ref => [ref.id, ref]));
		const lineage: SubagentViewRef[] = [];
		const visited = new Set<string>();
		let current: SubagentViewRef | undefined = selected;
		while (current && !visited.has(current.id)) {
			lineage.push(current);
			visited.add(current.id);
			current = current.parentId ? refsById.get(current.parentId) : undefined;
		}
		lineage.reverse();
		const chain: string[] = [];
		const pushRole = (role: string | undefined): void => {
			const normalizedRole = role?.trim();
			if (!normalizedRole) return;
			if (chain[chain.length - 1] === normalizedRole) return;
			chain.push(normalizedRole);
		};
		for (const ref of lineage) {
			pushRole(ref.delegatorRole);
			pushRole(ref.delegateRole);
		}
		return chain.length > 0 ? chain : undefined;
	}

	private isSubagentDescendantOf(
		ref: SubagentViewRef,
		ancestorId: string,
		refsById: Map<string, SubagentViewRef>,
	): boolean {
		let parentId = ref.parentId;
		const visited = new Set<string>();
		while (parentId && !visited.has(parentId)) {
			if (parentId === ancestorId) return true;
			visited.add(parentId);
			parentId = refsById.get(parentId)?.parentId;
		}
		return false;
	}

	private async renderSubagentSession(
		selected: SubagentViewRef,
		transcript: LoadedSubagentTranscript,
		groups: SubagentViewGroup[],
	): Promise<void> {
		const leaderKey = this.keybindings.getDisplayString("cycleSubagentForward") || "Ctrl+X";
		const currentGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		const currentRefs = currentGroup.refs;
		const nestedRefs = this.getSubagentNestedRefs(currentGroup);
		const taskPosition = Math.max(0, this.subagentCycleIndex) + 1;
		const taskCount = groups.length;
		const nestedCount = nestedRefs.length;
		const isParentSelection = this.subagentNestedCycleIndex < 0;
		const nestedPosition = isParentSelection ? 0 : this.subagentNestedCycleIndex + 1;
		const resolvedSelectedAgent = selected.agent ?? transcript.agentName ?? transcript.role;
		const hierarchyLines = currentRefs.map(ref => {
			const depth = Math.max(0, ref.depth ?? 0);
			const indent = "  ".repeat(Math.min(depth, 6));
			const isRoot = depth === 0;
			const isSelected = ref.id === selected.id;
			const selector = isSelected ? theme.bold(theme.fg("accent", "▸")) : " ";
			const branch = isRoot ? "" : "↳ ";
			const ordinal = this.extractSubagentOrdinal(ref.id);
			const refAgent = ref.id === selected.id ? (ref.agent ?? resolvedSelectedAgent) : ref.agent;
			const agentName = this.clipPreview(this.getSubagentAgentLabel(refAgent), 24);
			const title = this.clipPreview(ref.description ?? this.extractSubagentTitleFromId(ref.id), 84);
			const line = `${indent}${branch}(${ordinal}) ${agentName} | ${title}`;
			const lineText = isSelected ? theme.fg("text", line) : theme.fg("dim", line);
			return ` ${selector} ${lineText}`;
		});
		const agentLabel = this.getSubagentAgentLabel(resolvedSelectedAgent);
		const requestedModelMeta = splitSubagentModelLabel(selected.model);
		const actualModelMeta = splitSubagentModelLabel(transcript.model);
		const requestedModelLabel = requestedModelMeta.model;
		const actualModelLabel = actualModelMeta.model;
		const modelLabel = actualModelLabel ?? requestedModelLabel ?? "default";
		const delegationHistory =
			transcript.delegationHistory ?? this.buildSubagentDelegationHistory(selected, currentGroup);
		const delegationChain = this.buildSubagentDelegationRoleChain(selected, currentGroup);
		const contextLabel = this.clipPreview(
			selected.description ?? selected.contextPreview ?? transcript.contextPreview ?? "(no context)",
			120,
		);
		const skillsUsed = transcript.skillsUsed ?? [];
		const skillsLabel = skillsUsed.length > 0 ? this.clipPreview(skillsUsed.join(", "), 120) : "none";
		const tokensValue = transcript.tokens ?? selected.tokens;
		const modelStatusLabel =
			requestedModelLabel && actualModelLabel && requestedModelLabel !== actualModelLabel
				? this.clipPreview(`${actualModelLabel} <- ${requestedModelLabel}`, 44)
				: this.clipPreview(modelLabel, 36);
		const statusSkillsLabel = this.clipPreview(skillsUsed.join(",") || "none", 32);
		const statusTokensLabel = typeof tokensValue === "number" ? tokensValue.toLocaleString() : "n/a";
		const statusContextLabel = this.clipPreview(contextLabel, 48);
		const statusSeparator = theme.fg("statusLineSep", theme.sep.dot);
		const nestedStatusLabel =
			nestedCount === 0
				? "0/0 descendants (root implied)"
				: isParentSelection
					? `0/${nestedCount} descendants (root implied)`
					: `${nestedPosition}/${nestedCount} descendants`;
		const statusAgentLabel =
			nestedCount === 0
				? "nested 0/0 root-implied"
				: isParentSelection
					? `nested 0/${nestedCount} root-implied`
					: `${nestedPosition}/${nestedCount} ${agentLabel}`;
		const headerLines = [
			theme.bold(theme.fg("accent", `Subagent session ${selected.id}`)),
			[
				this.renderSubagentHeaderField("Task", `${taskPosition}/${taskCount}`),
				this.renderSubagentHeaderField("Nested", nestedStatusLabel),
			].join(` ${theme.fg("statusLineSep", theme.sep.dot)} `),
			this.renderSubagentHeaderField("Context", contextLabel),
			this.renderSubagentHeaderField("Skills", skillsLabel, skillsUsed.length > 0 ? "text" : "muted"),
			this.renderSubagentHeaderField("Source", shortenPath(transcript.source), "muted"),
		];
		if (!this.subagentSessionViewer) {
			const viewer = new SubagentSessionViewerComponent({
				getTerminalRows: () => this.ui.terminal.rows,
				leaderKey,
				onClose: () => this.returnToNavigatorOrExit(),
				onNavigateRoot: direction => {
					void this.navigateSubagentView("root", direction);
				},
				onNavigateNested: direction => {
					void this.navigateSubagentView("nested", direction);
				},
				onCycleAgentMode: () => {
					void this.inputController.cycleAgentMode();
				},
				onStop: () => {
					const viewerGroups = this.getSnapshotGroups();
					const viewerGroup = viewerGroups[this.subagentCycleIndex] ?? viewerGroups[0];
					const currentSelection = viewerGroup
						? this.getSubagentSelectionRef(viewerGroup, this.subagentNestedCycleIndex)
						: undefined;
					if (!currentSelection) return;
					void this.stopSubagentSession(currentSelection);
				},
				onResume: () => {
					const viewerGroups = this.getSnapshotGroups();
					const viewerGroup = viewerGroups[this.subagentCycleIndex] ?? viewerGroups[0];
					const currentSelection = viewerGroup
						? this.getSubagentSelectionRef(viewerGroup, this.subagentNestedCycleIndex)
						: undefined;
					if (!currentSelection) return;
					void this.resumeSubagentSession(currentSelection);
				},
			});
			this.subagentSessionViewer = viewer;
			this.subagentSessionOverlay = this.ui.showOverlay(viewer, {
				width: "92%",
				maxHeight: "85%",
				anchor: "center",
				margin: 1,
			});
		}
		this.subagentSessionViewer.setContent({
			headerLines,
			hierarchyLines,
			renderTranscriptLines: width =>
				this.renderSubagentTranscriptLines(
					{
						...transcript,
						delegationHistory,
					},
					width,
				),
			nestedArrowMode: this.subagentNestedArrowMode,
			metadata: {
				agentName: this.getSubagentAgentLabel(resolvedSelectedAgent),
				subagentId: selected.id,
				sessionId: transcript.sessionId ?? selected.sessionId,
				role: resolvedSelectedAgent,
				delegationChain,
				provider: actualModelMeta.provider ?? selected.provider,
				model: actualModelLabel ?? requestedModelLabel,
				tokens: transcript.tokens ?? selected.tokens,
				tokenCapacity: selected.tokenCapacity,
				status: selected.status,
				thinkingLevel: selected.thinkingLevel,
				elapsedMs: selected.elapsedMs,
				toolNames: transcript.toolNames ?? selected.toolNames,
				mcpServers: transcript.mcpServers ?? selected.mcpServers,
				mcpAllowlist: transcript.mcpAllowlist ?? selected.mcpAllowlist,
				abortReason: selected.abortReason,
				outcome: selected.outcome,
				canStop: selected.status === "running" || selected.status === "pending",
				canResume: (selected.status === "cancelled" || selected.status === "user_stopped") && !!selected.sessionPath,
				...(transcript.editStats ?? {}),
			},
		});
		this.statusLine.setHookStatus(
			SUBAGENT_VIEWER_STATUS_KEY,
			[
				renderSubagentStatusBadge(),
				`${theme.bold(theme.fg("statusLineSubagents", `task ${taskPosition}/${taskCount}`))} ${theme.bold(theme.fg("accent", selected.id))}`,
				renderSubagentStatusField("agent", statusAgentLabel, "statusLineSubagents"),
				renderSubagentStatusField("model", modelStatusLabel, "statusLineModel"),
				renderSubagentStatusField("skills", statusSkillsLabel, "statusLinePath"),
				renderSubagentStatusField("tokens", statusTokensLabel, "statusLineSpend"),
				renderSubagentStatusField("ctx", statusContextLabel, "statusLineContext"),
			].join(statusSeparator),
		);
		this.ui.requestRender();
	}

	private collectSkillNamesFromValue(value: unknown, names: Set<string>): void {
		if (typeof value === "string") {
			for (const match of value.matchAll(/skill:\/\/([^/\s"'`?#]+)/g)) {
				const name = match[1]?.trim();
				if (name) names.add(name);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				this.collectSkillNamesFromValue(item, names);
			}
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const nestedValue of Object.values(value as Record<string, unknown>)) {
			this.collectSkillNamesFromValue(nestedValue, names);
		}
	}

	private extractToolReferencedSkillNames(message: unknown): string[] {
		if (!message || typeof message !== "object") return [];
		const record = message as Record<string, unknown>;
		const names = new Set<string>();
		const content = record.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const toolCall = block as Record<string, unknown>;
				if (toolCall.type !== "toolCall") continue;
				this.collectSkillNamesFromValue(toolCall.arguments, names);
			}
		}
		this.collectSkillNamesFromValue(record.details, names);
		return Array.from(names);
	}

	private extractSkillPromptName(message: unknown): string | undefined {
		if (!message || typeof message !== "object") return undefined;
		const record = message as Record<string, unknown>;
		const isSkillPrompt =
			record.customType === SKILL_PROMPT_MESSAGE_TYPE &&
			(record.role === "custom" || record.type === "custom_message");
		if (!isSkillPrompt) {
			return undefined;
		}
		const details = record.details;
		if (!details || typeof details !== "object") return undefined;
		const name = (details as Record<string, unknown>).name;
		return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
	}

	private extractSubagentEditStats(
		entries: SessionEntry[],
	): { filesChanged: number; linesAdded: number; linesDeleted: number } | undefined {
		const filePaths = new Set<string>();
		let linesAdded = 0;
		let linesDeleted = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message as {
				role?: string;
				toolName?: string;
				content?: Array<{ type: string; text?: string }>;
			};
			if (msg.role !== "toolResult") continue;
			if (msg.toolName !== "edit" && msg.toolName !== "write") continue;
			const textContent =
				(msg.content ?? []).find(c => c.type === "text")?.text ?? "";
			if (msg.toolName === "edit") {
				const pathMatch = /^Updated\s+(.+?)$/m.exec(textContent);
				if (pathMatch?.[1]) filePaths.add(pathMatch[1].trim());
				const changesMatch = /^Changes:\s*\+(\d+)\s+-(\d+)/m.exec(textContent);
				if (changesMatch) {
					linesAdded += Number(changesMatch[1]) || 0;
					linesDeleted += Number(changesMatch[2]) || 0;
				}
			} else if (msg.toolName === "write") {
				const pathMatch = /Successfully wrote\s+\S+\s+to\s+(.+?)$/.exec(textContent);
				if (pathMatch?.[1]) filePaths.add(pathMatch[1].trim());
			}
		}
		if (filePaths.size === 0) return undefined;
		return { filesChanged: filePaths.size, linesAdded, linesDeleted };
	}

	private extractUsedSkillNamesFromEntries(entries: SessionEntry[]): string[] | undefined {
		const explicitNames = new Set<string>();
		for (const entry of entries) {
			const skillPromptName = this.extractSkillPromptName(entry);
			if (skillPromptName) {
				explicitNames.add(skillPromptName);
			}
			if (entry.type !== "message") continue;
			for (const skill of this.extractToolReferencedSkillNames(entry.message)) {
				explicitNames.add(skill);
			}
		}
		return explicitNames.size > 0 ? Array.from(explicitNames) : undefined;
	}

	private extractSubagentOrdinal(id: string): string {
		const tail = id.split(".").pop() ?? id;
		const dashIndex = tail.indexOf("-");
		if (dashIndex > 0) {
			return tail.slice(0, dashIndex);
		}
		return tail;
	}

	private getSubagentAgentLabel(agent?: string): string {
		return agent ?? "—";
	}

	private extractSubagentTitleFromId(id: string): string {
		const tail = id.split(".").pop() ?? id;
		const dashIndex = tail.indexOf("-");
		if (dashIndex >= 0 && dashIndex < tail.length - 1) {
			return tail
				.slice(dashIndex + 1)
				.replace(/[_-]+/g, " ")
				.trim();
		}
		return tail.replace(/[_-]+/g, " ").trim();
	}

	private clipPreview(text: string, maxChars: number): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length <= maxChars) return normalized;
		return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
	}

	private readSubagentStringArray(value: unknown): string[] | undefined {
		if (!Array.isArray(value)) return undefined;
		const items = value
			.filter((item): item is string => typeof item === "string")
			.map(item => item.trim())
			.filter(item => item.length > 0);
		return items.length > 0 ? items : undefined;
	}

	private resolveSubagentContextFilePath(contextFilePath: string | undefined): string | undefined {
		if (!contextFilePath) return undefined;
		if (!contextFilePath.startsWith("local://")) return contextFilePath;
		if (!this.sessionManager) return contextFilePath;
		return resolveLocalUrlToPath(contextFilePath, {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
	}

	private async readSubagentContextFile(contextFilePath: string | undefined): Promise<string | undefined> {
		const resolvedPath = this.resolveSubagentContextFilePath(contextFilePath);
		if (!resolvedPath) return undefined;
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) return undefined;
			logger.warn("Failed to read subagent parent context file", {
				path: resolvedPath,
				error: String(error),
			});
			return undefined;
		}
	}

	private getLatestAssistantMessageUsageTokens(entries: ReadonlyArray<unknown>): number {
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (record.type !== "message") continue;
			const message = record.message;
			if (!message || typeof message !== "object") continue;
			if ((message as { role?: unknown }).role !== "assistant") continue;
			const usageTokens = getTotalUsageTokens((message as { usage?: unknown }).usage);
			if (typeof usageTokens === "number") return usageTokens;
		}

		return 0;
	}

	private buildFallbackSubagentSessionContext(rawTranscript: string): {
		sessionContext?: SessionContext;
		agentName?: string;
		role?: string;
		model?: string;
		tokens?: number;
		contextPreview?: string;
		skillsUsed?: string[];
		sessionId?: string;
		assignment?: string;
		toolNames?: string[];
		mcpServers?: string[];
		mcpAllowlist?: string[];
		contextFilePath?: string;
	} {
		const entries = parseJsonlLenient<Record<string, unknown>>(rawTranscript);
		if (entries.length === 0) {
			return {};
		}

		const messages: AgentMessage[] = [];
		let agentName: string | undefined;
		let role: string | undefined;
		let model: string | undefined;
		let thinkingLevel = "high";
		let mode = "none";
		let modeData: Record<string, unknown> | undefined;
		let contextPreview: string | undefined;
		let assignment: string | undefined;
		let sessionId: string | undefined;
		let toolNames: string[] | undefined;
		let mcpServers: string[] | undefined;
		let mcpAllowlist: string[] | undefined;
		let contextFilePath: string | undefined;
		const skillsUsed = this.extractUsedSkillNamesFromEntries(entries as SessionEntry[]);
		const tokens = this.getLatestAssistantMessageUsageTokens(entries);

		for (const entry of entries) {
			if (entry.type === "session" && typeof entry.id === "string" && !sessionId) {
				sessionId = entry.id;
				continue;
			}
			if (entry.type === "model_change" && typeof entry.model === "string") {
				model = entry.model;
				role = typeof entry.role === "string" && entry.role.trim().length > 0 ? entry.role : role;
				continue;
			}

			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
				thinkingLevel = entry.thinkingLevel;
				continue;
			}

			if (entry.type === "mode_change" && typeof entry.mode === "string") {
				mode = entry.mode;
				modeData =
					entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : undefined;
				continue;
			}

			if (entry.type === "session_init" && typeof entry.task === "string") {
				agentName =
					typeof entry.agentName === "string" && entry.agentName.trim().length > 0 ? entry.agentName : agentName;
				assignment ??= entry.task;
				contextPreview ??= extractTaskContextPreview(entry.task);
				sessionId =
					(typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0
						? entry.sessionId
						: sessionId) ?? sessionId;
				toolNames = this.readSubagentStringArray(entry.tools) ?? toolNames;
				mcpServers = this.readSubagentStringArray(entry.mcpServers) ?? mcpServers;
				mcpAllowlist = this.readSubagentStringArray(entry.mcpAllowlist) ?? mcpAllowlist;
				contextFilePath =
					typeof entry.contextFile === "string" && entry.contextFile.trim().length > 0
						? entry.contextFile
						: contextFilePath;
				continue;
			}

			if (entry.type !== "message") {
				continue;
			}

			const message = entry.message;
			if (!message || typeof message !== "object") {
				continue;
			}

			const messageRole = (message as { role?: unknown }).role;
			if (typeof messageRole !== "string") {
				continue;
			}

			messages.push(message as AgentMessage);
		}

		if (messages.length === 0) {
			return {
				agentName,
				role: agentName ?? role,
				model,
				tokens: tokens > 0 ? tokens : undefined,
				contextPreview,
				skillsUsed,
				sessionId,
				assignment,
				toolNames,
				mcpServers,
				mcpAllowlist,
				contextFilePath: this.resolveSubagentContextFilePath(contextFilePath),
			};
		}

		const sessionContext: SessionContext = {
			messages,
			thinkingLevel,
			models: model ? { default: model } : {},
			injectedTtsrRules: [],
			mode,
			modeData,
		};

		return {
			sessionContext,
			agentName,
			role: agentName ?? role,
			model,
			tokens: tokens > 0 ? tokens : undefined,
			contextPreview,
			skillsUsed,
			sessionId,
			assignment,
			toolNames,
			mcpServers,
			mcpAllowlist,
			contextFilePath: this.resolveSubagentContextFilePath(contextFilePath),
		};
	}

	private async loadSubagentTranscript(ref: SubagentViewRef): Promise<LoadedSubagentTranscript | undefined> {
		if (ref.sessionPath) {
			try {
				const rawTranscript = await Bun.file(ref.sessionPath).text();
				try {
					const subSession = await SessionManager.open(ref.sessionPath);
					const entries = subSession.getEntries();
					const latestModelEntry = [...entries].reverse().find(entry => entry.type === "model_change");
					const sessionInitEntry = entries.find(
						(entry): entry is SessionInitEntry => entry.type === "session_init",
					);
					const latestModel = latestModelEntry?.type === "model_change" ? latestModelEntry.model : undefined;
					const latestRole = latestModelEntry?.type === "model_change" ? latestModelEntry.role : undefined;
					const sessionTask = sessionInitEntry?.task;
					const skillsUsed = this.extractUsedSkillNamesFromEntries(entries);
					const tokensTotal = this.getLatestAssistantMessageUsageTokens(entries);
					const tokens = tokensTotal > 0 ? tokensTotal : undefined;
					const sessionContext = subSession.buildSessionContext();
					const header = subSession.getHeader();
					const contextFilePath = this.resolveSubagentContextFilePath(sessionInitEntry?.contextFile);
					const parentContext = await this.readSubagentContextFile(contextFilePath);
					const editStats = this.extractSubagentEditStats(entries);

					if (sessionContext.messages.length === 0) {
						const fallback = this.buildFallbackSubagentSessionContext(rawTranscript);
						return {
							source: ref.sessionPath,
							content: rawTranscript,
							sessionContext: fallback.sessionContext,
							agentName: sessionInitEntry?.agentName ?? fallback.agentName ?? ref.agent,
							role: sessionInitEntry?.agentName ?? latestRole ?? fallback.role ?? ref.agent,
							model: latestModel ?? fallback.model,
							tokens: fallback.tokens ?? tokens,
							contextPreview: sessionTask ? extractTaskContextPreview(sessionTask) : fallback.contextPreview,
							skillsUsed: skillsUsed ?? fallback.skillsUsed,
							sessionId: sessionInitEntry?.sessionId ?? header?.id ?? fallback.sessionId ?? ref.sessionId,
							assignment: sessionTask ?? fallback.assignment,
							toolNames: sessionInitEntry?.tools ?? fallback.toolNames,
							mcpServers: sessionInitEntry?.mcpServers ?? fallback.mcpServers,
							mcpAllowlist: sessionInitEntry?.mcpAllowlist ?? fallback.mcpAllowlist,
							contextFilePath: contextFilePath ?? fallback.contextFilePath,
						parentContext: parentContext ?? (await this.readSubagentContextFile(fallback.contextFilePath)),
						...(editStats ? { editStats } : {}),
					};
				}

					return {
						source: ref.sessionPath,
						content: rawTranscript,
						sessionContext,
						agentName: sessionInitEntry?.agentName ?? ref.agent,
						role: sessionInitEntry?.agentName ?? latestRole ?? ref.agent,
						model: latestModel,
						tokens,
						contextPreview: sessionTask ? extractTaskContextPreview(sessionTask) : undefined,
						skillsUsed,
						sessionId: sessionInitEntry?.sessionId ?? header?.id ?? ref.sessionId,
						assignment: sessionTask,
						toolNames: sessionInitEntry?.tools,
						mcpServers: sessionInitEntry?.mcpServers,
						mcpAllowlist: sessionInitEntry?.mcpAllowlist,
						contextFilePath,
					parentContext,
					...(editStats ? { editStats } : {}),
				};
			} catch {
					const fallback = this.buildFallbackSubagentSessionContext(rawTranscript);
					return {
						source: ref.sessionPath,
						content: rawTranscript,
						sessionContext: fallback.sessionContext,
						agentName: fallback.agentName ?? ref.agent,
						role: fallback.role ?? ref.agent,
						model: fallback.model,
						tokens: fallback.tokens,
						contextPreview: fallback.contextPreview,
						skillsUsed: fallback.skillsUsed,
						sessionId: fallback.sessionId ?? ref.sessionId,
						assignment: fallback.assignment,
						toolNames: fallback.toolNames,
						mcpServers: fallback.mcpServers,
						mcpAllowlist: fallback.mcpAllowlist,
						contextFilePath: fallback.contextFilePath,
						parentContext: await this.readSubagentContextFile(fallback.contextFilePath),
					};
				}
			} catch (error) {
				if (!isEnoent(error)) {
					logger.warn("Failed to read subagent session transcript", {
						path: ref.sessionPath,
						error: String(error),
					});
				}
			}
		}

		if (ref.outputPath) {
			try {
				return {
					source: ref.outputPath,
					content: await Bun.file(ref.outputPath).text(),
				};
			} catch (error) {
				if (!isEnoent(error)) {
					logger.warn("Failed to read subagent output transcript", {
						path: ref.outputPath,
						error: String(error),
					});
				}
			}
		}

		if (ref.sessionPath) {
			// Session path is known but file doesn't exist yet - subagent is initializing
			return {
				source: ref.sessionPath,
				content: "",
				contextPreview: "(session initializing...)",
			};
		}

		return undefined;
	}

	private async loadTokensFromSessionPath(sessionPath: string): Promise<number | undefined> {
		try {
			const rawTranscript = await Bun.file(sessionPath).text();
			const entries = parseJsonlLenient<Record<string, unknown>>(rawTranscript);
			const tokens = this.getLatestAssistantMessageUsageTokens(entries);
			return tokens > 0 ? tokens : undefined;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to load subagent token usage from transcript", {
					path: sessionPath,
					error: String(error),
				});
			}
			return undefined;
		}
	}

	private async loadMissingTokensForGroups(groups: SubagentViewGroup[]): Promise<void> {
		const allRefs = groups.flatMap(g => g.refs);
		const refsNeedingTokens = allRefs.filter(ref => typeof ref.tokens !== "number" && ref.sessionPath);
		for (const ref of refsNeedingTokens) {
			if (!ref.sessionPath) continue;
			if (!this.subagentNavigatorComponent || this.subagentNavigatorGroups !== groups) break;
			const tokens = await this.loadTokensFromSessionPath(ref.sessionPath);
			if (typeof tokens === "number") ref.tokens = tokens;
			if (this.subagentNavigatorComponent && this.subagentNavigatorGroups === groups) {
				this.subagentNavigatorComponent.setGroups(groups, this.subagentNavigatorComponent.getSelection());
				this.ui.requestRender();
			}
		}
	}

	handleBackgroundCommand(): void {
		this.inputController.handleBackgroundCommand();
	}

	handleImagePaste(): Promise<boolean> {
		return this.inputController.handleImagePaste();
	}

	cycleThinkingLevel(): void {
		this.inputController.cycleThinkingLevel();
	}

	cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		return this.inputController.cycleRoleModel(options);
	}

	toggleToolOutputExpansion(): void {
		this.inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[]): void {
		this.todoItems = todos;
		this.renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: unknown): void {
		this.extensionUiController.setHookWidget(key, content);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.extensionUiController.showHookSelector(title, options, dialogOptions);
	}

	hideHookSelector(): void {
		this.extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.extensionUiController.hideHookInput();
	}

	showHookEditor(title: string, prefill?: string): Promise<string | undefined> {
		return this.extensionUiController.showHookEditor(title, prefill);
	}

	hideHookEditor(): void {
		this.extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T> {
		return this.extensionUiController.showHookCustom(factory);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.extensionUiController.showToolError(toolName, error);
	}

	private subscribeToAgent(): void {
		this.eventController.subscribeToAgent();
	}
}

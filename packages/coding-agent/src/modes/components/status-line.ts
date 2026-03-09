import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { $ } from "bun";
import { settings } from "../../config/settings";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import {
	type FlattenedWorkflowMenuAction,
	flattenWorkflowMenuActions,
	WORKFLOW_MENUS,
	type WorkflowMenu,
} from "../action-buttons";
import { getPreset } from "./status-line/presets";
import { renderSegment, type SegmentContext } from "./status-line/segments";
import { getSeparator } from "./status-line/separators";

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
}

const SUBAGENT_VIEWER_STATUS_KEY = "subagent-viewer";
const LEGACY_WORKTREE_HOOK_STATUS_KEYS = new Set(["bbb-wt-sync", "zzzz-0-spacer", "zzzz-wt-delete"]);
type WorkflowActionState = "hidden" | "disabled" | "enabled";
const MENU_SELECTED_TAG_ANSI = "\x1b[1m\x1b[30;106m";
const MENU_ENABLED_TAG_ANSI = "\x1b[36m";
const MENU_DISABLED_TAG_ANSI = "\x1b[90m";
const MENU_SELECTED_TEXT_ANSI = "\x1b[1;97m";
const MENU_DISABLED_TEXT_ANSI = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

// ═══════════════════════════════════════════════════════════════════════════
// Rendering Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Sanitize text for display in a single-line status */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function readWorktreeHeadPath(gitFilePath: string): string | null {
	try {
		const raw = fs.readFileSync(gitFilePath, "utf8").trim();
		const match = raw.match(/^gitdir:\s*(.+)$/i);
		if (!match) return null;
		const gitDir = match[1].trim();
		const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(path.dirname(gitFilePath), gitDir);
		const headPath = path.join(resolvedGitDir, "HEAD");
		return fs.existsSync(headPath) ? headPath : null;
	} catch {
		return null;
	}
}

/** Find HEAD file path by walking up from cwd; supports normal repos and worktrees (.git file). */
function findGitHeadPath(cwd: string = process.cwd()): string | null {
	let dir = cwd;
	while (true) {
		const gitPath = path.join(dir, ".git");
		try {
			const stat = fs.lstatSync(gitPath);
			if (stat.isDirectory()) {
				const headPath = path.join(gitPath, "HEAD");
				if (fs.existsSync(headPath)) return headPath;
			} else if (stat.isFile()) {
				const worktreeHead = readWorktreeHeadPath(gitPath);
				if (worktreeHead) return worktreeHead;
			}
		} catch {
			// not a git boundary at this level
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	private settings: StatusLineSettings = {};
	private cachedBranch: string | null | undefined = undefined;
	private cachedBranchCwd: string | undefined;
	private gitWatcher: fs.FSWatcher | null = null;
	private watchedHeadPath: string | null = null;
	private onBranchChange: (() => void) | null = null;
	private autoCompactEnabled: boolean = true;
	private hookStatuses: Map<string, string> = new Map();
	private subagentCount: number = 0;
	private sessionStartTime: number = Date.now();
	private planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	private workflowActionStates: Map<string, WorkflowActionState> = new Map();
	private activeMenuId: string | undefined;
	private activeMenuSelectedIndex: number = 0;

	// Git status caching (1s TTL)
	private cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	private gitStatusLastFetch = 0;

	constructor(private readonly session: AgentSession) {
		this.settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
		};
	}

	updateSettings(settings: StatusLineSettings): void {
		this.settings = settings;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.subagentCount = count;
	}

	setSessionStartTime(time: number): void {
		this.sessionStartTime = time;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.planModeStatus = status ?? null;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.hookStatuses.delete(key);
		} else {
			this.hookStatuses.set(key, text);
		}
	}

	getHookStatus(key: string): string | undefined {
		return this.hookStatuses.get(key);
	}

	setWorkflowActionState(actionId: string, state: WorkflowActionState): void {
		this.workflowActionStates.set(actionId, state);
		if (!this.activeMenuId) return;

		const activeMenu = this.getWorkflowMenu(this.activeMenuId);
		if (!activeMenu) return;

		const visibleActions = this.getVisibleMenuActions(activeMenu);
		if (visibleActions.length === 0) {
			this.activeMenuSelectedIndex = 0;
			return;
		}

		const selectedAction = visibleActions[this.activeMenuSelectedIndex];
		if (!selectedAction || this.getActionState(selectedAction.id) !== "enabled") {
			const nextSelected = this.findNextSelectableIndex(visibleActions, this.activeMenuSelectedIndex, 1);
			if (nextSelected !== undefined) {
				this.activeMenuSelectedIndex = nextSelected;
			}
		}
	}

	toggleMenu(menuId: string): void {
		if (this.activeMenuId === menuId) {
			this.closeMenu();
			return;
		}

		const menu = this.getWorkflowMenu(menuId);
		if (!menu) return;

		this.activeMenuId = menuId;
		const visibleActions = this.getVisibleMenuActions(menu);
		this.activeMenuSelectedIndex = this.findNextSelectableIndex(visibleActions, -1, 1) ?? 0;
	}

	closeMenu(): void {
		this.activeMenuId = undefined;
		this.activeMenuSelectedIndex = 0;
	}

	getActiveMenu(): string | undefined {
		return this.activeMenuId;
	}

	navigateMenu(direction: number): void {
		if (!this.activeMenuId || direction === 0) return;

		const menu = this.getWorkflowMenu(this.activeMenuId);
		if (!menu) return;

		const visibleActions = this.getVisibleMenuActions(menu);
		if (visibleActions.length === 0) return;

		const step: 1 | -1 = direction > 0 ? 1 : -1;
		const nextSelected = this.findNextSelectableIndex(visibleActions, this.activeMenuSelectedIndex, step);
		if (nextSelected !== undefined) {
			this.activeMenuSelectedIndex = nextSelected;
		}
	}

	executeSelectedMenuAction(): FlattenedWorkflowMenuAction | undefined {
		if (!this.activeMenuId) return undefined;

		const menu = this.getWorkflowMenu(this.activeMenuId);
		if (!menu) return undefined;

		const visibleActions = this.getVisibleMenuActions(menu);
		if (visibleActions.length === 0) return undefined;

		let selectedIndex = this.activeMenuSelectedIndex;
		const selectedAction = visibleActions[selectedIndex];
		if (!selectedAction || this.getActionState(selectedAction.id) !== "enabled") {
			const nextSelected = this.findNextSelectableIndex(visibleActions, selectedIndex, 1);
			if (nextSelected === undefined) return undefined;
			selectedIndex = nextSelected;
			this.activeMenuSelectedIndex = nextSelected;
		}

		const action = visibleActions[selectedIndex];
		if (!action || this.getActionState(action.id) !== "enabled") return undefined;

		this.closeMenu();
		return action;
	}

	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		const currentCwd = process.cwd();
		const gitHeadPath = findGitHeadPath(currentCwd);
		if (this.watchedHeadPath === gitHeadPath && this.gitWatcher) {
			return;
		}

		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
		this.watchedHeadPath = gitHeadPath;

		if (!gitHeadPath) return;

		try {
			this.gitWatcher = fs.watch(gitHeadPath, () => {
				this.cachedBranch = undefined;
				this.cachedBranchCwd = undefined;
				if (this.onBranchChange) {
					this.onBranchChange();
				}
			});
		} catch {
			// Silently fail
		}
	}

	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
		this.watchedHeadPath = null;
	}

	invalidate(): void {
		this.cachedBranch = undefined;
		this.cachedBranchCwd = undefined;
	}

	private getCurrentBranch(): string | null {
		const currentCwd = process.cwd();
		if (this.cachedBranchCwd !== currentCwd) {
			this.cachedBranch = undefined;
			this.cachedBranchCwd = currentCwd;
			this.cachedGitStatus = null;
			this.gitStatusLastFetch = 0;
			this.setupGitWatcher();
		}

		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		const gitHeadPath = findGitHeadPath(currentCwd);
		if (!gitHeadPath) {
			this.cachedBranch = null;
			return null;
		}
		try {
			const content = fs.readFileSync(gitHeadPath, "utf8").trim();

			if (content.startsWith("ref: refs/heads/")) {
				this.cachedBranch = content.slice(16);
			} else {
				this.cachedBranch = "detached";
			}
		} catch {
			this.cachedBranch = null;
		}

		return this.cachedBranch ?? null;
	}

	private getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		const now = Date.now();
		if (now - this.gitStatusLastFetch < 1000) {
			return this.cachedGitStatus;
		}

		// Fire async fetch, return cached value
		(async () => {
			try {
				const result = await $`git status --porcelain`.quiet().nothrow();

				if (result.exitCode !== 0) {
					this.cachedGitStatus = null;
					this.gitStatusLastFetch = now;
					return;
				}

				const output = result.stdout.toString();

				let staged = 0;
				let unstaged = 0;
				let untracked = 0;

				for (const line of output.split("\n")) {
					if (!line) continue;
					const x = line[0];
					const y = line[1];

					if (x === "?" && y === "?") {
						untracked++;
						continue;
					}

					if (x && x !== " " && x !== "?") {
						staged++;
					}

					if (y && y !== " ") {
						unstaged++;
					}
				}

				this.cachedGitStatus = { staged, unstaged, untracked };
				this.gitStatusLastFetch = now;
			} catch {
				this.cachedGitStatus = null;
				this.gitStatusLastFetch = now;
			}
		})();

		return this.cachedGitStatus;
	}

	private getActionState(actionId: string): WorkflowActionState {
		return this.workflowActionStates.get(actionId) ?? "enabled";
	}

	private getWorkflowMenu(menuId: string): WorkflowMenu | undefined {
		return WORKFLOW_MENUS.find(menu => menu.id === menuId);
	}

	private getVisibleMenuActions(menu: WorkflowMenu): FlattenedWorkflowMenuAction[] {
		return flattenWorkflowMenuActions(menu).filter(action => this.getActionState(action.id) !== "hidden");
	}

	private findNextSelectableIndex(
		actions: FlattenedWorkflowMenuAction[],
		startIndex: number,
		direction: 1 | -1,
	): number | undefined {
		if (actions.length === 0) return undefined;

		for (let offset = 1; offset <= actions.length; offset++) {
			const index = (startIndex + direction * offset + actions.length) % actions.length;
			if (this.getActionState(actions[index].id) === "enabled") {
				return index;
			}
		}

		return undefined;
	}

	private renderWorkflowMenus(width: number): string[] {
		if (WORKFLOW_MENUS.length === 0) return [];

		const topLevelMenus = WORKFLOW_MENUS.map(menu => {
			const active = menu.id === this.activeMenuId;
			const menuText = ` ${menu.label} `;
			const style = active ? MENU_SELECTED_TAG_ANSI : MENU_ENABLED_TAG_ANSI;
			return `${style}${menuText}${ANSI_RESET}`;
		});

		const lines = [truncateToWidth(topLevelMenus.join(" "), width)];
		if (!this.activeMenuId) return lines;

		const activeMenu = this.getWorkflowMenu(this.activeMenuId);
		if (!activeMenu) return lines;

		const visibleActions = this.getVisibleMenuActions(activeMenu);
		for (let index = 0; index < visibleActions.length; index++) {
			const action = visibleActions[index];
			const actionState = this.getActionState(action.id);
			const isSelected = index === this.activeMenuSelectedIndex;

			const actionLabelStyle =
				actionState === "disabled" ? MENU_DISABLED_TEXT_ANSI : isSelected ? MENU_SELECTED_TEXT_ANSI : "";
			const actionLabel = actionLabelStyle
				? `${actionLabelStyle}${action.baseLabel}${ANSI_RESET}`
				: action.baseLabel;

			if (action.groupLabel) {
				const tagStyle =
					actionState === "disabled"
						? MENU_DISABLED_TAG_ANSI
						: isSelected
							? MENU_SELECTED_TAG_ANSI
							: MENU_ENABLED_TAG_ANSI;
				lines.push(truncateToWidth(`└ ${tagStyle}[${action.groupLabel}]${ANSI_RESET} ${actionLabel}`, width));
				continue;
			}

			lines.push(truncateToWidth(actionLabel, width));
		}

		return lines;
	}

	private buildSegmentContext(width: number): SegmentContext {
		const state = this.session.state;

		// Get usage statistics
		const usageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		};

		// Get context percentage
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find(m => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		return {
			session: this.session,
			width,
			options: this.resolveSettings().segmentOptions ?? {},
			planMode: this.planModeStatus,
			usageStats: { ...usageStats, tokensPerSecond: usageStats.tokensPerSecond ?? null },
			contextPercent,
			contextWindow,
			autoCompactEnabled: this.autoCompactEnabled,
			subagentCount: this.subagentCount,
			sessionStartTime: this.sessionStartTime,
			git: {
				branch: this.getCurrentBranch(),
				status: this.getGitStatus(),
				pr: null,
			},
		};
	}

	private resolveSettings(): Required<
		Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
	> &
		StatusLineSettings {
		const preset = this.settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.settings,
			leftSegments,
			rightSegments,
			separator: this.settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	private buildStatusLine(width: number): string {
		const ctx = this.buildSegmentContext(width);
		const effectiveSettings = this.resolveSettings();
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		const bgAnsi = theme.getBgAnsi("statusLineBg");
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		// Collect visible segment contents
		const leftParts: string[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const topFillWidth = width > 0 ? Math.max(0, width - 4) : 0;
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		const leftCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap = separatorDef.endCaps
				? direction === "left"
					? separatorDef.endCaps.right
					: separatorDef.endCaps.left
				: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		return leftGroup + padding(gapWidth) + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		const content = this.buildStatusLine(width);
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): string[] {
		const lines = this.renderWorkflowMenus(width);

		const showHooks = this.settings.showHookStatus ?? true;
		if (!showHooks || this.hookStatuses.size === 0) {
			return lines;
		}

		const subagentStatus = this.hookStatuses.get(SUBAGENT_VIEWER_STATUS_KEY);
		if (subagentStatus) {
			lines.push(truncateToWidth(sanitizeStatusText(subagentStatus), width));
			return lines;
		}

		const sortedStatuses = Array.from(this.hookStatuses.entries())
			.filter(([key]) => !LEGACY_WORKTREE_HOOK_STATUS_KEYS.has(key))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		if (sortedStatuses.length === 0) {
			return lines;
		}
		const hookLine = sortedStatuses.join(" ");
		lines.push(truncateToWidth(hookLine, width));
		return lines;
	}
}

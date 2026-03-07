/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, UsageReport } from "@oh-my-pi/pi-ai";
import type { Component, Loader, SlashCommand, TerminalMouseEvent } from "@oh-my-pi/pi-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	truncateToWidth,
	TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { $env, isEnoent, logger, parseJsonlLenient, postmortem } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { KeybindingsManager } from "../config/keybindings";
import { renderPromptTemplate } from "../config/prompt-templates";
import { type Settings, settings } from "../config/settings";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../internal-urls";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import type { SessionContext, SessionManager } from "../session/session-manager";
import { getRecentSessions } from "../session/session-manager";
import type { ExitPlanModeDetails } from "../tools";
import { setTerminalTitle } from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import type { PythonExecutionComponent } from "./components/python-execution";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { WelcomeComponent } from "./components/welcome";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { SelectorController } from "./controllers/selector-controller";
import { setMermaidRenderCallback } from "./theme/mermaid-cache";
import type { Theme, ThemeColor } from "./theme/theme";
import { getEditorTheme, getMarkdownTheme, onThemeChange, theme } from "./theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, TodoItem } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

/** Conditional startup debug prints (stderr) when PI_DEBUG_STARTUP is set */
const debugStartup = $env.PI_DEBUG_STARTUP ? (stage: string) => process.stderr.write(`[startup] ${stage}\n`) : () => {};

const TODO_FILE_NAME = "todos.json";
const PLAN_WORKFLOW_STATUS_KEY = "aaa-wt-worktree";
const SYNC_NEEDED_STATUS_KEY = "bbb-wt-sync";
const IMPLEMENT_WORKFLOW_STATUS_KEY = "ccc-wt-git";
const REVIEW_COMPLETE_STATUS_KEY = "ddd-wt-review";
const CLEANUP_WORKFLOW_STATUS_KEY = "eee-wt-cleanup";
const PLAN_REVIEW_STATUS_KEY = "fff-wt-plan-review";
const FIX_PLAN_STATUS_KEY = "ggg-wt-fix-plan";
const DELETE_WORKTREE_STATUS_KEY = "zzzz-wt-delete";
const SUBAGENT_VIEWER_STATUS_KEY = "subagent-viewer";
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

interface ActionButtonUi {
	label: string;
	command: string;
	statusKey: string;
	normalText: string;
	hoverText: string;
	editorText?: string;
}

interface SubagentViewRef {
	id: string;
	sessionPath?: string;
	outputPath?: string;
	agent?: string;
	description?: string;
	model?: string;
	tokens?: number;
	contextPreview?: string;
	rootId?: string;
	parentId?: string;
	depth?: number;
	lastUpdatedMs?: number;
	lastSeenOrder?: number;
}

interface SubagentViewGroup {
	rootId: string;
	refs: SubagentViewRef[];
	lastUpdatedMs: number;
}

interface LoadedSubagentTranscript {
	source: string;
	content: string;
	sessionContext?: SessionContext;
	model?: string;
	tokens?: number;
	contextPreview?: string;
	skillsUsed?: string[];
}

interface SubagentNavigatorSelection {
	groupIndex: number;
	nestedIndex: number;
}

class SubagentNavigatorComponent extends Container {
	private groups: SubagentViewGroup[] = [];
	private flatRefs: Array<{ ref: SubagentViewRef; groupIdx: number; nestedIdx: number; isRoot: boolean }> = [];
	private flatIndex = 0;
	private scrollOffset = 0;
	private readonly MAX_VISIBLE = 18;
	private readonly agentList = new Container();
	private readonly headerLine = new Container();
	private readonly summaryLine = new Container();
	private readonly footerHints = new Container();
	private readonly leaderKey: string;
	private readonly onSelectionChange: (selection: SubagentNavigatorSelection) => void;
	private readonly onOpenSelection: (selection: SubagentNavigatorSelection) => void;
	private readonly onClose: () => void;

	constructor(
		groups: SubagentViewGroup[],
		selection: SubagentNavigatorSelection,
		options: {
			leaderKey: string;
			onSelectionChange: (selection: SubagentNavigatorSelection) => void;
			onOpenSelection: (selection: SubagentNavigatorSelection) => void;
			onClose: () => void;
		},
	) {
		super();
		this.leaderKey = options.leaderKey;
		this.onSelectionChange = options.onSelectionChange;
		this.onOpenSelection = options.onOpenSelection;
		this.onClose = options.onClose;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Subagent Sessions • Flight Deck")), 1, 0));
		this.addChild(this.headerLine);
		this.addChild(this.summaryLine);
		this.addChild(new Spacer(1));
		this.addChild(this.agentList);
		this.addChild(new Spacer(1));
		this.addChild(this.footerHints);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.setGroups(groups, selection);
	}

	setGroups(groups: SubagentViewGroup[], selection?: SubagentNavigatorSelection): void {
		this.groups = groups;
		this.buildFlatList();
		if (selection) {
			this.flatIndex = this.selectionToFlatIndex(selection);
		}
		this.clampSelection();
		this.renderTable();
		this.emitSelection();
	}

	moveRoot(direction: 1 | -1): void {
		if (this.flatRefs.length === 0) return;
		this.flatIndex = (this.flatIndex + direction + this.flatRefs.length) % this.flatRefs.length;
		this.clampSelection();
		this.renderTable();
		this.emitSelection();
	}

	moveNested(direction: 1 | -1): void {
		if (this.groups.length === 0 || this.flatRefs.length === 0) return;
		const current = this.flatRefs[this.flatIndex];
		const currentGroupIdx = current?.groupIdx ?? 0;
		const targetGroupIdx = (currentGroupIdx + direction + this.groups.length) % this.groups.length;
		const targetRootIndex = this.flatRefs.findIndex(entry => entry.groupIdx === targetGroupIdx && entry.isRoot);
		const targetAnyIndex = this.flatRefs.findIndex(entry => entry.groupIdx === targetGroupIdx);
		this.flatIndex = targetRootIndex >= 0 ? targetRootIndex : Math.max(0, targetAnyIndex);
		this.clampSelection();
		this.renderTable();
		this.emitSelection();
	}

	getSelection(): SubagentNavigatorSelection {
		return this.flatIndexToSelection(this.flatIndex);
	}

	private getRootRef(group: SubagentViewGroup): SubagentViewRef | undefined {
		return group.refs.find(ref => ref.id === group.rootId) ?? group.refs[0];
	}

	private getNestedRefs(group: SubagentViewGroup): SubagentViewRef[] {
		const rootRef = this.getRootRef(group);
		const parentId = rootRef?.id ?? group.rootId;
		return group.refs.filter(ref => ref.id !== parentId);
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "up") || matchesKey(keyData, "left")) {
			this.moveRoot(-1);
			return;
		}
		if (matchesKey(keyData, "down") || matchesKey(keyData, "right")) {
			this.moveRoot(1);
			return;
		}
		if (matchesKey(keyData, "tab")) {
			this.moveNested(1);
			return;
		}
		if (matchesKey(keyData, "shift+tab")) {
			this.moveNested(-1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.onOpenSelection(this.getSelection());
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || matchesKey(keyData, "ctrl+x") || matchesKey(keyData, "q")) {
			this.onClose();
		}
	}

	private buildFlatList(): void {
		this.flatRefs = [];
		for (let groupIdx = 0; groupIdx < this.groups.length; groupIdx += 1) {
			const group = this.groups[groupIdx];
			if (!group) continue;
			const rootRef = this.getRootRef(group);
			if (rootRef) {
				this.flatRefs.push({ ref: rootRef, groupIdx, nestedIdx: -1, isRoot: true });
			}
			const nestedRefs = this.getNestedRefs(group);
			for (let nestedIdx = 0; nestedIdx < nestedRefs.length; nestedIdx += 1) {
				const ref = nestedRefs[nestedIdx];
				if (!ref) continue;
				this.flatRefs.push({ ref, groupIdx, nestedIdx, isRoot: false });
			}
		}
	}

	private flatIndexToSelection(idx: number): SubagentNavigatorSelection {
		if (this.flatRefs.length === 0) return { groupIndex: 0, nestedIndex: -1 };
		const safeIndex = Math.max(0, Math.min(idx, this.flatRefs.length - 1));
		const entry = this.flatRefs[safeIndex];
		if (!entry) return { groupIndex: 0, nestedIndex: -1 };
		return { groupIndex: entry.groupIdx, nestedIndex: entry.nestedIdx };
	}

	private selectionToFlatIndex(sel: SubagentNavigatorSelection): number {
		if (this.flatRefs.length === 0) return 0;
		const exact = this.flatRefs.findIndex(entry => entry.groupIdx === sel.groupIndex && entry.nestedIdx === sel.nestedIndex);
		if (exact >= 0) return exact;
		const groupRoot = this.flatRefs.findIndex(entry => entry.groupIdx === sel.groupIndex && entry.isRoot);
		if (groupRoot >= 0) return groupRoot;
		const anyInGroup = this.flatRefs.findIndex(entry => entry.groupIdx === sel.groupIndex);
		return anyInGroup >= 0 ? anyInGroup : 0;
	}

	private renderTable(): void {
		this.headerLine.clear();
		this.summaryLine.clear();
		this.agentList.clear();
		this.footerHints.clear();

		const { active, total } = this.countActive();
		const idle = Math.max(0, total - active);
		const ruler = "═".repeat(Math.max(32, this.getLineWidth(118) - 2));
		this.headerLine.addChild(new Text(theme.fg("muted", this.clipLine(` ${ruler}`, 120)), 1, 0));
		this.summaryLine.addChild(
			new Text(
				this.clipLine(
					`${theme.fg("text", " Active:")} ${theme.bold(theme.fg("accent", String(active)))}   ${theme.fg("text", "Idle:")} ${theme.fg("muted", String(idle))}   ${theme.fg("text", "Total:")} ${theme.bold(theme.fg("accent", String(total)))}`,
					120,
				),
				1,
				0,
			),
		);

		const tableWidth = Math.max(40, this.getLineWidth(120));
		const indexWidth = 4;
		const roleWidth = 10;
		const modelWidth = 8;
		const tokensWidth = 8;
		const ageWidth = 6;
		const descWidth = Math.max(12, tableWidth - (2 + indexWidth + 1 + roleWidth + 1 + modelWidth + 1 + tokensWidth + 1 + ageWidth + 1));
		const separator = this.clipLine(` ${"─".repeat(Math.max(24, tableWidth - 2))}`, 120);

		this.agentList.addChild(
			new Text(
				theme.bold(
					this.clipLine(
						`   ${"#".padEnd(indexWidth)} ${"Role".padEnd(roleWidth)} ${"Model".padEnd(modelWidth)} ${"Tokens".padEnd(tokensWidth)} ${"Age".padEnd(ageWidth)} Description`,
						120,
					),
				),
				1,
				0,
			),
		);
		this.agentList.addChild(new Text(theme.fg("muted", separator), 1, 0));

		if (this.flatRefs.length === 0) {
			const emptyText = "No subagents found";
			const leftPad = Math.max(0, Math.floor((tableWidth - visibleWidth(emptyText)) / 2));
			this.agentList.addChild(new Text(theme.fg("muted", `${" ".repeat(leftPad)}${emptyText}`), 1, 0));
			this.agentList.addChild(new Text(theme.fg("muted", separator), 1, 0));
			this.renderFooterHints();
			return;
		}

		const start = this.scrollOffset;
		const end = Math.min(this.flatRefs.length, start + this.MAX_VISIBLE);
		let previousGroupIdx: number | undefined;
		for (let idx = start; idx < end; idx += 1) {
			const entry = this.flatRefs[idx];
			if (!entry) continue;
			if (previousGroupIdx !== undefined && previousGroupIdx !== entry.groupIdx) {
				this.agentList.addChild(new Text(theme.fg("muted", separator), 1, 0));
			}
			previousGroupIdx = entry.groupIdx;

			const ordinal = String(idx + 1).padStart(2, "0");
			const indexLabel = (entry.isRoot ? `#${ordinal}` : `»${ordinal}`).padStart(indexWidth);
			const role = this.formatRole(entry.ref.agent);
			const model = this.formatModel(entry.ref.model);
			const tokens = this.formatTokens(entry.ref.tokens);
			const age = this.formatAge(entry.ref.lastUpdatedMs);
			const baseDescription = this.formatTaskTitle(entry.ref);
			const nestedPrefix = entry.isRoot ? "" : "  ";
			const description = truncateToWidth(`${nestedPrefix}${baseDescription}`, descWidth);
			const marker = idx === this.flatIndex ? "> " : "  ";
			const line = this.clipLine(`${marker}${indexLabel} ${role} ${model} ${tokens} ${age} ${description}`, 120);
			const styledLine = idx === this.flatIndex ? theme.bold(theme.fg("accent", line)) : theme.fg("text", line);
			this.agentList.addChild(new Text(styledLine, 1, 0));
		}

		this.agentList.addChild(new Text(theme.fg("muted", separator), 1, 0));
		this.renderFooterHints();
	}

	private formatRole(agent?: string): string {
		const roleMap: Record<string, string> = {
			task: "task",
			explore: "explore",
			research: "research",
			lint: "lint",
			verifier: "verifier",
			merge: "merge",
			designer: "designer",
			plan: "plan",
			"worktree-setup": "w-setup",
		};
		const name = agent ? (roleMap[agent] ?? agent.slice(0, 10)) : "?";
		return name.padEnd(10);
	}

	private formatModel(model?: string): string {
		if (!model) return "?".padEnd(8);
		const normalized = model.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "");
		return normalized.slice(0, 8).padEnd(8);
	}

	private formatTokens(tokens?: number): string {
		if (tokens === undefined || tokens === null) return "---".padStart(8);
		if (tokens < 1000) return String(tokens).padStart(8);
		if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`.padStart(8);
		return `${(tokens / 1_000_000).toFixed(1)}M`.padStart(8);
	}

	private formatAge(lastUpdatedMs?: number): string {
		if (!lastUpdatedMs || !Number.isFinite(lastUpdatedMs) || lastUpdatedMs <= 0) return "---".padEnd(6);
		const diff = Math.max(0, Date.now() - lastUpdatedMs);
		if (diff < 5000) return "now".padEnd(6);
		if (diff < 60_000) return `${Math.floor(diff / 1000)}s`.padEnd(6);
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`.padEnd(6);
		return `${Math.floor(diff / 3_600_000)}h`.padEnd(6);
	}

	private countActive(): { active: number; total: number } {
		const now = Date.now();
		const active = this.flatRefs.reduce((count, entry) => {
			const updated = entry.ref.lastUpdatedMs;
			if (typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0) return count;
			return now - updated <= 30_000 ? count + 1 : count;
		}, 0);
		return { active, total: this.flatRefs.length };
	}

	private clampSelection(): void {
		if (this.flatRefs.length === 0) {
			this.flatIndex = 0;
			this.scrollOffset = 0;
			return;
		}
		this.flatIndex = Math.max(0, Math.min(this.flatIndex, this.flatRefs.length - 1));
		const maxOffset = Math.max(0, this.flatRefs.length - this.MAX_VISIBLE);
		if (this.flatIndex < this.scrollOffset) {
			this.scrollOffset = this.flatIndex;
		} else if (this.flatIndex >= this.scrollOffset + this.MAX_VISIBLE) {
			this.scrollOffset = this.flatIndex - this.MAX_VISIBLE + 1;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
	}

	private emitSelection(): void {
		this.onSelectionChange(this.flatIndexToSelection(this.flatIndex));
	}

	private renderFooterHints(): void {
		const hints = `[enter] open  [↑/↓] navigate  [tab] next group  [${this.leaderKey.toLowerCase()}] close  [q] close`;
		this.footerHints.addChild(new Text(theme.fg("muted", this.clipLine(` ${hints}`, 120)), 1, 0));
	}

	private getLineWidth(maxWidth: number): number {
		const terminalWidth = typeof process.stdout.columns === "number" ? process.stdout.columns : maxWidth + 8;
		const overlayWidth = Math.max(24, terminalWidth - 8);
		return Math.max(24, Math.min(maxWidth, overlayWidth));
	}

	private formatTaskTitle(ref?: SubagentViewRef): string {
		if (!ref) return "(unknown)";
		if (ref.description && ref.description.trim().length > 0) return ref.description.trim();
		const tail = ref.id.split(".").pop() ?? ref.id;
		const dashIndex = tail.indexOf("-");
		const raw = dashIndex >= 0 && dashIndex < tail.length - 1 ? tail.slice(dashIndex + 1) : tail;
		const normalized = raw.replace(/[_-]+/g, " ").trim();
		return normalized.length > 0 ? normalized : ref.id;
	}

	private clipLine(text: string, width: number): string {
		return truncateToWidth(text, this.getLineWidth(width));
	}
}

const ACTION_BUTTONS: ActionButtonUi[] = [
	{
		label: "Worktree",
		command: "/planned-worktree",
		statusKey: PLAN_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;45m Worktree \x1b[0m",
		hoverText: "\x1b[30;105m Worktree \x1b[0m",
	},
	{
		label: "Git",
		command: "/git-menu",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;42m Git \x1b[0m",
		hoverText: "\x1b[30;102m Git \x1b[0m",
	},
	{
		label: "! Sync",
		command: "/git-menu",
		statusKey: SYNC_NEEDED_STATUS_KEY,
		normalText: "\x1b[30;103m ! Sync \x1b[0m",
		hoverText: "\x1b[30;43m ! Sync \x1b[0m",
	},
	{
		label: "Freeform",
		command: "/freeform-worktree",
		statusKey: PLAN_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;45m Freeform \x1b[0m",
		hoverText: "\x1b[30;105m Freeform \x1b[0m",
	},
	{
		label: "Planned",
		command: "/planned-worktree",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;46m Planned \x1b[0m",
		hoverText: "\x1b[30;106m Planned \x1b[0m",
	},
	{
		label: "Submit PR",
		command: "/submit-pr",
		statusKey: IMPLEMENT_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;42m Submit PR \x1b[0m",
		hoverText: "\x1b[30;102m Submit PR \x1b[0m",
	},
	{
		label: "Review",
		command: "/review-complete",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;44m Review \x1b[0m",
		hoverText: "\x1b[30;104m Review \x1b[0m",
	},
	{
		label: "Fix Issues",
		command: "/fix-issues",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;47m Fix Issues \x1b[0m",
		hoverText: "\x1b[30;107m Fix Issues \x1b[0m",
	},
	{
		label: "Update Version",
		command: "/update-version-workflow",
		statusKey: REVIEW_COMPLETE_STATUS_KEY,
		normalText: "\x1b[30;46m Update Version \x1b[0m",
		hoverText: "\x1b[30;106m Update Version \x1b[0m",
	},
	{
		label: "\u2715 Worktree",
		command: "/delete-worktree",
		statusKey: DELETE_WORKTREE_STATUS_KEY,
		normalText: "\x1b[30;41m \u2715 Worktree \x1b[0m",
		hoverText: "\x1b[30;101m \u2715 Worktree \x1b[0m",
	},
	{
		label: "Cleanup",
		command: "/cleanup-worktrees",
		statusKey: CLEANUP_WORKFLOW_STATUS_KEY,
		normalText: "\x1b[30;43m Cleanup \x1b[0m",
		hoverText: "\x1b[30;103m Cleanup \x1b[0m",
	},
	{
		label: "Plan Review",
		command: "/plan-review",
		statusKey: PLAN_REVIEW_STATUS_KEY,
		normalText: "\x1b[30;42m Plan Review \x1b[0m",
		hoverText: "\x1b[30;102m Plan Review \x1b[0m",
		editorText: "Review this plan for issues/ambiguities, make sure there are no edge cases being missed. Spawn multiple task subagents for each phase to review the phases in the plan. Do not edit the plan, give me an output with all the synthesized data in a beginner friendly, clear and concise list with numbered labelings for each issue identified and why it may be an issue, do not use technical jargain or undefined acronyms, I want each thing explained clearly and concisely, so that I can understand it and give you guideance. Use research agents in parallel for anything that need up-to-date information, to ensure it is accurate as of today. If there are no issues/ambiguities or edge cases identified, that is fine, do not make up things to try to please me, but also do not overlook potential problems from the plan that may be identified during implementation. Utilize your full suite of subagents, prioritize parallel work as this is a READ-ONLY task that is preferred to be quicker, so parallel subagents are required.\n\nPlan File:\n",
	},
	{
		label: "Fix Plan",
		command: "/fix-plan",
		statusKey: FIX_PLAN_STATUS_KEY,
		normalText: "\x1b[30;42m Fix Plan \x1b[0m",
		hoverText: "\x1b[30;102m Fix Plan \x1b[0m",
		editorText: "Another agent reviewed this plan and found issues listed below. Read the plan file, then apply each fix directly — do NOT spawn subagents or use isolated mode, just edit the plan file yourself one fix at a time. Do NOT implement the plan or change any other files. Keep changes strictly limited to resolving the identified problems: clarify ambiguous steps, add missing edge cases, tighten verification criteria, and correct factual errors. Do not expand scope or rewrite parts that are not broken. Use research tools if you need up-to-date information to verify a fix.\n\nPlan Review Output:\n",
	},
];

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function hasSameVisibleText(left: string, right: string): boolean {
	return stripAnsi(left).trim() === stripAnsi(right).trim();
}

function findActionButtonBounds(
	line: string,
	button: ActionButtonUi,
	mouseCol: number,
): { startCol: number; endCol: number; matchLength: number } | undefined {
	const renderedCandidates = new Set<string>();
	for (const renderedText of [button.hoverText, button.normalText]) {
		const rendered = stripAnsi(renderedText);
		if (!rendered.includes(button.label)) continue;
		renderedCandidates.add(rendered);
		const withoutTrailingSpace = rendered.trimEnd();
		if (withoutTrailingSpace !== rendered && withoutTrailingSpace.includes(button.label)) {
			renderedCandidates.add(withoutTrailingSpace);
		}
	}

	let bestMatch: { startCol: number; endCol: number; matchLength: number } | undefined;
	for (const rendered of renderedCandidates) {
		const labelOffset = rendered.indexOf(button.label);
		if (labelOffset === -1) continue;

		let searchFrom = 0;
		while (searchFrom < line.length) {
			const renderedIndex = line.indexOf(rendered, searchFrom);
			if (renderedIndex === -1) break;
			searchFrom = renderedIndex + 1;

			const labelIndex = renderedIndex + labelOffset;
			const startCol = visibleWidth(line.slice(0, labelIndex)) + 1;
			const endCol = startCol + visibleWidth(button.label) - 1;
			if (mouseCol < startCol || mouseCol > endCol) continue;

			const matchLength = visibleWidth(rendered);
			if (!bestMatch || matchLength > bestMatch.matchLength) {
				bestMatch = { startCol, endCol, matchLength };
			}
		}
	}

	return bestMatch;
}

function renderSubagentStatusBadge(): string {
	return theme.bg("statusLineBg", theme.bold(theme.fg("statusLineSubagents", " SUBAGENT VIEW ")));
}

function renderSubagentStatusField(label: string, value: string, color: ThemeColor): string {
	return `${theme.fg("dim", `${label}:`)}${theme.fg(color, value)}`;
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
	private subagentCycleSignature: string | undefined;
	private subagentCycleIndex = -1;
	private subagentNestedCycleIndex = -1;
	private subagentNestedArrowMode = false;
	private subagentViewerBlock: Container | undefined;
	private subagentViewActiveId: string | undefined;
	private subagentViewRefreshInterval: ReturnType<typeof setInterval> | undefined;
	private subagentNavigatorComponent: SubagentNavigatorComponent | undefined;
	private subagentNavigatorClose: (() => void) | undefined;
	private subagentNavigatorOverlay: ReturnType<TUI["showOverlay"]> | undefined;
	private subagentNavigatorGroups: SubagentViewGroup[] = [];
	private planModeHasEntered = false;
	public readonly lspServers:
		| Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>
		| undefined = undefined;
	public mcpManager?: import("../mcp").MCPManager;
	private readonly toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

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
		lspServers:
			| Array<{ name: string; status: "ready" | "error"; fileTypes: string[]; error?: string }>
			| undefined = undefined,
		mcpManager?: import("../mcp").MCPManager,
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

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.setFocus(this.editor);

		this.inputController.setupKeyHandlers();
		this.inputController.setupEditorSubmitHandler();

		// Load initial todos
		await this.loadTodoList();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;
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
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	updateEditorTopBorder(): void {
		const width = this.ui.terminal.columns;
		const topBorder = this.statusLine.getTopBorder(width);
		this.editor.setTopBorder(topBorder);
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
		return "local://PLAN.md";
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
		const hasExitTool = this.session.getToolByName("exit_plan_mode") !== undefined;
		const planTools = hasExitTool ? [...previousTools, "exit_plan_mode"] : previousTools;
		const uniquePlanTools = [...new Set(planTools)];

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

	private async approvePlan(planContent: string): Promise<void> {
		const previousTools = this.planModePreviousTools ?? this.session.getActiveToolNames();
		await this.exitPlanMode({ silent: true, paused: false });
		await this.handleClearCommand();
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.markPlanReferenceSent();
		const prompt = renderPromptTemplate(planModeApprovedPrompt, { planContent });
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
			await this.approvePlan(planContent);
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
		const line = stripAnsi(rawLine);

		let bestHit: { button: ActionButtonUi; matchLength: number } | undefined;
		for (const button of ACTION_BUTTONS) {
			const bounds = findActionButtonBounds(line, button, event.x);
			if (!bounds) continue;
			if (!bestHit || bounds.matchLength > bestHit.matchLength) {
				bestHit = { button, matchLength: bounds.matchLength };
			}
		}

		return bestHit?.button;
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
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(): void {
		this.stopSubagentViewRefresh();
		this.subagentNavigatorOverlay?.hide();
		this.subagentCycleSignature = undefined;
		this.subagentCycleIndex = -1;
		this.subagentNestedCycleIndex = -1;
		this.subagentNestedArrowMode = false;
		this.subagentViewerBlock = undefined;
		this.subagentViewActiveId = undefined;
		this.subagentNavigatorComponent = undefined;
		this.subagentNavigatorClose = undefined;
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

	handleDumpCommand(): Promise<void> {
		return this.commandController.handleDumpCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.commandController.handleShareCommand();
	}

	handleCopyCommand(): Promise<void> {
		return this.commandController.handleCopyCommand();
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

	handleResumeSession(sessionPath: string): Promise<void> {
		return this.selectorController.handleResumeSession(sessionPath);
	}

	showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		return this.selectorController.showOAuthSelector(mode);
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

	async cycleSubagentView(direction: 1 | -1 = 1): Promise<void> {
		if (this.subagentNavigatorComponent) {
			this.subagentNavigatorComponent.moveRoot(direction);
			return;
		}
		if (this.subagentViewerBlock && this.subagentViewActiveId) {
			await this.navigateSubagentView("root", direction);
			return;
		}
		this.openSubagentNavigator({ scope: "root", direction });
	}

	async cycleSubagentNestedView(direction: 1 | -1 = 1): Promise<void> {
		if (this.subagentNavigatorComponent) {
			this.subagentNavigatorComponent.moveNested(direction);
			return;
		}
		if (this.subagentViewerBlock && this.subagentViewActiveId) {
			await this.navigateSubagentView("nested", direction);
			return;
		}
		this.openSubagentNavigator({ scope: "nested", direction });
	}

	private openSubagentNavigator(options: { scope: "root" | "nested"; direction: 1 | -1 }): void {
		const refs = this.collectSubagentViewRefs();
		if (refs.length === 0) {
			this.showStatus("No subagent transcripts found in this session yet.");
			return;
		}
		const groups = this.buildSubagentViewGroups(refs);
		if (groups.length === 0) {
			this.showStatus("No subagent transcripts found in this session yet.");
			return;
		}

		this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
		this.subagentNavigatorGroups = groups;

		const currentSelection =
			this.subagentViewActiveId !== undefined ? this.findSubagentSelection(groups, this.subagentViewActiveId) : undefined;
		if (currentSelection) {
			this.subagentCycleIndex = currentSelection.groupIndex;
			this.subagentNestedCycleIndex = currentSelection.refIndex;
		} else {
			this.subagentCycleIndex = options.scope === "root" && options.direction < 0 ? groups.length - 1 : 0;
			this.subagentNestedCycleIndex = -1;
		}

		const selectedGroup = groups[this.subagentCycleIndex] ?? groups[0]!;
		this.subagentNestedCycleIndex = this.clampSubagentNestedSelection(selectedGroup, this.subagentNestedCycleIndex);
		const selected = this.getSubagentSelectionRef(selectedGroup, this.subagentNestedCycleIndex);
		if (!selected) {
			this.showStatus("No subagent transcripts found in this session yet.");
			return;
		}

		if (this.subagentNavigatorComponent) {
			this.subagentNavigatorComponent.setGroups(groups, {
				groupIndex: this.subagentCycleIndex,
				nestedIndex: this.subagentNestedCycleIndex,
			});
			if (options.scope === "root") {
				this.subagentNavigatorComponent.moveRoot(options.direction);
			} else {
				this.subagentNavigatorComponent.moveNested(options.direction);
			}
			return;
		}

		this.applySubagentNavigatorSelection(
			{ groupIndex: this.subagentCycleIndex, nestedIndex: this.subagentNestedCycleIndex },
			groups,
		);
		const leaderKey = this.keybindings.getDisplayString("cycleSubagentForward") || "Ctrl+X";
		const closeNavigator = () => {
			const overlay = this.subagentNavigatorOverlay;
			this.subagentNavigatorOverlay = undefined;
			overlay?.hide();
			this.subagentNavigatorComponent = undefined;
			this.subagentNavigatorClose = undefined;
			this.subagentNavigatorGroups = [];
			this.subagentViewActiveId = undefined;
			this.subagentCycleSignature = undefined;
			this.subagentCycleIndex = -1;
			this.subagentNestedCycleIndex = -1;
			this.subagentNestedArrowMode = false;
			if (!this.subagentViewerBlock) {
				this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
			}
			this.ui.requestRender();
		};
		const navigator = new SubagentNavigatorComponent(
			groups,
			{ groupIndex: this.subagentCycleIndex, nestedIndex: this.subagentNestedCycleIndex },
			{
				leaderKey,
				onSelectionChange: selection => this.applySubagentNavigatorSelection(selection, groups),
				onOpenSelection: selection => {
					void this.openSubagentTranscriptFromNavigator(selection);
				},
				onClose: closeNavigator,
			},
		);
		this.subagentNavigatorComponent = navigator;
		this.subagentNavigatorClose = closeNavigator;
		this.subagentNavigatorOverlay = this.ui.showOverlay(navigator, { width: "92%", maxHeight: "80%", anchor: "center", margin: 1 });
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
		const groups = this.subagentNavigatorGroups;
		if (groups.length === 0) {
			this.showWarning("No subagent transcripts found in this session yet.");
			return;
		}
		const groupIndex = Math.max(0, Math.min(selection.groupIndex, groups.length - 1));
		const selectedGroup = groups[groupIndex] ?? groups[0];
		if (!selectedGroup) {
			this.showWarning("No subagent transcripts found in this session yet.");
			return;
		}
		const nestedIndex = this.clampSubagentNestedSelection(selectedGroup, selection.nestedIndex);
		const openedFromRootSelection = nestedIndex < 0;
		const selected = this.getSubagentSelectionRef(selectedGroup, nestedIndex);
		if (!selected) {
			this.showWarning("No subagent transcripts found in this session yet.");
			return;
		}
		const transcript = await this.loadSubagentTranscript(selected);
		if (!transcript) {
			this.showWarning(`No transcript found for subagent '${selected.id}'.`);
			return;
		}

		this.closeSubagentNavigator();
		this.subagentCycleSignature = this.buildSubagentCycleSignature(groups);
		const confirmedSelection = this.findSubagentSelection(groups, selected.id);
		if (confirmedSelection) {
			this.subagentCycleIndex = confirmedSelection.groupIndex;
			this.subagentNestedCycleIndex = confirmedSelection.refIndex;
		}
		this.subagentNestedArrowMode = openedFromRootSelection;
		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
		this.startSubagentViewRefresh();
	}

	private closeSubagentNavigator(): void {
		if (!this.subagentNavigatorClose) {
			this.subagentNavigatorOverlay?.hide();
			this.subagentNavigatorOverlay = undefined;
			this.subagentNestedArrowMode = false;
			return;
		}
		const closeNavigator = this.subagentNavigatorClose;
		closeNavigator();
	}

	private async navigateSubagentView(scope: "root" | "nested", direction: 1 | -1): Promise<void> {
		const refs = this.collectSubagentViewRefs();
		if (refs.length === 0) {
			this.exitSubagentView();
			this.showStatus("No subagent transcripts found in this session yet.");
			return;
		}

		const groups = this.buildSubagentViewGroups(refs);
		if (groups.length === 0) {
			this.exitSubagentView();
			this.showStatus("No subagent transcripts found in this session yet.");
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
			this.showWarning("No subagent transcripts found in this session yet.");
			return;
		}
		const transcript = await this.loadSubagentTranscript(selected);
		if (!transcript) {
			this.showWarning(`No transcript found for subagent '${selected.id}'.`);
			return;
		}

		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
		this.startSubagentViewRefresh();
	}

	exitSubagentView(): void {
		if (this.subagentNavigatorClose || this.subagentNavigatorOverlay) {
			this.closeSubagentNavigator();
			return;
		}
		this.stopSubagentViewRefresh();
		this.subagentViewActiveId = undefined;
		this.subagentCycleSignature = undefined;
		this.subagentCycleIndex = -1;
		this.subagentNestedCycleIndex = -1;
		this.subagentNestedArrowMode = false;
		this.subagentViewerBlock = undefined;
		this.subagentNavigatorComponent = undefined;
		this.subagentNavigatorClose = undefined;
		this.subagentNavigatorOverlay = undefined;
		this.subagentNavigatorGroups = [];
		this.statusLine.setHookStatus(SUBAGENT_VIEWER_STATUS_KEY, undefined);
		this.rebuildChatFromMessages();
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}
		this.ui.requestRender();
	}

	isSubagentViewActive(): boolean {
		return Boolean(this.subagentNavigatorClose || this.subagentNavigatorOverlay || this.subagentViewActiveId);
	}

	isSubagentNestedArrowModeEnabled(): boolean {
		return this.subagentNestedArrowMode;
	}

	private startSubagentViewRefresh(): void {
		if (this.subagentViewRefreshInterval) return;
		this.subagentViewRefreshInterval = setInterval(() => {
			void this.refreshSubagentView();
		}, 900);
	}

	private stopSubagentViewRefresh(): void {
		if (!this.subagentViewRefreshInterval) return;
		clearInterval(this.subagentViewRefreshInterval);
		this.subagentViewRefreshInterval = undefined;
	}

	private async refreshSubagentView(): Promise<void> {
		if (!this.subagentViewActiveId) return;
		const refs = this.collectSubagentViewRefs();
		if (refs.length === 0) {
			this.exitSubagentView();
			return;
		}
		const groups = this.buildSubagentViewGroups(refs);
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
		const transcript = await this.loadSubagentTranscript(selected);
		if (!transcript) return;
		this.subagentViewActiveId = selected.id;
		await this.renderSubagentSession(selected, transcript, groups);
	}

	private buildSubagentViewGroups(refs: SubagentViewRef[]): SubagentViewGroup[] {
		const groups = new Map<string, SubagentViewGroup>();

		for (const ref of refs) {
			const hierarchy = this.getSubagentHierarchy(ref.id);
			const rootId = ref.rootId ?? hierarchy.rootId;
			const recency = this.getSubagentRecencyScore(ref);
			const existing = groups.get(rootId);
			if (existing) {
				existing.refs.push(ref);
				if (recency > existing.lastUpdatedMs) {
					existing.lastUpdatedMs = recency;
				}
				continue;
			}
			groups.set(rootId, { rootId, refs: [ref], lastUpdatedMs: recency });
		}

		const sortedGroups = Array.from(groups.values()).sort((a, b) => {
			if (b.lastUpdatedMs !== a.lastUpdatedMs) return b.lastUpdatedMs - a.lastUpdatedMs;
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

	private getSubagentHierarchy(id: string): { rootId: string; parentId?: string; depth: number } {
		const segments = id.split(".").filter(Boolean);
		const rootId = segments[0] ?? id;
		const parentId = segments.length > 1 ? segments.slice(0, -1).join(".") : undefined;
		return { rootId, parentId, depth: Math.max(0, segments.length - 1) };
	}

	private getSubagentRecencyScore(ref: SubagentViewRef): number {
		return ref.lastUpdatedMs ?? ref.lastSeenOrder ?? 0;
	}

	private collectSubagentViewRefs(): SubagentViewRef[] {
		const refs = new Map<string, SubagentViewRef>();
		const sessionFile = this.sessionManager.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : undefined;
		let seenOrder = 0;

		const readLastUpdatedMs = (candidatePath?: string): number | undefined => {
			if (!candidatePath) return undefined;
			try {
				return fs.statSync(candidatePath).mtimeMs;
			} catch {
				return undefined;
			}
		};

		const upsert = (input: {
			id: string;
			sessionPath?: string;
			outputPath?: string;
			agent?: string;
			description?: string;
			model?: string;
			tokens?: number;
			contextPreview?: string;
			lastUpdatedMs?: number;
			lastSeenOrder?: number;
		}) => {
			const {
				id,
				sessionPath,
				outputPath,
				agent,
				description,
				model,
				tokens,
				contextPreview,
				lastUpdatedMs,
				lastSeenOrder,
			} = input;
			const normalizedId = id.trim();
			if (!normalizedId) return;

			const hierarchy = this.getSubagentHierarchy(normalizedId);
			const existing = refs.get(normalizedId) ?? {
				id: normalizedId,
				rootId: hierarchy.rootId,
				parentId: hierarchy.parentId,
				depth: hierarchy.depth,
			};

			existing.rootId = existing.rootId ?? hierarchy.rootId;
			existing.parentId = existing.parentId ?? hierarchy.parentId;
			existing.depth = existing.depth ?? hierarchy.depth;

			if (sessionPath && !existing.sessionPath) {
				existing.sessionPath = sessionPath;
			}

			if (outputPath && !existing.outputPath) {
				existing.outputPath = outputPath;
			}

			if (!existing.outputPath && existing.sessionPath?.endsWith(".jsonl")) {
				existing.outputPath = `${existing.sessionPath.slice(0, -6)}.md`;
			}

			if (!existing.outputPath && artifactsDir) {
				existing.outputPath = path.join(artifactsDir, `${normalizedId}.md`);
			}

			if (!existing.sessionPath) {
				if (existing.outputPath?.endsWith(".md")) {
					existing.sessionPath = `${existing.outputPath.slice(0, -3)}.jsonl`;
				} else if (artifactsDir) {
					existing.sessionPath = path.join(artifactsDir, `${normalizedId}.jsonl`);
				}
			}

			if (agent && !existing.agent) existing.agent = agent;
			if (description && !existing.description) existing.description = description;
			if (model && !existing.model) existing.model = model;
			if (typeof tokens === "number" && Number.isFinite(tokens)) existing.tokens = tokens;
			if (contextPreview && !existing.contextPreview) existing.contextPreview = contextPreview;
			if (typeof lastUpdatedMs === "number" && Number.isFinite(lastUpdatedMs)) {
				existing.lastUpdatedMs = Math.max(existing.lastUpdatedMs ?? 0, lastUpdatedMs);
			}
			if (typeof lastSeenOrder === "number" && Number.isFinite(lastSeenOrder)) {
				existing.lastSeenOrder = Math.max(existing.lastSeenOrder ?? 0, lastSeenOrder);
			}

			refs.set(normalizedId, existing);
		};

		if (artifactsDir) {
			try {
				for (const rel of new Bun.Glob("**/*.jsonl").scanSync(artifactsDir)) {
					const id = path.basename(rel, ".jsonl");
					if (!id) continue;
					const sessionPath = path.join(artifactsDir, rel);
					seenOrder += 1;
					upsert({ id, sessionPath, lastUpdatedMs: readLastUpdatedMs(sessionPath), lastSeenOrder: seenOrder });
				}
			} catch (error) {
				if (!isEnoent(error)) {
					logger.warn("Failed to scan subagent transcript artifacts", {
						artifactsDir,
						error: String(error),
					});
				}
			}
		}

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = (entry as { message?: Record<string, unknown> }).message;
			if (!message) continue;

			const role = message.role;
			if (role !== "toolResult" || message.toolName !== "task") continue;

			const details = message.details as Record<string, unknown> | undefined;
			const results = Array.isArray(details?.results) ? details.results : [];
			for (const result of results) {
				if (!result || typeof result !== "object") continue;
				const record = result as Record<string, unknown>;
				const id = typeof record.id === "string" ? record.id : "";
				const outputPath = typeof record.outputPath === "string" ? record.outputPath : undefined;
				const agent = typeof record.agent === "string" ? record.agent : undefined;
				const description = typeof record.description === "string" ? record.description : undefined;
				const model = this.formatSubagentModel(record.modelOverride);
				const usageTokens = this.extractUncachedUsageTokens(record.usage);
				const tokens = usageTokens ?? (typeof record.tokens === "number" ? record.tokens : undefined);
				const task = typeof record.task === "string" ? record.task : "";
				const contextPreview = this.extractTaskContextPreview(task);
				const sessionPath = outputPath?.endsWith(".md") ? `${outputPath.slice(0, -3)}.jsonl` : undefined;
				seenOrder += 1;
				upsert({
					id,
					outputPath,
					sessionPath,
					agent,
					description,
					model,
					tokens,
					contextPreview,
					lastUpdatedMs: readLastUpdatedMs(sessionPath) ?? readLastUpdatedMs(outputPath),
					lastSeenOrder: seenOrder,
				});
			}

			const textContent = this.extractTextContent(message.content);
			for (const match of textContent.matchAll(/agent:\/\/([A-Za-z0-9._-]+)/g)) {
				const id = match[1];
				if (!id) continue;
				seenOrder += 1;
				upsert({ id, lastSeenOrder: seenOrder });
			}
		}

		return Array.from(refs.values()).sort((a, b) => {
			const recencyDelta = this.getSubagentRecencyScore(b) - this.getSubagentRecencyScore(a);
			if (recencyDelta !== 0) return recencyDelta;
			return a.id.localeCompare(b.id);
		});
	}

	private extractTextContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const lines: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const item = block as { type?: unknown; text?: unknown };
			if (item.type !== "text" || typeof item.text !== "string") continue;
			lines.push(item.text);
		}
		return lines.join("\n");
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
		const hierarchyLines = currentRefs.map(ref => {
			const depth = Math.max(0, ref.depth ?? 0);
			const indent = "  ".repeat(Math.min(depth, 6));
			const isRoot = depth === 0;
			const isSelected = ref.id === selected.id;
			const selector = isSelected ? theme.bold(theme.fg("accent", "▸")) : " ";
			const branch = isRoot ? "" : "↳ ";
			const ordinal = this.extractSubagentOrdinal(ref.id);
			const agentName = this.clipPreview(ref.agent ?? (isRoot ? "task" : "subagent"), 24);
			const title = this.clipPreview(ref.description ?? this.extractSubagentTitleFromId(ref.id), 84);
			const line = `${indent}${branch}(${ordinal}) ${agentName} | ${title}`;
			const lineText = isSelected ? theme.fg("text", line) : theme.fg("dim", line);
			return ` ${selector} ${lineText}`;
		});
		const maxHierarchyLines = 12;
		const visibleHierarchyLines = hierarchyLines.slice(0, maxHierarchyLines);
		const hiddenHierarchyCount = Math.max(0, hierarchyLines.length - visibleHierarchyLines.length);
		const agentLabel = selected.agent ?? "task";
		const requestedModelLabel = selected.model;
		const actualModelLabel = transcript.model;
		const modelLabel = actualModelLabel ?? requestedModelLabel ?? "default";
		const modelSuffix =
			requestedModelLabel && actualModelLabel && requestedModelLabel !== actualModelLabel
				? ` (requested: ${requestedModelLabel})`
				: "";
		const contextLabel = this.clipPreview(
			selected.contextPreview ?? transcript.contextPreview ?? selected.description ?? "(no context)",
			120,
		);
		const skillsUsed = transcript.skillsUsed ?? [];
		const skillsLabel = skillsUsed.length > 0 ? this.clipPreview(skillsUsed.join(", "), 120) : "none";
		const tokensValue = selected.tokens ?? transcript.tokens;
		const tokensLabel = typeof tokensValue === "number" ? `${tokensValue.toLocaleString()} tokens` : "tokens: n/a";
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
				? "nested 0/0 descendants (root implied)"
				: isParentSelection
					? `nested 0/${nestedCount} descendants (root implied)`
					: `nested ${nestedPosition}/${nestedCount} descendants`;
		const statusAgentLabel =
			nestedCount === 0
				? "nested 0/0 root-implied"
				: isParentSelection
					? `nested 0/${nestedCount} root-implied`
					: `${nestedPosition}/${nestedCount} ${agentLabel}`;
		const arrowNavigationHint = this.subagentNestedArrowMode
			? "Up/Down (or Left/Right) nested descendants"
			: "Up/Down (or Left/Right) task";

		this.chatContainer.clear();
		this.pendingTools.clear();

		const block = new Container();
		block.addChild(new Spacer(1));
		block.addChild(new DynamicBorder());
		block.addChild(
			new Text(
				theme.bold(theme.fg("warning", `[SUBAGENT] task ${taskPosition}/${taskCount}, ${nestedStatusLabel}: ${selected.id}`)),
				1,
				0,
			),
		);
		block.addChild(new Text(theme.fg("dim", `Agent: ${agentLabel}`), 1, 0));
		block.addChild(new Text(theme.fg("dim", `Model: ${modelLabel}${modelSuffix}`), 1, 0));
		block.addChild(new Text(theme.fg("dim", `Context: ${contextLabel}`), 1, 0));
		block.addChild(new Text(theme.fg("dim", `Skills: ${skillsLabel}`), 1, 0));
		block.addChild(new Text(theme.fg("dim", tokensLabel), 1, 0));
		block.addChild(new Text(theme.fg("dim", `Source: ${transcript.source}`), 1, 0));
		block.addChild(new Text(theme.fg("dim", "Hierarchy (most recent task first):"), 1, 0));
		for (const line of visibleHierarchyLines) {
			block.addChild(new Text(line, 1, 0));
		}
		if (hiddenHierarchyCount > 0) {
			block.addChild(new Text(theme.fg("dim", `  … +${hiddenHierarchyCount} more nested subagents`), 1, 0));
		}
		block.addChild(
			new Text(
				theme.fg(
					"dim",
					`Navigation: ${leaderKey} toggle, ${arrowNavigationHint}, Tab/Shift+Tab nested descendants, Esc exit`,
				),
				1,
				0,
			),
		);
		block.addChild(new DynamicBorder());
		this.chatContainer.addChild(block);
		this.subagentViewerBlock = block;

		if (transcript.sessionContext) {
			this.renderSessionContext(transcript.sessionContext, { updateFooter: false, populateHistory: false });
		} else {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(transcript.content, 1, 0));
		}

		this.statusLine.setHookStatus(
			SUBAGENT_VIEWER_STATUS_KEY,
			[
				renderSubagentStatusBadge(),
				`${theme.bold(theme.fg("statusLineSubagents", `task ${taskPosition}/${taskCount}`))} ${theme.bold(theme.fg("accent", selected.id))}`
				,
				renderSubagentStatusField("agent", statusAgentLabel, "statusLineSubagents"),
				renderSubagentStatusField("model", modelStatusLabel, "statusLineModel"),
				renderSubagentStatusField("skills", statusSkillsLabel, "statusLinePath"),
				renderSubagentStatusField("tokens", statusTokensLabel, "statusLineSpend"),
				renderSubagentStatusField("ctx", statusContextLabel, "statusLineContext"),
			].join(statusSeparator),
		);
		this.ui.requestRender();
	}

	private extractPreloadedSkillNames(systemPrompt: unknown): string[] {
		if (typeof systemPrompt !== "string") return [];
		const names = new Set<string>();
		for (const sectionMatch of systemPrompt.matchAll(/<preloaded_skills>([\s\S]*?)<\/preloaded_skills>/gi)) {
			const section = sectionMatch[1] ?? "";
			for (const skillMatch of section.matchAll(/<skill\s+name="([^"]+)"/g)) {
				const name = skillMatch[1]?.trim();
				if (name) names.add(name);
			}
		}
		return Array.from(names);
	}

	private extractSkillPromptName(message: unknown): string | undefined {
		if (!message || typeof message !== "object") return undefined;
		const record = message as Record<string, unknown>;
		if (record.role !== "custom" || record.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			return undefined;
		}
		const details = record.details;
		if (!details || typeof details !== "object") return undefined;
		const name = (details as Record<string, unknown>).name;
		return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
	}

	private extractUsedSkillNamesFromEntries(entries: Array<Record<string, unknown>>): string[] | undefined {
		const names = new Set<string>();
		for (const entry of entries) {
			if (entry.type === "session_init") {
				for (const skill of this.extractPreloadedSkillNames(entry.systemPrompt)) {
					names.add(skill);
				}
				continue;
			}
			if (entry.type !== "message") continue;
			const skillPromptName = this.extractSkillPromptName(entry.message);
			if (skillPromptName) {
				names.add(skillPromptName);
			}
		}
		return names.size > 0 ? Array.from(names) : undefined;
	}

	private extractSubagentOrdinal(id: string): string {
		const tail = id.split(".").pop() ?? id;
		const dashIndex = tail.indexOf("-");
		if (dashIndex > 0) {
			return tail.slice(0, dashIndex);
		}
		return tail;
	}

	private extractSubagentTitleFromId(id: string): string {
		const tail = id.split(".").pop() ?? id;
		const dashIndex = tail.indexOf("-");
		if (dashIndex >= 0 && dashIndex < tail.length - 1) {
			return tail.slice(dashIndex + 1).replace(/[_-]+/g, " ").trim();
		}
		return tail.replace(/[_-]+/g, " ").trim();
	}

	private formatSubagentModel(modelOverride: unknown): string | undefined {
		if (typeof modelOverride === "string") {
			return modelOverride;
		}
		if (Array.isArray(modelOverride)) {
			const values = modelOverride.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
			if (values.length > 0) {
				return values.join(", ");
			}
		}
		return undefined;
	}

	private extractTaskContextPreview(task: string): string | undefined {
		const stripped = task.replace(/<swarm_context>[\s\S]*?<\/swarm_context>/g, " ");
		const lines = stripped
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		return lines[0] ? this.clipPreview(lines[0], 160) : undefined;
	}

	private clipPreview(text: string, maxChars: number): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length <= maxChars) return normalized;
		return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
	}

	private extractUncachedUsageTokens(usage: unknown): number | undefined {
		if (!usage || typeof usage !== "object") return undefined;
		const record = usage as Record<string, unknown>;
		const input = typeof record.input === "number" && Number.isFinite(record.input) ? record.input : undefined;
		const output = typeof record.output === "number" && Number.isFinite(record.output) ? record.output : undefined;
		if (input !== undefined || output !== undefined) {
			return (input ?? 0) + (output ?? 0);
		}
		const totalTokens =
			typeof record.totalTokens === "number" && Number.isFinite(record.totalTokens)
				? record.totalTokens
				: typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)
					? record.total_tokens
					: undefined;
		return totalTokens;
	}

	private buildFallbackSubagentSessionContext(rawTranscript: string): {
		sessionContext?: SessionContext;
		model?: string;
		tokens?: number;
		contextPreview?: string;
		skillsUsed?: string[];
	} {
		const entries = parseJsonlLenient<Record<string, unknown>>(rawTranscript);
		if (entries.length === 0) {
			return {};
		}

		const messages: AgentMessage[] = [];
		let model: string | undefined;
		let thinkingLevel = "high";
		let mode = "none";
		let modeData: Record<string, unknown> | undefined;
		let contextPreview: string | undefined;
		let tokens = 0;
		const skillsUsed = new Set<string>();

		for (const entry of entries) {
			if (entry.type === "model_change" && typeof entry.model === "string") {
				model = entry.model;
				continue;
			}

			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
				thinkingLevel = entry.thinkingLevel;
				continue;
			}

			if (entry.type === "mode_change" && typeof entry.mode === "string") {
				mode = entry.mode;
				modeData =
					entry.data && typeof entry.data === "object"
						? (entry.data as Record<string, unknown>)
						: undefined;
				continue;
			}

			if (entry.type === "session_init" && typeof entry.task === "string" && !contextPreview) {
				contextPreview = this.extractTaskContextPreview(entry.task);
				for (const skill of this.extractPreloadedSkillNames(entry.systemPrompt)) {
					skillsUsed.add(skill);
				}
				continue;
			}

			if (entry.type !== "message") {
				continue;
			}

			const message = entry.message;
			if (!message || typeof message !== "object") {
				continue;
			}

			const role = (message as { role?: unknown }).role;
			if (typeof role !== "string") {
				continue;
			}

			const skillPromptName = this.extractSkillPromptName(message);
			if (skillPromptName) {
				skillsUsed.add(skillPromptName);
			}

			messages.push(message as AgentMessage);
			if (role === "assistant") {
				const usage = (message as { usage?: unknown }).usage;
				const uncached = this.extractUncachedUsageTokens(usage);
				if (typeof uncached === "number") {
					tokens += uncached;
				}
			}
		}

		if (messages.length === 0) {
			return {
				model,
				tokens: tokens > 0 ? tokens : undefined,
				contextPreview,
				skillsUsed: skillsUsed.size > 0 ? Array.from(skillsUsed) : undefined,
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
			model,
			tokens: tokens > 0 ? tokens : undefined,
			contextPreview,
			skillsUsed: skillsUsed.size > 0 ? Array.from(skillsUsed) : undefined,
		};
	}

	private async loadSubagentTranscript(ref: SubagentViewRef): Promise<LoadedSubagentTranscript | undefined> {
		if (ref.sessionPath && (await Bun.file(ref.sessionPath).exists())) {
			const rawTranscript = await Bun.file(ref.sessionPath).text();
			try {
				const subSession = await SessionManager.open(ref.sessionPath);
				const entries = subSession.getEntries() as Array<Record<string, unknown>>;
				const latestModelEntry = [...entries].reverse().find(entry => entry.type === "model_change");
				const sessionInitEntry = entries.find(entry => entry.type === "session_init");
				const skillsUsed = this.extractUsedSkillNamesFromEntries(entries);
				const usage = subSession.getUsageStatistics();
				const tokens = usage.input + usage.output;
				const sessionContext = subSession.buildSessionContext();
				if (sessionContext.messages.length === 0) {
					const fallback = this.buildFallbackSubagentSessionContext(rawTranscript);
					return {
						source: ref.sessionPath,
						content: rawTranscript,
						sessionContext: fallback.sessionContext,
						model:
							typeof latestModelEntry?.model === "string"
								? latestModelEntry.model
								: fallback.model,
						tokens: fallback.tokens ?? tokens,
						contextPreview:
							typeof sessionInitEntry?.task === "string"
								? this.extractTaskContextPreview(sessionInitEntry.task)
								: fallback.contextPreview,
						skillsUsed: skillsUsed ?? fallback.skillsUsed,
					};
				}

				return {
					source: ref.sessionPath,
					content: rawTranscript,
					sessionContext,
					model:
						typeof latestModelEntry?.model === "string"
							? latestModelEntry.model
							: undefined,
					tokens,
					contextPreview:
						typeof sessionInitEntry?.task === "string"
							? this.extractTaskContextPreview(sessionInitEntry.task)
							: undefined,
						skillsUsed,
				};
			} catch {
				const fallback = this.buildFallbackSubagentSessionContext(rawTranscript);
				return {
					source: ref.sessionPath,
					content: rawTranscript,
					sessionContext: fallback.sessionContext,
					model: fallback.model,
					tokens: fallback.tokens,
					contextPreview: fallback.contextPreview,
						skillsUsed: fallback.skillsUsed,
				};
			}
			}

		if (ref.outputPath && (await Bun.file(ref.outputPath).exists())) {
			return {
				source: ref.outputPath,
				content: await Bun.file(ref.outputPath).text(),
			};
		}

		return undefined;
	}

	private async loadTokensFromSessionPath(sessionPath: string): Promise<number | undefined> {
		try {
			if (!(await Bun.file(sessionPath).exists())) return undefined;
			const rawTranscript = await Bun.file(sessionPath).text();
			const entries = parseJsonlLenient<Record<string, unknown>>(rawTranscript);
			let tokens = 0;
			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (!message || typeof message !== "object") continue;
				const role = (message as { role?: unknown }).role;
				if (role !== "assistant") continue;
				const usage = (message as { usage?: unknown }).usage;
				const uncached = this.extractUncachedUsageTokens(usage);
				if (typeof uncached === "number") tokens += uncached;
			}
			return tokens > 0 ? tokens : undefined;
		} catch {
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

import {
	Container,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "./components/dynamic-border";
import { theme } from "./theme/theme";

export interface SubagentViewRef {
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

export interface SubagentViewGroup {
	rootId: string;
	refs: SubagentViewRef[];
	lastUpdatedMs: number;
}

export interface SubagentNavigatorSelection {
	groupIndex: number;
	nestedIndex: number;
}

export class SubagentNavigatorComponent extends Container {
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
		if (
			matchesKey(keyData, "escape") ||
			matchesKey(keyData, "esc") ||
			matchesKey(keyData, "ctrl+x") ||
			matchesKey(keyData, "q")
		) {
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
		const exact = this.flatRefs.findIndex(
			entry => entry.groupIdx === sel.groupIndex && entry.nestedIdx === sel.nestedIndex,
		);
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
		const descWidth = Math.max(
			12,
			tableWidth - (2 + indexWidth + 1 + roleWidth + 1 + modelWidth + 1 + tokensWidth + 1 + ageWidth + 1),
		);
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
			quick_task: "quick",
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

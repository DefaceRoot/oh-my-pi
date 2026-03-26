import { Container, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { parseModelString } from "../../config/model-resolver";
import { getSubagentOutcomeLabel, type SubagentOutcome } from "../../task/subagent-outcome";
import { formatDuration } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import type { SubagentNavigatorSelection, SubagentStatus, SubagentViewGroup, SubagentViewRef } from "./types";

const MIN_INDEX_WIDTH = 3;
const MIN_TITLE_WIDTH = 12;
const MIN_STATUS_WIDTH = 10;
const MIN_RESULT_WIDTH = 7;
const MIN_ROLE_WIDTH = 8;
const MIN_MODEL_WIDTH = 12;
const MIN_LAST_ACTIVE_WIDTH = 9;
const TOKENS_WIDTH = 8;
const MIN_CHANGES_WIDTH = 10;
const COLUMN_SEPARATOR = " │ ";

const MIN_TRUSTED_EPOCH_MS = 946_684_800_000;

type FocusPane = "list";

interface FlatEntry {
	ref: SubagentViewRef;
	groupIdx: number;
	nestedIdx: number;
	isRoot: boolean;
	depth: number;
}

interface NavigatorColumns {
	indexW: number;
	titleW: number;
	statusW: number;
	resultW: number;
	changesW: number;
	roleW: number;
	modelW: number;
	lastActiveW: number;
	tokensW: number;
	showResult: boolean;
	showChanges: boolean;
	showModel: boolean;
	showLastActive: boolean;
	showTokens: boolean;
}

type StatusColor = "success" | "accent" | "error" | "warning" | "muted";

interface StatusDisplay {
	glyph: string;
	label: string;
	summaryLabel: string;
	color: StatusColor;
}

const STATUS_ORDER: SubagentStatus[] = ["running", "completed", "failed", "pending", "user_stopped", "cancelled"];

export class SubagentNavigatorModal extends Container {
	#groups: SubagentViewGroup[] = [];
	#flatRefs: FlatEntry[] = [];
	#flatIndex = 0;
	#scrollOffset = 0;

	#filterMode = false;
	#filterText = "";
	#unfilteredFlatRefs: FlatEntry[] = [];

	readonly #onSelectionChange: (selection: SubagentNavigatorSelection) => void;
	readonly #onOpenSelection: (selection: SubagentNavigatorSelection) => void;
	readonly #onStopSelection?: (selection: SubagentNavigatorSelection) => void;
	readonly #onClose: () => void;

	constructor(
		groups: SubagentViewGroup[],
		selection: SubagentNavigatorSelection | undefined,
		options: {
			onSelectionChange: (selection: SubagentNavigatorSelection) => void;
			onOpenSelection: (selection: SubagentNavigatorSelection) => void;
			onStopSelection?: (selection: SubagentNavigatorSelection) => void;
			onClose: () => void;
		},
	) {
		super();
		this.#onSelectionChange = options.onSelectionChange;
		this.#onOpenSelection = options.onOpenSelection;
		this.#onStopSelection = options.onStopSelection;
		this.#onClose = options.onClose;
		this.setGroups(groups, selection);
	}

	get #maxVisibleRows(): number {
		const termHeight = process.stdout.rows ?? 24;
		return Math.max(5, Math.min(30, Math.floor(termHeight * 0.65)));
	}

	setGroups(groups: SubagentViewGroup[], selection?: SubagentNavigatorSelection): void {
		const previousSelectedId = this.#flatRefs[this.#flatIndex]?.ref.id;
		this.#groups = groups;
		this.#buildFlatList();
		this.#unfilteredFlatRefs = [...this.#flatRefs];
		if (this.#filterMode && this.#filterText) {
			this.#applyFilter();
		}
		if (selection) {
			this.#flatIndex = this.#selectionToFlatIndex(selection);
		} else if (previousSelectedId) {
			const previousIndex = this.#flatRefs.findIndex(entry => entry.ref.id === previousSelectedId);
			this.#flatIndex = previousIndex >= 0 ? previousIndex : this.#findMostRecentFlatIndex();
		} else {
			this.#flatIndex = this.#findMostRecentFlatIndex();
		}
		this.#clampSelection();
		this.#emitSelection();
	}

	getSelection(): SubagentNavigatorSelection {
		return this.#flatIndexToSelection(this.#flatIndex);
	}

	getFocus(): FocusPane {
		return "list";
	}

	isFilterMode(): boolean {
		return this.#filterMode;
	}

	getFilterText(): string {
		return this.#filterText;
	}

	handleInput(keyData: string): void {
		if (this.#filterMode) {
			this.#handleFilterInput(keyData);
			return;
		}
		this.#handleListInput(keyData);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(3, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const selectionRows = this.#renderSelectionSummary(innerWidth);
		const bodyLines = this.#renderBody(innerWidth);
		const lines = [
			this.#renderTopBorder(innerWidth),
			...selectionRows.map(line => this.#frameSummaryRow(line, innerWidth)),
			...bodyLines.map(line => this.#frameRow(line, innerWidth)),
			this.#frameRow(theme.fg("dim", this.#buildFooterHint()), innerWidth),
			this.#renderBottomBorder(innerWidth),
		];
		return lines.map(line => theme.overlaySurface(line));
	}

	#handleListInput(keyData: string): void {
		if (matchesKey(keyData, "up") || keyData === "k") {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down") || keyData === "j") {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#onOpenSelection(this.getSelection());
			return;
		}
		if (keyData === "g") {
			this.#jumpToIndex(0);
			return;
		}
		if (keyData === "G") {
			this.#jumpToIndex(this.#flatRefs.length - 1);
			return;
		}
		if (keyData === "p") {
			this.#jumpToParent();
			return;
		}
		if (keyData === "s" || keyData === "S") {
			const selected = this.#currentSelectionEntry();
			if (selected && this.#isSelectionStoppable(selected.ref)) {
				this.#onStopSelection?.(this.getSelection());
			}
			return;
		}
		if (keyData === "/") {
			this.#enterFilterMode();
			return;
		}
		if (matchesKey(keyData, "tab")) {
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc") || keyData === "q") {
			this.#onClose();
			return;
		}
		if (matchesKey(keyData, "ctrl+x")) {
			this.#onClose();
		}
	}

	#handleFilterInput(keyData: string): void {
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#filterMode = false;
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#cancelFilter();
			return;
		}
		if (matchesKey(keyData, "backspace")) {
			this.#filterText = this.#filterText.slice(0, -1);
			this.#applyFilter();
			this.#clampSelection();
			this.#emitSelection();
			return;
		}
		if (keyData.length === 1 && keyData.charCodeAt(0) >= 32) {
			this.#filterText += keyData;
			this.#applyFilter();
			this.#clampSelection();
			this.#emitSelection();
		}
	}

	#enterFilterMode(): void {
		this.#filterMode = true;
		this.#filterText = "";
		this.#unfilteredFlatRefs = [...this.#flatRefs];
	}

	#cancelFilter(): void {
		this.#filterMode = false;
		this.#filterText = "";
		this.#flatRefs = [...this.#unfilteredFlatRefs];
		this.#clampSelection();
		this.#emitSelection();
	}

	#applyFilter(): void {
		if (!this.#filterText) {
			this.#flatRefs = [...this.#unfilteredFlatRefs];
			return;
		}
		const needle = this.#filterText.toLowerCase();
		this.#flatRefs = this.#unfilteredFlatRefs.filter(entry => {
			const title = this.#resolveTitle(entry.ref).toLowerCase();
			const name = (entry.ref.agent ?? entry.ref.id).toLowerCase();
			const status = (entry.ref.status ?? "").toLowerCase();
			const desc = (entry.ref.description ?? "").toLowerCase();
			return title.includes(needle) || name.includes(needle) || status.includes(needle) || desc.includes(needle);
		});
	}

	#moveSelection(delta: number): void {
		if (this.#flatRefs.length === 0) return;
		this.#flatIndex = (this.#flatIndex + delta + this.#flatRefs.length) % this.#flatRefs.length;
		this.#clampSelection();
		this.#emitSelection();
	}

	#jumpToIndex(index: number): void {
		if (this.#flatRefs.length === 0) return;
		this.#flatIndex = Math.max(0, Math.min(index, this.#flatRefs.length - 1));
		this.#clampSelection();
		this.#emitSelection();
	}

	#jumpToParent(): void {
		const current = this.#currentSelectionEntry();
		if (!current || current.isRoot) return;
		const parentRefId = this.#resolveParentRefId(current);
		if (!parentRefId) return;
		const parentIndex = this.#flatRefs.findIndex(
			entry => entry.groupIdx === current.groupIdx && entry.ref.id === parentRefId,
		);
		if (parentIndex < 0) return;
		this.#flatIndex = parentIndex;
		this.#clampSelection();
		this.#emitSelection();
	}

	#clampSelection(): void {
		if (this.#flatRefs.length === 0) {
			this.#flatIndex = 0;
			this.#scrollOffset = 0;
			return;
		}
		this.#flatIndex = Math.max(0, Math.min(this.#flatIndex, this.#flatRefs.length - 1));
		const maxVisibleRows = this.#maxVisibleRows;
		const maxOffset = Math.max(0, this.#flatRefs.length - maxVisibleRows);
		if (this.#flatIndex < this.#scrollOffset) {
			this.#scrollOffset = this.#flatIndex;
		} else if (this.#flatIndex >= this.#scrollOffset + maxVisibleRows) {
			this.#scrollOffset = this.#flatIndex - maxVisibleRows + 1;
		}
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));
	}

	#emitSelection(): void {
		this.#onSelectionChange(this.#flatIndexToSelection(this.#flatIndex));
	}

	#resolveEntryDepth(ref: SubagentViewRef, isRoot: boolean): number {
		if (isRoot) return 0;
		if (typeof ref.depth === "number" && Number.isFinite(ref.depth)) {
			return Math.max(1, Math.floor(ref.depth));
		}
		return 1;
	}

	#buildFlatList(): void {
		this.#flatRefs = [];
		for (let groupIdx = 0; groupIdx < this.#groups.length; groupIdx++) {
			const group = this.#groups[groupIdx];
			if (!group) continue;
			const rootRef = group.refs.find(r => r.id === group.rootId) ?? group.refs[0];
			if (rootRef) {
				this.#flatRefs.push({
					ref: rootRef,
					groupIdx,
					nestedIdx: -1,
					isRoot: true,
					depth: this.#resolveEntryDepth(rootRef, true),
				});
			}
			const nestedRefs = group.refs.filter(r => r.id !== (rootRef?.id ?? group.rootId));
			for (let nestedIdx = 0; nestedIdx < nestedRefs.length; nestedIdx++) {
				const ref = nestedRefs[nestedIdx];
				if (!ref) continue;
				this.#flatRefs.push({
					ref,
					groupIdx,
					nestedIdx,
					isRoot: false,
					depth: this.#resolveEntryDepth(ref, false),
				});
			}
		}
	}

	#flatIndexToSelection(idx: number): SubagentNavigatorSelection {
		if (this.#flatRefs.length === 0) return { groupIndex: 0, nestedIndex: -1 };
		const safeIndex = Math.max(0, Math.min(idx, this.#flatRefs.length - 1));
		const entry = this.#flatRefs[safeIndex];
		if (!entry) return { groupIndex: 0, nestedIndex: -1 };
		return { groupIndex: entry.groupIdx, nestedIndex: entry.nestedIdx };
	}

	#selectionToFlatIndex(sel: SubagentNavigatorSelection): number {
		if (this.#flatRefs.length === 0) return 0;
		const exact = this.#flatRefs.findIndex(e => e.groupIdx === sel.groupIndex && e.nestedIdx === sel.nestedIndex);
		if (exact >= 0) return exact;
		const groupRoot = this.#flatRefs.findIndex(e => e.groupIdx === sel.groupIndex && e.isRoot);
		if (groupRoot >= 0) return groupRoot;
		const anyInGroup = this.#flatRefs.findIndex(e => e.groupIdx === sel.groupIndex);
		return anyInGroup >= 0 ? anyInGroup : 0;
	}

	#findMostRecentFlatIndex(): number {
		if (this.#flatRefs.length === 0) return 0;
		let bestIndex = 0;
		let bestScore = this.#getRecencyScore(this.#flatRefs[0], 0);
		for (let idx = 1; idx < this.#flatRefs.length; idx += 1) {
			const entry = this.#flatRefs[idx];
			if (!entry) continue;
			const score = this.#getRecencyScore(entry, idx);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = idx;
			}
		}
		return bestIndex;
	}

	#getRecencyScore(entry: FlatEntry, index: number): number {
		const refScore = entry.ref.lastUpdatedMs ?? entry.ref.lastSeenOrder;
		if (typeof refScore === "number" && Number.isFinite(refScore)) return refScore;
		const groupScore = this.#groups[entry.groupIdx]?.lastUpdatedMs;
		if (typeof groupScore === "number" && Number.isFinite(groupScore)) return groupScore;
		return this.#flatRefs.length - index;
	}

	#renderBody(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.#renderHeader(width));
		lines.push(theme.fg("border", "─".repeat(width)));
		if (this.#flatRefs.length === 0) {
			const msg = this.#filterMode ? "No matches" : "No subagents found";
			const pad = Math.max(0, Math.floor((width - visibleWidth(msg)) / 2));
			lines.push(theme.fg("muted", `${" ".repeat(pad)}${msg}`));
		} else {
			const start = this.#scrollOffset;
			const maxVisibleRows = this.#maxVisibleRows;
			const end = Math.min(this.#flatRefs.length, start + maxVisibleRows);
			let previousGroup: number | undefined;
			for (let i = start; i < end; i++) {
				const entry = this.#flatRefs[i];
				if (!entry) continue;
				if (previousGroup !== undefined && previousGroup !== entry.groupIdx) {
					lines.push(theme.fg("dim", "─".repeat(width)));
				}
				lines.push(this.#renderRow(entry, i, width));
				previousGroup = entry.groupIdx;
			}
			lines.push(theme.fg("border", "─".repeat(width)));
			lines.push(this.#renderStatusSummary(width));
		}

		if (this.#filterMode) {
			lines.push(theme.fg("accent", truncateToWidth(`/ ${this.#filterText}█`, width)));
		}

		return lines;
	}

	#renderSelectionSummary(width: number): string[] {
		const selected = this.#currentSelectionEntry();
		if (!selected) return [];

		const ref = selected.ref;
		const lines: string[] = [];
		lines.push(theme.bold(theme.fg("accent", `Selected ${this.#resolveTitle(ref)}`)));

		const infoParts: string[] = [];
		infoParts.push(`${theme.fg("dim", "Role")} ${theme.fg("text", ref.agent ?? "\u2014")}`);
		infoParts.push(`${theme.fg("dim", "Status")} ${renderStatusCell(ref.status)}`);
		if (ref.sessionId) {
			infoParts.push(`${theme.fg("dim", "OMP")} ${theme.fg("text", ref.sessionId)}`);
		}
		infoParts.push(`${theme.fg("dim", "ID")} ${theme.fg("text", ref.id)}`);
		lines.push(infoParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `));

		const detailParts: string[] = [];
		if (ref.mcpServers?.length) {
			detailParts.push(`${theme.fg("dim", "MCP")} ${theme.fg("text", formatList(ref.mcpServers))}`);
		}
		if (ref.toolNames?.length) {
			detailParts.push(`${theme.fg("dim", "Tools")} ${theme.fg("text", String(ref.toolNames.length))}`);
		}
		if (typeof ref.elapsedMs === "number" && Number.isFinite(ref.elapsedMs) && ref.elapsedMs >= 0) {
			detailParts.push(`${theme.fg("dim", "Elapsed")} ${theme.fg("text", formatDuration(ref.elapsedMs))}`);
		}
		const outcomeSummary = formatOutcomeSummary(ref.outcome);
		if (outcomeSummary) {
			detailParts.push(outcomeSummary);
		}
		if (ref.abortReason) {
			detailParts.push(`${theme.fg("dim", "Abort")} ${theme.fg("warning", ref.abortReason)}`);
		}
		if (this.#isSelectionStoppable(ref)) {
			detailParts.push(`${theme.fg("dim", "Action")} ${theme.fg("warning", "S stop")}`);
		}
		if (detailParts.length > 0) {
			lines.push(detailParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `));
		}

		return lines.map(line => truncateToWidth(line, width));
	}

	#renderHeader(width: number): string {
		const cols = buildColumnSpec(width, this.#flatRefs.length);
		const columns = ["#".padStart(cols.indexW), "Title".padEnd(cols.titleW), "Status".padEnd(cols.statusW)];
		if (cols.showResult) {
			columns.push("Result".padEnd(cols.resultW));
		}
		if (cols.showChanges) {
			columns.push("Changes".padEnd(cols.changesW));
		}
		columns.push("Role".padEnd(cols.roleW));
		if (cols.showModel) {
			columns.push("Model".padEnd(cols.modelW));
		}
		if (cols.showLastActive) {
			columns.push("Last Active".padEnd(cols.lastActiveW));
		}
		if (cols.showTokens) {
			columns.push("Tokens".padStart(cols.tokensW));
		}
		const header = columns.join(COLUMN_SEPARATOR);
		return theme.bold(theme.fg("accent", truncateToWidth(header, width)));
	}

	#renderRow(entry: FlatEntry, idx: number, width: number): string {
		const cols = buildColumnSpec(width, this.#flatRefs.length);
		const selected = idx === this.#flatIndex;
		const sep = theme.fg("border", COLUMN_SEPARATOR);
		const titlePrefix = this.#buildTreePrefix(entry, idx);
		const index = String(idx + 1).padStart(cols.indexW);
		const titleText = `${titlePrefix}${this.#resolveTitle(entry.ref)}`;
		const title = padToWidth(truncateToWidth(titleText, cols.titleW), cols.titleW);
		const status = padToWidth(truncateToWidth(renderStatusCell(entry.ref.status), cols.statusW), cols.statusW);
		const columns: string[] = [theme.fg("text", index), theme.fg("text", title), status];

		if (cols.showResult) {
			const result = padToWidth(truncateToWidth(formatOutcomeCell(entry.ref.outcome), cols.resultW), cols.resultW);
			columns.push(result);
		}

		if (cols.showChanges) {
			const changes = padToWidth(truncateToWidth(formatChangesCell(entry.ref), cols.changesW), cols.changesW);
			columns.push(changes);
		}
		const role = padToWidth(truncateToWidth(entry.ref.agent ?? "\u2014", cols.roleW), cols.roleW);
		columns.push(theme.fg("text", role));

		if (cols.showModel) {
			const model = padToWidth(truncateToWidth(formatModelCell(entry.ref.model), cols.modelW), cols.modelW);
			columns.push(theme.fg("text", model));
		}

		const lastActiveMs = entry.ref.lastUpdatedMs ?? this.#groups[entry.groupIdx]?.lastUpdatedMs;
		const lastActiveLabel = formatLastActive(lastActiveMs);
		if (cols.showLastActive) {
			const lastActive = padToWidth(truncateToWidth(lastActiveLabel, cols.lastActiveW), cols.lastActiveW);
			columns.push(theme.fg(lastActiveLabel === "---" ? "dim" : "text", lastActive));
		}

		if (cols.showTokens) {
			const tokens = formatTokens(entry.ref.tokens).padStart(cols.tokensW);
			columns.push(theme.fg("text", tokens));
		}

		const row = columns.join(sep);
		const fitted = padToWidth(truncateToWidth(row, width), width);

		if (selected) {
			return theme.bg("selectedBg", theme.bold(fitted));
		}
		return fitted;
	}

	#resolveParentRefId(entry: FlatEntry): string | undefined {
		if (entry.isRoot) return undefined;
		return entry.ref.parentId ?? this.#groups[entry.groupIdx]?.rootId;
	}

	#findFlatIndexById(groupIdx: number, refId: string): number {
		return this.#flatRefs.findIndex(candidate => candidate.groupIdx === groupIdx && candidate.ref.id === refId);
	}

	#isLastSibling(flatIndex: number): boolean {
		const current = this.#flatRefs[flatIndex];
		if (!current || current.isRoot) return true;
		const parentRefId = this.#resolveParentRefId(current);
		if (!parentRefId) return true;
		for (let idx = flatIndex + 1; idx < this.#flatRefs.length; idx += 1) {
			const candidate = this.#flatRefs[idx];
			if (!candidate || candidate.groupIdx !== current.groupIdx) break;
			if (candidate.depth === current.depth && this.#resolveParentRefId(candidate) === parentRefId) {
				return false;
			}
		}
		return true;
	}

	#hasFollowingSibling(entry: FlatEntry): boolean {
		const flatIndex = this.#findFlatIndexById(entry.groupIdx, entry.ref.id);
		if (flatIndex < 0) return false;
		return !this.#isLastSibling(flatIndex);
	}

	#buildTreePrefix(entry: FlatEntry, flatIndex: number): string {
		if (entry.isRoot) return "";
		const cappedDepth = Math.max(1, Math.min(5, entry.depth));
		let ancestorParentId = this.#resolveParentRefId(entry);
		let levelsToRender = Math.max(0, cappedDepth - 1);
		const trunkSegments: string[] = [];
		while (ancestorParentId && levelsToRender > 0) {
			const ancestorIndex = this.#findFlatIndexById(entry.groupIdx, ancestorParentId);
			const ancestorEntry = ancestorIndex >= 0 ? this.#flatRefs[ancestorIndex] : undefined;
			trunkSegments.unshift(ancestorEntry && this.#hasFollowingSibling(ancestorEntry) ? "  │ " : "    ");
			ancestorParentId = ancestorEntry ? this.#resolveParentRefId(ancestorEntry) : undefined;
			levelsToRender -= 1;
		}
		while (levelsToRender > 0) {
			trunkSegments.unshift("    ");
			levelsToRender -= 1;
		}
		const branch = this.#isLastSibling(flatIndex) ? "└─ " : "├─ ";
		return `${trunkSegments.join("")}  ${branch}`;
	}

	#renderStatusSummary(width: number): string {
		const chips = STATUS_ORDER.map(status => {
			const count = this.#flatRefs.reduce(
				(sum, entry) => sum + (normalizeStatus(entry.ref.status) === status ? 1 : 0),
				0,
			);
			return count > 0 ? renderStatusSummaryChip(status, count) : null;
		}).filter((chip): chip is string => chip !== null);

		return padToWidth(truncateToWidth(chips.join("  "), width), width);
	}

	#resolveTitle(ref: SubagentViewRef): string {
		return ref.description ?? ref.contextPreview ?? extractSubagentTitleFromId(ref.id);
	}

	#renderTopBorder(innerWidth: number): string {
		const active = this.#flatRefs.reduce(
			(count, entry) => count + (this.#isSelectionStoppable(entry.ref) ? 1 : 0),
			0,
		);
		const titleText = `Subagents (${this.#flatRefs.length} total, ${active} active)`;
		const h = theme.boxSharp.horizontal;
		const topLeft = theme.fg("border", theme.boxSharp.topLeft);
		const topRight = theme.fg("border", theme.boxSharp.topRight);
		const leadLen = 1;
		const maxTitleWidth = Math.max(0, innerWidth - leadLen);
		const clippedTitle = truncateToWidth(titleText, maxTitleWidth);
		const trailLen = Math.max(0, innerWidth - leadLen - visibleWidth(clippedTitle));
		const lead = theme.fg("border", h.repeat(leadLen));
		const trail = theme.fg("border", h.repeat(trailLen));
		const title = theme.bold(theme.fg("accent", clippedTitle));
		return `${topLeft}${lead}${title}${trail}${topRight}`;
	}

	#renderBottomBorder(innerWidth: number): string {
		const h = theme.fg("border", theme.boxSharp.horizontal.repeat(innerWidth));
		const left = theme.fg("border", theme.boxSharp.bottomLeft);
		const right = theme.fg("border", theme.boxSharp.bottomRight);
		return `${left}${h}${right}`;
	}

	#frameRow(content: string, innerWidth: number): string {
		const side = theme.fg("border", theme.boxSharp.vertical);
		const fitted = padToWidth(truncateToWidth(content, innerWidth), innerWidth);
		return `${side}${fitted}${side}`;
	}

	#buildFooterHint(): string {
		if (this.#filterMode) {
			return "Enter apply · Esc cancel";
		}
		return "↑↓ navigate · Enter open · / filter · s stop · p parent · g/G top/bottom · Esc close";
	}

	#currentSelectionEntry(): FlatEntry | undefined {
		return this.#flatRefs[this.#flatIndex];
	}

	#isSelectionStoppable(ref: SubagentViewRef): boolean {
		return ref.status === "running" || ref.status === "pending";
	}

	#frameSummaryRow(content: string, innerWidth: number): string {
		const side = theme.fg("borderAccent", theme.boxSharp.vertical);
		const fitted = padToWidth(truncateToWidth(content, innerWidth), innerWidth);
		return `${side}${fitted}${side}`;
	}
}

function buildColumnSpec(width: number, rowCount: number): NavigatorColumns {
	const safeWidth = Math.max(1, width);
	const indexW = clamp(String(Math.max(1, rowCount)).length + 1, MIN_INDEX_WIDTH, 5);
	const statusW = MIN_STATUS_WIDTH;
	const resultW = MIN_RESULT_WIDTH;
	const changesW = MIN_CHANGES_WIDTH;
	const roleW = clamp(Math.floor(safeWidth * 0.13), MIN_ROLE_WIDTH, 14);
	const modelW = clamp(Math.floor(safeWidth * 0.2), MIN_MODEL_WIDTH, 26);
	const lastActiveW = clamp(Math.floor(safeWidth * 0.12), MIN_LAST_ACTIVE_WIDTH, 12);

	const viewportWidth = safeWidth + 2;
	const showResult = viewportWidth >= 80;
	const showChanges = viewportWidth >= 140;
	const showModel = viewportWidth >= 80;
	const showLastActive = viewportWidth >= 100;
	const showTokens = viewportWidth >= 120;
	const visibleColumnCount =
		4 +
		(showResult ? 1 : 0) +
		(showChanges ? 1 : 0) +
		(showModel ? 1 : 0) +
		(showLastActive ? 1 : 0) +
		(showTokens ? 1 : 0);
	const separators = COLUMN_SEPARATOR.length * Math.max(0, visibleColumnCount - 1);
	const titleW = Math.max(
		MIN_TITLE_WIDTH,
		safeWidth -
			indexW -
			statusW -
			roleW -
			(showResult ? resultW : 0) -
			(showChanges ? changesW : 0) -
			(showModel ? modelW : 0) -
			(showLastActive ? lastActiveW : 0) -
			(showTokens ? TOKENS_WIDTH : 0) -
			separators,
	);

	return {
		indexW,
		titleW,
		statusW,
		resultW,
		changesW,
		roleW,
		modelW,
		lastActiveW,
		tokensW: TOKENS_WIDTH,
		showResult,
		showChanges,
		showModel,
		showLastActive,
		showTokens,
	};
}

function extractSubagentTitleFromId(id: string): string {
	const tail = id.split(".").pop() ?? id;
	const dashIndex = tail.indexOf("-");
	if (dashIndex >= 0 && dashIndex < tail.length - 1) {
		return (
			tail
				.slice(dashIndex + 1)
				.replace(/[_-]+/g, " ")
				.trim() || tail
		);
	}
	const normalized = tail.replace(/[_-]+/g, " ").trim();
	return normalized || tail;
}

function normalizeStatus(status?: SubagentStatus): SubagentStatus {
	return status ?? "pending";
}

function getStatusDisplay(status?: SubagentStatus): StatusDisplay {
	switch (normalizeStatus(status)) {
		case "running":
			return { glyph: "●", label: "RUNNING", summaryLabel: "running", color: "success" };
		case "completed":
			return { glyph: "◉", label: "DONE", summaryLabel: "done", color: "accent" };
		case "failed":
			return { glyph: "✗", label: "FAILED", summaryLabel: "failed", color: "error" };
		case "user_stopped":
			return { glyph: "⏹", label: "USER STOPPED", summaryLabel: "user stopped", color: "warning" };
		case "cancelled":
			return { glyph: "⊘", label: "CANCELED", summaryLabel: "canceled", color: "muted" };
		default:
			return { glyph: "◌", label: "PENDING", summaryLabel: "pending", color: "warning" };
	}
}

function renderStatusCell(status?: SubagentStatus): string {
	const display = getStatusDisplay(status);
	return `${theme.fg(display.color, display.glyph)} ${theme.fg(display.color, display.label)}`;
}

function renderStatusSummaryChip(status: SubagentStatus, count: number): string {
	const display = getStatusDisplay(status);
	return theme.fg(display.color, `${display.glyph} ${count} ${display.summaryLabel}`);
}

function formatTokens(tokens?: number): string {
	if (tokens === undefined || tokens === null) return "---";
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(tokens)));
}

function formatList(items?: string[], emptyLabel = "---"): string {
	if (!items || items.length === 0) return emptyLabel;
	return items.join(", ");
}

function formatOutcomeCell(outcome?: SubagentOutcome): string {
	if (!outcome) return theme.fg("dim", "---");
	const label = getSubagentOutcomeLabel(outcome.status);
	const color = outcome.status === "pass" || outcome.status === "go" ? "success" : "error";
	return theme.fg(color, label);
}

function formatChangesCell(ref: SubagentViewRef): string {
	const hasStats = ref.filesChanged !== undefined || ref.linesAdded !== undefined || ref.linesDeleted !== undefined;
	if (!hasStats) return theme.fg("dim", "---");
	const parts: string[] = [];
	if (ref.filesChanged !== undefined && ref.filesChanged > 0) {
		parts.push(theme.fg("accent", `◆${ref.filesChanged}`));
	}
	const added = ref.linesAdded ?? 0;
	const deleted = ref.linesDeleted ?? 0;
	if (added > 0 || deleted > 0) {
		if (added > 0) parts.push(theme.fg("success", `+${added}`));
		if (deleted > 0) parts.push(theme.fg("error", `-${deleted}`));
	}
	return parts.length > 0 ? parts.join(" ") : theme.fg("dim", "---");
}

function formatOutcomeSummary(outcome?: SubagentOutcome): string | undefined {
	if (!outcome) return undefined;
	const label = getSubagentOutcomeLabel(outcome.status);
	const color = outcome.status === "pass" || outcome.status === "go" ? "success" : "error";
	const parts = [`${theme.fg("dim", "Result")} ${theme.fg(color, label)}`];
	if (outcome.summary) {
		parts.push(theme.fg("dim", outcome.summary));
	}
	return parts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `);
}

function formatModelCell(model?: string): string {
	if (!model) return "default";
	return parseModelString(model)?.id ?? model;
}

function toTrustedEpochMs(value?: number): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < MIN_TRUSTED_EPOCH_MS) return undefined;
	return value;
}

function formatLastActive(lastUpdatedMs?: number): string {
	const trustedLastUpdatedMs = toTrustedEpochMs(lastUpdatedMs);
	if (trustedLastUpdatedMs === undefined) return "---";
	const diff = Math.max(0, Date.now() - trustedLastUpdatedMs);
	if (diff < 5_000) return "now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function padToWidth(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - visible);
}

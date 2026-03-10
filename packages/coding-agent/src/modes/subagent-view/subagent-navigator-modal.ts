import { Container, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { SubagentDetailPane } from "./subagent-detail-pane";
import type { SubagentNavigatorSelection, SubagentStatus, SubagentViewGroup, SubagentViewRef } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPLIT_PANE_MIN_WIDTH = 80;
const LIST_PANE_RATIO = 0.35;
const MAX_VISIBLE_ROWS = 18;

const STATUS_GLYPHS: Record<
	SubagentStatus,
	{ glyph: string; label: string; color: "success" | "muted" | "error" | "dim" }
> = {
	running: { glyph: "●", label: "RUNNING", color: "success" },
	completed: { glyph: "◉", label: "DONE", color: "muted" },
	failed: { glyph: "✗", label: "FAILED", color: "error" },
	pending: { glyph: "◌", label: "PENDING", color: "dim" },
	cancelled: { glyph: "⊘", label: "CANCEL", color: "muted" },
};

type FocusPane = "list" | "detail";

// ─── Flat entry for the list ──────────────────────────────────────────────────

interface FlatEntry {
	ref: SubagentViewRef;
	groupIdx: number;
	nestedIdx: number;
	isRoot: boolean;
}

// ─── SubagentNavigatorModal ───────────────────────────────────────────────────

export class SubagentNavigatorModal extends Container {
	// ─ Data ─
	#groups: SubagentViewGroup[] = [];
	#flatRefs: FlatEntry[] = [];
	#flatIndex = 0;
	#scrollOffset = 0;

	// ─ Focus ─
	#focus: FocusPane = "list";

	// ─ Filter ─
	#filterMode = false;
	#filterText = "";
	#unfilteredFlatRefs: FlatEntry[] = [];

	// ─ Sub-components ─
	#detailPane = new SubagentDetailPane();

	// ─ Callbacks ─
	readonly #onSelectionChange: (selection: SubagentNavigatorSelection) => void;
	readonly #onOpenSelection: (selection: SubagentNavigatorSelection) => void;
	readonly #onClose: () => void;

	constructor(
		groups: SubagentViewGroup[],
		selection: SubagentNavigatorSelection,
		options: {
			onSelectionChange: (selection: SubagentNavigatorSelection) => void;
			onOpenSelection: (selection: SubagentNavigatorSelection) => void;
			onClose: () => void;
		},
	) {
		super();
		this.#onSelectionChange = options.onSelectionChange;
		this.#onOpenSelection = options.onOpenSelection;
		this.#onClose = options.onClose;
		this.setGroups(groups, selection);
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	setGroups(groups: SubagentViewGroup[], selection?: SubagentNavigatorSelection): void {
		this.#groups = groups;
		this.#buildFlatList();
		this.#unfilteredFlatRefs = [...this.#flatRefs];
		if (this.#filterMode && this.#filterText) {
			this.#applyFilter();
		}
		if (selection) {
			this.#flatIndex = this.#selectionToFlatIndex(selection);
		}
		this.#clampSelection();
		this.#syncDetailPane();
		this.#emitSelection();
	}

	getSelection(): SubagentNavigatorSelection {
		return this.#flatIndexToSelection(this.#flatIndex);
	}

	getFocus(): FocusPane {
		return this.#focus;
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

		if (this.#focus === "detail") {
			this.#handleDetailInput(keyData);
			return;
		}

		this.#handleListInput(keyData);
	}

	// ─── Render ───────────────────────────────────────────────────────────────

	render(width: number): string[] {
		width = Math.max(1, width);
		const isSplit = width >= SPLIT_PANE_MIN_WIDTH;

		const lines: string[] = [];

		// Title bar
		lines.push(this.#renderTitleBar(width));

		// Body
		if (isSplit) {
			const listWidth = Math.max(20, Math.floor(width * LIST_PANE_RATIO));
			const detailWidth = Math.max(10, width - listWidth - 1); // 1 for separator
			const listLines = this.#renderListPane(listWidth);
			const detailLines = this.#renderDetailPane(detailWidth);
			const bodyHeight = Math.max(listLines.length, detailLines.length, MAX_VISIBLE_ROWS);

			const sep = theme.fg("border", theme.boxSharp.vertical);
			for (let i = 0; i < bodyHeight; i++) {
				const left = i < listLines.length ? listLines[i]! : padToWidth("", listWidth);
				const right = i < detailLines.length ? detailLines[i]! : "";
				lines.push(`${left}${sep}${right}`);
			}
		} else {
			const listLines = this.#renderListPane(width);
			for (const line of listLines) {
				lines.push(line);
			}
		}

		// Footer
		lines.push(this.#renderFooter(width));

		return lines;
	}

	// ─── Input Handlers ───────────────────────────────────────────────────────

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
		if (matchesKey(keyData, "tab")) {
			this.#focus = "detail";
			return;
		}
		if (keyData === "/") {
			this.#enterFilterMode();
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

	#handleDetailInput(keyData: string): void {
		if (keyData === "j" || matchesKey(keyData, "down")) {
			this.#detailPane.scrollBy(1);
			return;
		}
		if (keyData === "k" || matchesKey(keyData, "up")) {
			this.#detailPane.scrollBy(-1);
			return;
		}
		if (matchesKey(keyData, "tab")) {
			this.#focus = "list";
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#onOpenSelection(this.getSelection());
			return;
		}
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#focus = "list";
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
			this.#syncDetailPane();
			this.#emitSelection();
			return;
		}
		// Only accept printable single characters
		if (keyData.length === 1 && keyData.charCodeAt(0) >= 32) {
			this.#filterText += keyData;
			this.#applyFilter();
			this.#clampSelection();
			this.#syncDetailPane();
			this.#emitSelection();
		}
	}

	// ─── Filter Logic ─────────────────────────────────────────────────────────

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
		this.#syncDetailPane();
		this.#emitSelection();
	}

	#applyFilter(): void {
		if (!this.#filterText) {
			this.#flatRefs = [...this.#unfilteredFlatRefs];
			return;
		}
		const needle = this.#filterText.toLowerCase();
		this.#flatRefs = this.#unfilteredFlatRefs.filter(entry => {
			const name = (entry.ref.agent ?? entry.ref.id).toLowerCase();
			const status = (entry.ref.status ?? "").toLowerCase();
			const desc = (entry.ref.description ?? "").toLowerCase();
			return name.includes(needle) || status.includes(needle) || desc.includes(needle);
		});
	}

	// ─── Selection ────────────────────────────────────────────────────────────

	#moveSelection(delta: number): void {
		if (this.#flatRefs.length === 0) return;
		this.#flatIndex = (this.#flatIndex + delta + this.#flatRefs.length) % this.#flatRefs.length;
		this.#clampSelection();
		this.#syncDetailPane();
		this.#emitSelection();
	}

	#clampSelection(): void {
		if (this.#flatRefs.length === 0) {
			this.#flatIndex = 0;
			this.#scrollOffset = 0;
			return;
		}
		this.#flatIndex = Math.max(0, Math.min(this.#flatIndex, this.#flatRefs.length - 1));
		const maxOffset = Math.max(0, this.#flatRefs.length - MAX_VISIBLE_ROWS);
		if (this.#flatIndex < this.#scrollOffset) {
			this.#scrollOffset = this.#flatIndex;
		} else if (this.#flatIndex >= this.#scrollOffset + MAX_VISIBLE_ROWS) {
			this.#scrollOffset = this.#flatIndex - MAX_VISIBLE_ROWS + 1;
		}
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));
	}

	#syncDetailPane(): void {
		const entry = this.#flatRefs[this.#flatIndex];
		this.#detailPane.setRef(entry?.ref);
	}

	#emitSelection(): void {
		this.#onSelectionChange(this.#flatIndexToSelection(this.#flatIndex));
	}

	// ─── Flat list management ─────────────────────────────────────────────────

	#buildFlatList(): void {
		this.#flatRefs = [];
		for (let groupIdx = 0; groupIdx < this.#groups.length; groupIdx++) {
			const group = this.#groups[groupIdx];
			if (!group) continue;
			const rootRef = group.refs.find(r => r.id === group.rootId) ?? group.refs[0];
			if (rootRef) {
				this.#flatRefs.push({ ref: rootRef, groupIdx, nestedIdx: -1, isRoot: true });
			}
			const nestedRefs = group.refs.filter(r => r.id !== (rootRef?.id ?? group.rootId));
			for (let nestedIdx = 0; nestedIdx < nestedRefs.length; nestedIdx++) {
				const ref = nestedRefs[nestedIdx];
				if (!ref) continue;
				this.#flatRefs.push({ ref, groupIdx, nestedIdx, isRoot: false });
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

	// ─── Renderers ────────────────────────────────────────────────────────────

	#renderTitleBar(width: number): string {
		const counts = this.#countByStatus();
		const activeCount = counts.running;
		const totalCount = this.#flatRefs.length;
		const titleText = ` Subagent Flight Deck (${activeCount}/${totalCount} active) `;
		const styledTitle = theme.bold(theme.fg("accent", titleText));
		const h = theme.boxSharp.horizontal;

		const titleVisibleLen = visibleWidth(titleText);
		const cornerLeft = theme.fg("border", theme.boxSharp.topLeft);
		const cornerRight = theme.fg("border", theme.boxSharp.topRight);
		const leadLen = 2;
		const trailLen = Math.max(0, width - titleVisibleLen - leadLen - 2);
		const leadBorder = theme.fg("border", h.repeat(leadLen));
		const trailBorder = theme.fg("border", h.repeat(trailLen));

		return `${cornerLeft}${leadBorder}${styledTitle}${trailBorder}${cornerRight}`;
	}

	#renderListPane(width: number): string[] {
		const lines: string[] = [];

		// Column header
		const headerLine = this.#formatListHeader(width);
		lines.push(headerLine);
		lines.push(theme.fg("muted", "─".repeat(width)));

		if (this.#flatRefs.length === 0) {
			const msg = this.#filterMode ? "No matches" : "No subagents found";
			const pad = Math.max(0, Math.floor((width - visibleWidth(msg)) / 2));
			lines.push(theme.fg("muted", `${" ".repeat(pad)}${msg}`));
		} else {
			const start = this.#scrollOffset;
			const end = Math.min(this.#flatRefs.length, start + MAX_VISIBLE_ROWS);
			let prevGroupIdx: number | undefined;

			for (let i = start; i < end; i++) {
				const entry = this.#flatRefs[i];
				if (!entry) continue;

				if (prevGroupIdx !== undefined && prevGroupIdx !== entry.groupIdx) {
					lines.push(theme.fg("muted", "─".repeat(width)));
				}
				prevGroupIdx = entry.groupIdx;
				lines.push(this.#renderListRow(entry, i, width));
			}
		}

		// Filter prompt line
		if (this.#filterMode) {
			lines.push(theme.fg("accent", `/ ${this.#filterText}█`));
		}

		return lines;
	}

	#formatListHeader(width: number): string {
		const cols = buildColumnSpec(width);
		const header = `${"#".padEnd(cols.indexW)} ${"Role".padEnd(cols.roleW)} ${"Status".padEnd(cols.statusW)} ${"Tokens".padEnd(cols.tokensW)} ${"Age".padEnd(cols.ageW)}`;
		return theme.bold(truncateToWidth(` ${header}`, width));
	}

	#renderListRow(entry: FlatEntry, idx: number, width: number): string {
		const cols = buildColumnSpec(width);
		const isSelected = idx === this.#flatIndex;
		const prefix = entry.isRoot ? "" : "» ";

		const ordinal = String(idx + 1).padStart(2, "0");
		const indexLabel = `${prefix}${ordinal}`.padEnd(cols.indexW).slice(0, cols.indexW);

		const roleName = entry.ref.agent ?? "?";
		const role = roleName.slice(0, cols.roleW).padEnd(cols.roleW);

		const status = entry.ref.status ?? "pending";
		const statusEntry = STATUS_GLYPHS[status] ?? STATUS_GLYPHS.pending;
		const statusText = `${statusEntry.glyph} ${statusEntry.label}`;
		const statusCell = statusText.padEnd(cols.statusW).slice(0, cols.statusW);
		const coloredStatus = theme.fg(statusEntry.color, statusCell);

		const tokens = formatTokens(entry.ref.tokens).padStart(cols.tokensW);
		const age = formatAge(entry.ref.lastUpdatedMs).padEnd(cols.ageW);

		// Build the line parts (no status coloring yet)
		const plainParts = ` ${indexLabel} ${role} `;
		const afterStatus = ` ${tokens} ${age}`;

		const linePlain = truncateToWidth(`${plainParts}${statusCell}${afterStatus}`, width);

		if (isSelected) {
			// For selected: highlight with accent. Status coloring is subsumed by selection highlight.
			return theme.bold(theme.fg("accent", linePlain));
		}

		// For non-selected: apply status color to the status cell only
		const lineWithColor = truncateToWidth(`${plainParts}${coloredStatus}${afterStatus}`, width);
		return theme.fg("text", lineWithColor);
	}

	#renderDetailPane(width: number): string[] {
		this.#detailPane.setAvailableHeight(Math.max(1, MAX_VISIBLE_ROWS));
		return this.#detailPane.render(width);
	}

	#renderFooter(width: number): string[] {
		const lines: string[] = [];
		const h = theme.boxSharp.horizontal;
		const bL = theme.fg("border", theme.boxSharp.bottomLeft);
		const bR = theme.fg("border", theme.boxSharp.bottomRight);

		// Status summary line
		const summary = this.#buildStatusSummary();
		const hints = this.#buildFooterHints();

		const summaryVW = visibleWidth(summary);
		const hintsVW = visibleWidth(hints);
		const gap = Math.max(2, width - summaryVW - hintsVW - 4);
		const footerContent = ` ${summary}${" ".repeat(gap)}${hints} `;

		lines.push(truncateToWidth(footerContent, width));

		// Bottom border
		lines.push(`${bL}${theme.fg("border", h.repeat(Math.max(0, width - 2)))}${bR}`);

		return lines;
	}

	#buildStatusSummary(): string {
		const counts = this.#countByStatus();
		const parts: string[] = [];
		if (counts.running > 0) parts.push(theme.fg("success", `● ${counts.running} running`));
		if (counts.completed > 0) parts.push(theme.fg("muted", `◉ ${counts.completed} done`));
		if (counts.failed > 0) parts.push(theme.fg("error", `✗ ${counts.failed} failed`));
		if (counts.pending > 0) parts.push(theme.fg("dim", `◌ ${counts.pending} pending`));
		if (counts.cancelled > 0) parts.push(theme.fg("muted", `⊘ ${counts.cancelled} cancel`));
		return parts.join("  ");
	}

	#buildFooterHints(): string {
		if (this.#filterMode) {
			return theme.fg("muted", "Enter apply  Esc cancel");
		}
		if (this.#focus === "detail") {
			return theme.fg("muted", "j/k scroll  Tab list  Enter open  Esc back");
		}
		return theme.fg("muted", "↑↓ nav  Enter open  / filter  Tab detail  q quit");
	}

	#countByStatus(): Record<SubagentStatus, number> {
		const counts: Record<SubagentStatus, number> = {
			running: 0,
			completed: 0,
			failed: 0,
			pending: 0,
			cancelled: 0,
		};
		for (const entry of this.#flatRefs) {
			const s = entry.ref.status ?? "pending";
			counts[s] = (counts[s] ?? 0) + 1;
		}
		return counts;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildColumnSpec(_width: number): {
	indexW: number;
	roleW: number;
	statusW: number;
	tokensW: number;
	ageW: number;
} {
	return {
		indexW: 4,
		roleW: 10,
		statusW: 10,
		tokensW: 8,
		ageW: 6,
	};
}

function formatTokens(tokens?: number): string {
	if (tokens === undefined || tokens === null) return "---";
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatAge(lastUpdatedMs?: number): string {
	if (!lastUpdatedMs || !Number.isFinite(lastUpdatedMs) || lastUpdatedMs <= 0) return "---";
	const diff = Math.max(0, Date.now() - lastUpdatedMs);
	if (diff < 5000) return "now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	return `${Math.floor(diff / 3_600_000)}h`;
}

function padToWidth(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - visible);
}

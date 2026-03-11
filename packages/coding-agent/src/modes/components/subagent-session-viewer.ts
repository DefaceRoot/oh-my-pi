import { sanitizeText } from "@oh-my-pi/pi-natives";
import { type Component, matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { SubagentStatus } from "../subagent-view/types";
import { theme } from "../theme/theme";

const MIN_WIDTH = 24;
const MIN_BODY_HEIGHT = 4;

export interface SubagentSessionViewerMetadata {
	agentName?: string;
	role?: string;
	model?: string;
	tokens?: number;
	tokenCapacity?: number;
	status?: SubagentStatus;
	thinkingLevel?: string;
}

export interface SubagentSessionViewerContent {
	headerLines: string[];
	renderTranscriptLines: (width: number) => string[];
	nestedArrowMode: boolean;
	metadata?: SubagentSessionViewerMetadata;
}

export interface SubagentSessionViewerOptions {
	getTerminalRows: () => number;
	leaderKey: string;
	onClose: () => void;
	onNavigateRoot: (direction: 1 | -1) => void;
	onNavigateNested: (direction: 1 | -1) => void;
	onCycleAgentMode: () => void;
}

function renderStatusGlyph(status?: SubagentStatus): string {
	switch (status) {
		case "running":
			return `${theme.fg("success", "●")} ${theme.fg("success", "RUNNING")}`;
		case "completed":
			return `${theme.fg("muted", "◉")} ${theme.fg("muted", "DONE")}`;
		case "failed":
			return `${theme.fg("error", "✗")} ${theme.fg("error", "FAILED")}`;
		case "cancelled":
			return `${theme.fg("muted", "⊘")} ${theme.fg("muted", "CANCELLED")}`;
		default:
			return `${theme.fg("dim", "◌")} ${theme.fg("dim", "PENDING")}`;
	}
}

function formatTokenCount(tokens?: number): string {
	if (tokens == null) return "---";
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export class SubagentSessionViewerComponent implements Component {
	#content: SubagentSessionViewerContent = {
		headerLines: [],
		renderTranscriptLines: () => [],
		nestedArrowMode: false,
	};
	#lastRenderWidth = 80;
	#lastBodyViewportHeight = MIN_BODY_HEIGHT;
	#scrollOffset = 0;
	#followTail = true;
	#contentVersion = 0;
	#cachedBodyVersion = -1;
	#cachedBodyWidth = -1;
	#cachedBodyRows: string[] = [];
	readonly #getTerminalRows: () => number;
	readonly #leaderKey: string;
	readonly #onClose: () => void;
	readonly #onNavigateRoot: (direction: 1 | -1) => void;
	readonly #onNavigateNested: (direction: 1 | -1) => void;
	readonly #onCycleAgentMode: () => void;

	constructor(options: SubagentSessionViewerOptions) {
		this.#getTerminalRows = options.getTerminalRows;
		this.#leaderKey = options.leaderKey;
		this.#onClose = options.onClose;
		this.#onNavigateRoot = options.onNavigateRoot;
		this.#onNavigateNested = options.onNavigateNested;
		this.#onCycleAgentMode = options.onCycleAgentMode;
	}

	setContent(content: SubagentSessionViewerContent): void {
		const wasAtBottom = this.#followTail || this.#isAtBottom();
		this.#content = {
			headerLines: content.headerLines.map(line => sanitizeText(line)),
			renderTranscriptLines: content.renderTranscriptLines,
			nestedArrowMode: content.nestedArrowMode,
			metadata: content.metadata
				? {
						...content.metadata,
						agentName: content.metadata.agentName != null ? sanitizeText(content.metadata.agentName) : undefined,
						role: content.metadata.role != null ? sanitizeText(content.metadata.role) : undefined,
						model: content.metadata.model != null ? sanitizeText(content.metadata.model) : undefined,
						thinkingLevel:
							content.metadata.thinkingLevel != null ? sanitizeText(content.metadata.thinkingLevel) : undefined,
					}
				: undefined,
		};
		this.#contentVersion += 1;
		this.#invalidateBodyCache();
		const maxOffset = this.#maxScrollOffset(this.#lastRenderWidth);
		this.#scrollOffset = wasAtBottom ? maxOffset : Math.max(0, Math.min(this.#scrollOffset, maxOffset));
		this.#followTail = wasAtBottom;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#onClose();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#scrollBy(-this.#lastBodyViewportHeight);
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#scrollBy(this.#lastBodyViewportHeight);
			return;
		}
		if (matchesKey(keyData, "home")) {
			this.#scrollOffset = 0;
			this.#followTail = false;
			return;
		}
		if (matchesKey(keyData, "end")) {
			this.#scrollOffset = this.#maxScrollOffset(this.#lastRenderWidth);
			this.#followTail = true;
			return;
		}
		if (keyData === "k") {
			this.#scrollBy(-1);
			return;
		}
		if (keyData === "j") {
			this.#scrollBy(1);
			return;
		}
		if (matchesKey(keyData, "tab")) {
			this.#onNavigateNested(1);
			return;
		}
		if (matchesKey(keyData, "shift+tab")) {
			this.#onNavigateNested(-1);
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#onNavigateRoot(-1);
			return;
		}
		if (matchesKey(keyData, "right")) {
			this.#onNavigateRoot(1);
			return;
		}
		if (matchesKey(keyData, "up")) {
			if (this.#content.nestedArrowMode) {
				this.#onNavigateNested(-1);
			} else {
				this.#onNavigateRoot(-1);
			}
			return;
		}
		if (matchesKey(keyData, "down")) {
			if (this.#content.nestedArrowMode) {
				this.#onNavigateNested(1);
			} else {
				this.#onNavigateRoot(1);
			}
			return;
		}
		if (keyData === "a" || keyData === "A") {
			this.#onCycleAgentMode();
		}
	}

	invalidate(): void {
		// Stateless render; only scroll and cached transcript rows are retained.
	}

	render(width: number): string[] {
		this.#lastRenderWidth = Math.max(MIN_WIDTH, width);
		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		const metadataRows = this.#buildMetadataLines();
		const headerRows = this.#wrapLines(this.#content.headerLines, innerWidth);
		const bodyRows = this.#bodyRows(innerWidth);
		const footerRowCount = this.#footerRowCount(innerWidth);
		const bodyHeight = this.#bodyHeight(
			this.#lastRenderWidth,
			headerRows.length,
			footerRowCount,
			metadataRows.length,
		);
		this.#lastBodyViewportHeight = bodyHeight;
		const maxOffset = Math.max(0, bodyRows.length - bodyHeight);
		this.#scrollOffset = this.#followTail ? maxOffset : Math.max(0, Math.min(this.#scrollOffset, maxOffset));
		const footerRows = this.#footerLines(bodyRows.length, bodyHeight, innerWidth);
		const visibleBodyRows = bodyRows.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight);
		while (visibleBodyRows.length < bodyHeight) {
			visibleBodyRows.push("");
		}

		const lines: string[] = [this.#frameTop(innerWidth)];
		if (metadataRows.length > 0) {
			for (const row of metadataRows) {
				lines.push(this.#frameLine(row, innerWidth));
			}
			lines.push(this.#frameSeparator(innerWidth));
		}
		for (const row of headerRows) {
			lines.push(this.#frameLine(row, innerWidth));
		}
		lines.push(this.#frameSeparator(innerWidth));
		for (const row of visibleBodyRows) {
			lines.push(this.#frameLine(row, innerWidth));
		}
		lines.push(this.#frameSeparator(innerWidth));
		for (const row of footerRows) {
			lines.push(this.#frameLine(row, innerWidth));
		}
		lines.push(this.#frameBottom(innerWidth));
		return lines.map(line => theme.overlaySurface(line));
	}

	#buildMetadataLines(): string[] {
		const meta = this.#content.metadata;
		if (!meta) return [];

		const hasContent =
			meta.agentName ||
			meta.role ||
			meta.model ||
			meta.tokens != null ||
			meta.tokenCapacity != null ||
			meta.status ||
			meta.thinkingLevel;
		if (!hasContent) return [];

		const lines: string[] = [];
		const sessionLabel = meta.agentName ? `Subagent: ${meta.agentName}` : "Subagent Session";
		lines.push(` ${theme.bold(theme.fg("accent", sessionLabel))}`);
		lines.push(` ${theme.fg("dim", "Status")} ${renderStatusGlyph(meta.status)}`);

		const infoParts: string[] = [];
		if (meta.role) infoParts.push(`${theme.fg("dim", "Role")} ${theme.fg("text", meta.role)}`);
		if (meta.model) infoParts.push(`${theme.fg("dim", "Model")} ${theme.fg("text", meta.model)}`);
		if (infoParts.length > 0) {
			lines.push(` ${infoParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}

		const stats: string[] = [];
		const tokenStr = formatTokenCount(meta.tokens);
		if (meta.tokenCapacity != null) {
			stats.push(`${theme.fg("dim", "Tokens")} ${theme.fg("accent", `${tokenStr}/${formatTokenCount(meta.tokenCapacity)}`)}`);
		} else if (meta.tokens != null) {
			stats.push(`${theme.fg("dim", "Tokens")} ${theme.fg("accent", tokenStr)}`);
		}
		if (meta.thinkingLevel) {
			stats.push(`${theme.fg("dim", "Thinking")} ${theme.fg("text", meta.thinkingLevel)}`);
		}
		if (stats.length > 0) {
			lines.push(` ${stats.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}

		return lines;
	}

	#footerControlsLine(): string {
		return theme.fg(
			"dim",
			`↑↓/j/k scroll  PgUp/PgDn page  Home/End  ←/→ task  Tab/Shift+Tab nested  ${this.#leaderKey} close`,
		);
	}

	#footerRowCount(innerWidth: number): number {
		return 1 + this.#wrapLines([this.#footerControlsLine()], innerWidth).length;
	}

	#footerLines(totalBodyRows: number, bodyHeight: number, innerWidth: number): string[] {
		const maxOffset = Math.max(0, totalBodyRows - bodyHeight);
		const start = totalBodyRows === 0 ? 0 : Math.min(totalBodyRows, this.#scrollOffset + 1);
		const end = Math.min(totalBodyRows, this.#scrollOffset + bodyHeight);
		const isFollowingTail = maxOffset === 0 || this.#scrollOffset >= maxOffset;
		const tailMode = isFollowingTail ? "FOLLOWING TAIL" : "TAIL PAUSED";
		const status = `${theme.fg("dim", `lines ${start}-${end}/${totalBodyRows}`)} ${theme.fg(isFollowingTail ? "success" : "warning", tailMode)}`;
		return [status, ...this.#wrapLines([this.#footerControlsLine()], innerWidth)];
	}

	#wrapLines(lines: string[], width: number): string[] {
		if (lines.length === 0) return [""];
		const wrapped: string[] = [];
		for (const rawLine of lines) {
			const normalized = rawLine.length === 0 ? "" : rawLine;
			const rows = normalized.length === 0 ? [""] : wrapTextWithAnsi(normalized, width);
			wrapped.push(...rows);
		}
		return wrapped;
	}

	#bodyRows(innerWidth: number): string[] {
		if (this.#cachedBodyVersion === this.#contentVersion && this.#cachedBodyWidth === innerWidth) {
			return this.#cachedBodyRows;
		}
		const rawRows = this.#content.renderTranscriptLines(innerWidth);
		const safeRows = rawRows
			.filter((line): line is string => typeof line === "string")
			.map(line => sanitizeText(line));
		const wrappedRows = this.#wrapLines(safeRows.length > 0 ? safeRows : [theme.fg("dim", "(no transcript content)")], innerWidth);
		this.#cachedBodyRows = wrappedRows;
		this.#cachedBodyWidth = innerWidth;
		this.#cachedBodyVersion = this.#contentVersion;
		return wrappedRows;
	}

	#invalidateBodyCache(): void {
		this.#cachedBodyRows = [];
		this.#cachedBodyWidth = -1;
		this.#cachedBodyVersion = -1;
	}

	#bodyHeight(width: number, headerRows?: number, footerRows?: number, metadataRows?: number): number {
		const maxHeight = Math.max(12, Math.floor(this.#getTerminalRows() * 0.82));
		const innerWidth = Math.max(1, Math.max(MIN_WIDTH, width) - 2);
		const resolvedHeaderRows = headerRows ?? this.#wrapLines(this.#content.headerLines, innerWidth).length;
		const resolvedFooterRows = footerRows ?? 2;
		const resolvedMetadataRows = metadataRows ?? this.#buildMetadataLines().length;
		const metaSep = resolvedMetadataRows > 0 ? 1 : 0;
		return Math.max(
			MIN_BODY_HEIGHT,
			maxHeight - resolvedHeaderRows - resolvedFooterRows - resolvedMetadataRows - metaSep - 4,
		);
	}

	#maxScrollOffset(width: number): number {
		const innerWidth = Math.max(1, Math.max(MIN_WIDTH, width) - 2);
		const bodyRows = this.#bodyRows(innerWidth);
		return Math.max(0, bodyRows.length - this.#bodyHeight(width));
	}

	#scrollBy(delta: number): void {
		const maxOffset = this.#maxScrollOffset(this.#lastRenderWidth);
		this.#scrollOffset = Math.max(0, Math.min(maxOffset, this.#scrollOffset + delta));
		this.#followTail = this.#scrollOffset >= maxOffset;
	}

	#isAtBottom(): boolean {
		return this.#scrollOffset >= this.#maxScrollOffset(this.#lastRenderWidth);
	}

	#frameTop(innerWidth: number): string {
		const b = (s: string) => theme.fg("borderAccent", s);
		return `${b(theme.boxSharp.topLeft)}${b(theme.boxSharp.horizontal.repeat(innerWidth))}${b(theme.boxSharp.topRight)}`;
	}

	#frameSeparator(innerWidth: number): string {
		const b = (s: string) => theme.fg("borderAccent", s);
		return `${b(theme.boxSharp.teeRight)}${b(theme.boxSharp.horizontal.repeat(innerWidth))}${b(theme.boxSharp.teeLeft)}`;
	}

	#frameBottom(innerWidth: number): string {
		const b = (s: string) => theme.fg("borderAccent", s);
		return `${b(theme.boxSharp.bottomLeft)}${b(theme.boxSharp.horizontal.repeat(innerWidth))}${b(theme.boxSharp.bottomRight)}`;
	}

	#frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		const border = theme.fg("borderAccent", theme.boxSharp.vertical);
		return `${border}${truncated}${padding(remaining)}${border}`;
	}
}

import { sanitizeText } from "@oh-my-pi/pi-natives";
import { type Component, matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import type { SubagentStatus } from "../subagent-view/types";
import { theme } from "../theme/theme";

const MIN_WIDTH = 40;
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
	bodyLines: string[];
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
			return `${theme.fg("muted", "⊘")} ${theme.fg("muted", "CANCEL")}`;
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
	#content: SubagentSessionViewerContent = { headerLines: [], bodyLines: [], nestedArrowMode: false };
	#lastRenderWidth = 80;
	#scrollOffset = 0;
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
		const wasAtBottom = this.#isAtBottom();
		this.#content = {
			headerLines: content.headerLines.map(line => sanitizeText(line)),
			bodyLines: content.bodyLines.map(line => sanitizeText(line)),
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
		const maxOffset = this.#maxScrollOffset(this.#lastRenderWidth);
		this.#scrollOffset = wasAtBottom ? maxOffset : Math.max(0, Math.min(this.#scrollOffset, maxOffset));
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#onClose();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#scrollBy(-this.#bodyHeight(this.#lastRenderWidth));
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#scrollBy(this.#bodyHeight(this.#lastRenderWidth));
			return;
		}
		if (matchesKey(keyData, "home")) {
			this.#scrollOffset = 0;
			return;
		}
		if (matchesKey(keyData, "end")) {
			this.#scrollOffset = this.#maxScrollOffset(this.#lastRenderWidth);
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
		// Stateless render; nothing cached outside render width and scroll offset.
	}

	render(width: number): string[] {
		this.#lastRenderWidth = Math.max(MIN_WIDTH, width);
		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		const metadataRows = this.#buildMetadataLines();
		const headerRows = this.#wrapLines(this.#content.headerLines, innerWidth);
		const bodyRows = this.#wrapLines(this.#content.bodyLines, innerWidth);
		const footerRows = this.#wrapLines(this.#footerLines(bodyRows.length), innerWidth);
		const bodyHeight = this.#bodyHeight(
			this.#lastRenderWidth,
			headerRows.length,
			footerRows.length,
			metadataRows.length,
		);
		const maxOffset = Math.max(0, bodyRows.length - bodyHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));
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
		return lines;
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

		// Line 1: Agent name + status glyph
		const nameLabel = meta.agentName ? theme.bold(theme.fg("accent", meta.agentName)) : "";
		const statusLabel = renderStatusGlyph(meta.status);
		lines.push(` ${nameLabel}  ${statusLabel}`);

		// Line 2: Role + Model
		const infoParts: string[] = [];
		if (meta.role) infoParts.push(`Role: ${theme.fg("dim", meta.role)}`);
		if (meta.model) infoParts.push(`Model: ${theme.fg("dim", meta.model)}`);
		if (infoParts.length > 0) {
			lines.push(` ${infoParts.join("  ")}`);
		}

		// Line 3: Tokens + Thinking level
		const statParts: string[] = [];
		const tokenStr = formatTokenCount(meta.tokens);
		if (meta.tokenCapacity != null) {
			statParts.push(`Tokens: ${theme.fg("dim", `${tokenStr}/${formatTokenCount(meta.tokenCapacity)}`)}`);
		} else if (meta.tokens != null) {
			statParts.push(`Tokens: ${theme.fg("dim", tokenStr)}`);
		}
		if (meta.thinkingLevel) {
			statParts.push(`Thinking: ${theme.fg("dim", meta.thinkingLevel)}`);
		}
		if (statParts.length > 0) {
			lines.push(` ${statParts.join("  ")}`);
		}

		return lines;
	}

	#footerLines(totalBodyRows: number): string[] {
		const bodyHeight = this.#bodyHeight(this.#lastRenderWidth);
		const maxOffset = Math.max(0, totalBodyRows - bodyHeight);
		const start = totalBodyRows === 0 ? 0 : Math.min(totalBodyRows, this.#scrollOffset + 1);
		const end = Math.min(totalBodyRows, this.#scrollOffset + bodyHeight);
		const pinned = maxOffset === 0 || this.#scrollOffset >= maxOffset ? theme.fg("success", " newest") : "";
		const status = theme.fg("dim", ` lines ${start}-${end}/${totalBodyRows} `) + pinned;
		const controls = theme.fg("dim", " ↑↓/j/k scroll  PgUp/PgDn page  Home/End  Esc back to navigator");
		return [status, controls];
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
		const bodyRows = this.#wrapLines(this.#content.bodyLines, innerWidth);
		return Math.max(0, bodyRows.length - this.#bodyHeight(width));
	}

	#scrollBy(delta: number): void {
		const maxOffset = this.#maxScrollOffset(this.#lastRenderWidth);
		this.#scrollOffset = Math.max(0, Math.min(maxOffset, this.#scrollOffset + delta));
	}

	#isAtBottom(): boolean {
		return this.#scrollOffset >= this.#maxScrollOffset(this.#lastRenderWidth);
	}

	#frameTop(innerWidth: number): string {
		const b = (s: string) => theme.fg("borderAccent", s);
		const agentName = this.#content.metadata?.agentName;
		const titleText = agentName ? `Subagent Viewer: ${agentName}` : "Subagent Viewer";
		const maxTitleWidth = innerWidth - 6;
		if (maxTitleWidth < 3) {
			return `${b(theme.boxSharp.topLeft)}${b(theme.boxSharp.horizontal.repeat(innerWidth))}${b(theme.boxSharp.topRight)}`;
		}
		const clippedText =
			visibleWidth(titleText) > maxTitleWidth ? truncateToWidth(titleText, maxTitleWidth) : titleText;
		const titleRaw = `━━ ${clippedText} ━━`;
		const titleWidth = visibleWidth(titleRaw);
		const fillWidth = Math.max(0, innerWidth - titleWidth);
		const titleColored = theme.bold(theme.fg("accent", titleRaw));
		const fill = b(theme.boxSharp.horizontal.repeat(fillWidth));
		return `${b(theme.boxSharp.topLeft)}${titleColored}${fill}${b(theme.boxSharp.topRight)}`;
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

import { sanitizeText } from "@oh-my-pi/pi-natives";
import { type Component, matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { getSubagentOutcomeLabel, getSubagentOutcomeTone, type SubagentOutcome } from "../../task/subagent-outcome";
import { formatDuration } from "../../tools/render-utils";
import type { SubagentStatus } from "../subagent-view/types";
import { theme } from "../theme/theme";

const MIN_WIDTH = 24;
const MIN_BODY_HEIGHT = 4;

export interface SubagentSessionViewerMetadata {
	agentName?: string;
	subagentId?: string;
	sessionId?: string;
	role?: string;
	delegationChain?: string[];
	provider?: string;
	model?: string;
	tokens?: number;
	tokenCapacity?: number;
	status?: SubagentStatus;
	thinkingLevel?: string;
	elapsedMs?: number;
	toolNames?: string[];
	mcpServers?: string[];
	mcpAllowlist?: string[];
	abortReason?: string;
	outcome?: SubagentOutcome;
	canStop?: boolean;
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
	onStop?: () => void;
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
		case "user_stopped":
			return `${theme.fg("warning", "⏹")} ${theme.fg("warning", "USER STOPPED")}`;
		default:
			return `${theme.fg("dim", "◌")} ${theme.fg("dim", "PENDING")}`;
	}
}

function formatTokenCount(tokens?: number): string {
	if (tokens == null) return "---";
	return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(tokens)));
}

function formatList(items?: string[], emptyLabel = "---"): string {
	if (!items || items.length === 0) return emptyLabel;
	return items.join(", ");
}

function sanitizeList(items?: string[]): string[] | undefined {
	if (!items) return undefined;
	const sanitized = items.map(item => sanitizeText(item)).filter((item): item is string => item.length > 0);
	return sanitized.length > 0 ? sanitized : undefined;
}

function extractSubagentOrdinal(subagentId?: string): string | undefined {
	if (!subagentId) return undefined;
	const match = subagentId.match(/^(\d+)/);
	return match?.[1];
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
	readonly #onStop?: () => void;

	constructor(options: SubagentSessionViewerOptions) {
		this.#getTerminalRows = options.getTerminalRows;
		this.#leaderKey = options.leaderKey;
		this.#onClose = options.onClose;
		this.#onNavigateRoot = options.onNavigateRoot;
		this.#onNavigateNested = options.onNavigateNested;
		this.#onCycleAgentMode = options.onCycleAgentMode;
		this.#onStop = options.onStop;
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
						delegationChain: sanitizeList(content.metadata.delegationChain),
						subagentId:
							content.metadata.subagentId != null ? sanitizeText(content.metadata.subagentId) : undefined,
						sessionId: content.metadata.sessionId != null ? sanitizeText(content.metadata.sessionId) : undefined,
						provider: content.metadata.provider != null ? sanitizeText(content.metadata.provider) : undefined,
						model: content.metadata.model != null ? sanitizeText(content.metadata.model) : undefined,
						thinkingLevel:
							content.metadata.thinkingLevel != null ? sanitizeText(content.metadata.thinkingLevel) : undefined,
						elapsedMs: content.metadata.elapsedMs,
						toolNames: sanitizeList(content.metadata.toolNames),
						mcpServers: sanitizeList(content.metadata.mcpServers),
						mcpAllowlist: sanitizeList(content.metadata.mcpAllowlist),
						abortReason:
							content.metadata.abortReason != null ? sanitizeText(content.metadata.abortReason) : undefined,
						outcome: content.metadata.outcome
							? {
									...content.metadata.outcome,
									label:
										content.metadata.outcome.label != null
											? sanitizeText(content.metadata.outcome.label)
											: undefined,
									summary:
										content.metadata.outcome.summary != null
											? sanitizeText(content.metadata.outcome.summary)
											: undefined,
								}
							: undefined,
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
			return;
		}
		if ((keyData === "s" || keyData === "S") && this.#content.metadata?.canStop) {
			this.#onStop?.();
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
			meta.subagentId ||
			meta.sessionId ||
			meta.role ||
			(meta.delegationChain?.length ?? 0) > 0 ||
			meta.provider ||
			meta.model ||
			meta.tokens != null ||
			meta.tokenCapacity != null ||
			meta.status ||
			meta.thinkingLevel ||
			meta.elapsedMs != null ||
			(meta.toolNames?.length ?? 0) > 0 ||
			(meta.mcpServers?.length ?? 0) > 0 ||
			(meta.mcpAllowlist?.length ?? 0) > 0 ||
			meta.outcome ||
			meta.abortReason;
		if (!hasContent) return [];
		const lines: string[] = [];
		const ordinal = extractSubagentOrdinal(meta.subagentId);
		const titleLabel = ordinal ? `Subagent #${ordinal}` : "Subagent Session";
		const titleSuffix = meta.agentName ? ` ${theme.fg("text", `· ${meta.agentName}`)}` : "";
		lines.push(` ${theme.bold(theme.fg("accent", `${titleLabel}${titleSuffix}`))}`);
		const delegationChain = meta.delegationChain;
		if (delegationChain && delegationChain.length > 0) {
			const breadcrumb = delegationChain.join(` ${theme.fg("statusLineSep", "›")} `);
			lines.push(` ${theme.fg("dim", "Delegation")} ${theme.fg("text", breadcrumb)}`);
		}
		if (meta.subagentId) {
			lines.push(` ${theme.fg("dim", "Subagent ID")} ${theme.fg("text", meta.subagentId)}`);
		}
		if (meta.sessionId) {
			lines.push(` ${theme.fg("dim", "OMP Session")} ${theme.fg("text", meta.sessionId)}`);
		}
		lines.push(` ${theme.fg("dim", "Status")} ${renderStatusGlyph(meta.status)}`);
		const infoParts: string[] = [];
		if (meta.role) infoParts.push(`${theme.fg("dim", "Role")} ${theme.fg("text", meta.role)}`);
		if (meta.provider) infoParts.push(`${theme.fg("dim", "Provider")} ${theme.fg("text", meta.provider)}`);
		if (meta.model) infoParts.push(`${theme.fg("dim", "Model")} ${theme.fg("text", meta.model)}`);
		if (infoParts.length > 0) {
			lines.push(` ${infoParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}
		const stats: string[] = [];
		if (meta.tokens != null) {
			stats.push(`${theme.fg("dim", "Tokens")} ${theme.fg("accent", formatTokenCount(meta.tokens))}`);
		}
		if (meta.tokenCapacity != null) {
			stats.push(`${theme.fg("dim", "Capacity")} ${theme.fg("text", formatTokenCount(meta.tokenCapacity))}`);
		}
		if (meta.thinkingLevel) {
			stats.push(`${theme.fg("dim", "Thinking")} ${theme.fg("text", meta.thinkingLevel)}`);
		}
		if (meta.elapsedMs != null) {
			stats.push(`${theme.fg("dim", "Elapsed")} ${theme.fg("text", formatDuration(meta.elapsedMs))}`);
		}
		if (stats.length > 0) {
			lines.push(` ${stats.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}
		const toolCount = meta.toolNames?.length ?? 0;
		const usedMcpServers = meta.mcpServers ?? [];
		const configuredMcpAllowlist = meta.mcpAllowlist ?? [];
		if (toolCount > 0 || usedMcpServers.length > 0 || configuredMcpAllowlist.length > 0) {
			const detailParts: string[] = [];
			if (toolCount > 0) {
				detailParts.push(`${theme.fg("dim", "Tools")} ${theme.fg("text", String(toolCount))}`);
			}
			if (usedMcpServers.length > 0) {
				detailParts.push(`${theme.fg("dim", "MCP")} ${theme.fg("text", formatList(usedMcpServers))}`);
			}
			if (configuredMcpAllowlist.length > 0) {
				detailParts.push(`${theme.fg("dim", "Allowed MCP")} ${theme.fg("text", formatList(configuredMcpAllowlist))}`);
			}
			lines.push(` ${detailParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}
		if (meta.abortReason) {
			lines.push(` ${theme.fg("dim", "Abort")} ${theme.fg("warning", meta.abortReason)}`);
		}
		if (meta.outcome) {
			const outcomeLabel = getSubagentOutcomeLabel(meta.outcome.status);
			const outcomeTone = getSubagentOutcomeTone(meta.outcome.status);
			const outcomeParts = [`${theme.fg("dim", "Outcome")} ${theme.fg(outcomeTone, outcomeLabel)}`];
			if (meta.outcome.summary) {
				outcomeParts.push(theme.fg("dim", truncateToWidth(meta.outcome.summary, 80)));
			}
			lines.push(` ${outcomeParts.join(` ${theme.fg("statusLineSep", theme.sep.dot)} `)}`);
		}
		if (meta.canStop) {
			lines.push(` ${theme.fg("dim", "Action")} ${theme.fg("warning", "S stop")}`);
		}

		return lines;
	}

	#footerControlsLine(): string {
		const controls = ["↑↓/j/k scroll", "PgUp/PgDn page", "Home/End", "←/→ task", "Tab/Shift+Tab nested"];
		if (this.#content.metadata?.canStop) {
			controls.push("S stop");
		}
		controls.push(`${this.#leaderKey} close`);
		return theme.fg("dim", controls.join("  "));
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
		const safeRows = rawRows.filter((line): line is string => typeof line === "string");
		const wrappedRows = this.#wrapLines(
			safeRows.length > 0 ? safeRows : [theme.fg("dim", "(no transcript content)")],
			innerWidth,
		);
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

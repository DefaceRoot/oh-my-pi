import { sanitizeText } from "@oh-my-pi/pi-natives";
import { type Component, matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { getSubagentOutcomeLabel, getSubagentOutcomeTone, type SubagentOutcome } from "../../task/subagent-outcome";
import { formatDuration } from "../../tools/render-utils";
import type { SubagentStatus } from "../subagent-view/types";
import { theme } from "../theme/theme";

const MIN_WIDTH = 24;
const MIN_BODY_HEIGHT = 4;
const SIDEBAR_WIDTH = 36;

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
	canResume?: boolean;
	/** File edit statistics for display */
	filesChanged?: number;
	linesAdded?: number;
	linesDeleted?: number;
}

export interface SubagentSessionViewerContent {
	headerLines: string[];
	hierarchyLines?: string[];
	renderTranscriptLines: (width: number) => string[];
	nestedArrowMode: boolean;
	metadataExpanded?: boolean;
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
	onResume?: () => void;
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
	#contextExpanded: boolean = false;
	#hierarchyPanelOpen: boolean = false;
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
	readonly #onResume?: () => void;

	constructor(options: SubagentSessionViewerOptions) {
		this.#getTerminalRows = options.getTerminalRows;
		this.#leaderKey = options.leaderKey;
		this.#onClose = options.onClose;
		this.#onNavigateRoot = options.onNavigateRoot;
		this.#onNavigateNested = options.onNavigateNested;
		this.#onCycleAgentMode = options.onCycleAgentMode;
		this.#onStop = options.onStop;
		this.#onResume = options.onResume;
	}

	setContent(content: SubagentSessionViewerContent): void {
		const wasAtBottom = this.#followTail || this.#isAtBottom();
		// Persist expand state across refreshes unless caller explicitly overrides
		this.#contextExpanded = content.metadataExpanded ?? this.#contextExpanded;
		this.#content = {
			headerLines: content.headerLines.map(line => sanitizeText(line)),
			hierarchyLines: content.hierarchyLines?.map(line => sanitizeText(line)),
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
		if (keyData === "m" || keyData === "M") {
			this.#contextExpanded = !this.#contextExpanded;
			return;
		}
		if (keyData === "h" || keyData === "H") {
			this.#hierarchyPanelOpen = !this.#hierarchyPanelOpen;
			return;
		}
		if (keyData === "a" || keyData === "A") {
			this.#onCycleAgentMode();
			return;
		}
		if ((keyData === "s" || keyData === "S") && this.#content.metadata?.canStop) {
			this.#onStop?.();
		}
		if ((keyData === "r" || keyData === "R") && this.#content.metadata?.canResume) {
			this.#onResume?.();
		}
	}

	invalidate(): void {
		// Stateless render; only scroll and cached transcript rows are retained.
	}

	render(width: number): string[] {
		this.#lastRenderWidth = Math.max(MIN_WIDTH, width);
		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		const { sidebarOpen, sidebarWidth, bodyWidth } = this.#sidebarLayout(innerWidth);
		const titleRows = this.#wrapLines(this.#buildTitleLines(), innerWidth);
		const metadataRows = this.#wrapLines(this.#buildMetadataLines(), innerWidth);
		const headerRows = this.#contextExpanded ? this.#wrapLines(this.#content.headerLines, innerWidth) : [];
		const sidebarRows = sidebarOpen ? this.#buildHierarchyPanelLines(sidebarWidth) : [];
		const bodyRows = this.#bodyRows(bodyWidth);
		const footerRowCount = this.#footerRowCount(innerWidth);
		const bodyHeight = this.#bodyHeight(
			this.#lastRenderWidth,
			titleRows.length,
			headerRows.length,
			footerRowCount,
			metadataRows.length,
		);
		const transcriptViewportHeight = bodyHeight;
		this.#lastBodyViewportHeight = transcriptViewportHeight;
		const maxOffset = Math.max(0, bodyRows.length - transcriptViewportHeight);
		this.#scrollOffset = this.#followTail ? maxOffset : Math.max(0, Math.min(this.#scrollOffset, maxOffset));
		const footerRows = this.#footerLines(bodyRows.length, transcriptViewportHeight, innerWidth);
		const visibleTranscriptRows = bodyRows.slice(
			this.#scrollOffset,
			this.#scrollOffset + transcriptViewportHeight,
		);
		const visibleBodyRows: string[] = [];
		for (let index = 0; index < bodyHeight; index += 1) {
			const transcriptRow = visibleTranscriptRows[index] ?? "";
			if (!sidebarOpen) {
				visibleBodyRows.push(transcriptRow);
				continue;
			}
			const sidebarRow = sidebarRows[index] ?? "";
			const paddedTranscript = this.#padOrTruncate(transcriptRow, bodyWidth);
			const paddedSidebar = this.#padOrTruncate(sidebarRow, sidebarWidth);
			visibleBodyRows.push(`${paddedTranscript}${theme.fg("dim", "│")}${paddedSidebar}`);
		}

		const lines: string[] = [this.#frameTop(innerWidth)];
		for (const row of titleRows) {
			lines.push(this.#frameLine(row, innerWidth));
		}
		for (const row of metadataRows) {
			lines.push(this.#frameLine(row, innerWidth));
		}
		lines.push(this.#frameSeparator(innerWidth));
		if (this.#contextExpanded) {
			for (const row of headerRows) {
				lines.push(this.#frameLine(row, innerWidth));
			}
			lines.push(this.#frameSeparator(innerWidth));
		}
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

	#buildTitleLines(): string[] {
		const meta = this.#content.metadata;
		const dotSep = ` ${theme.fg("statusLineSep", theme.sep.dot)} `;
		const titleParts: string[] = [];
		const ordinal = extractSubagentOrdinal(meta?.subagentId);
		const agentLabel = meta?.agentName ?? meta?.role;

		titleParts.push(theme.bold(theme.fg("accent", ordinal != null ? `Subagent #${ordinal}` : "Subagent")));
		if (agentLabel) {
			titleParts.push(theme.fg("text", agentLabel));
		}
		if (meta?.filesChanged != null && meta.filesChanged > 0) {
			const added = meta.linesAdded ?? 0;
			const deleted = meta.linesDeleted ?? 0;
			titleParts.push(
				`${theme.fg("accent", `◆${meta.filesChanged}`)} ${theme.fg("success", `+${added}`)}${theme.fg("error", `-${deleted}`)}`,
			);
		}
		titleParts.push(renderStatusGlyph(meta?.status));
		if (meta?.provider || meta?.model) {
			titleParts.push(theme.fg("dim", [meta.provider, meta.model].filter(Boolean).join("/")));
		}
		if (meta?.tokens != null) {
			titleParts.push(`${theme.fg("dim", "tokens")} ${theme.fg("accent", formatTokenCount(meta.tokens))}`);
		}
		titleParts.push(theme.fg("dim", this.#contextExpanded ? "[m ▾]" : "[m ·]"));
		if ((this.#content.hierarchyLines?.length ?? 0) > 0) {
			titleParts.push(theme.fg("dim", "[h hier]"));
		}

		return [` ${titleParts.join(dotSep)}`];
	}

	#buildMetadataLines(): string[] {
		const meta = this.#content.metadata;
		if (!meta) return [];

		const hasContent =
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
			meta.abortReason ||
			meta.canStop ||
			meta.canResume;
		if (!hasContent) return [];

		const dotSep = ` ${theme.fg("statusLineSep", theme.sep.dot)} `;
		const lines: string[] = [];
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
			lines.push(` ${infoParts.join(dotSep)}`);
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
			lines.push(` ${stats.join(dotSep)}`);
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
			lines.push(` ${detailParts.join(dotSep)}`);
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
			lines.push(` ${outcomeParts.join(dotSep)}`);
		}
		if (meta.canStop) {
			lines.push(` ${theme.fg("dim", "Action")} ${theme.fg("warning", "S stop")}`);
		}
		if (meta.canResume) {
			lines.push(` ${theme.fg("dim", "Action")} ${theme.fg("success", "R resume")}`);
		}

		return lines;
	}

	#buildHierarchyPanelLines(innerWidth: number): string[] {
		const hierarchyLines = this.#content.hierarchyLines;
		if (!this.#hierarchyPanelOpen || !hierarchyLines || hierarchyLines.length === 0) return [];

		const headingLabel = "Hierarchy (h close)";
		const headingPrefix = "─── ";
		const headingBase = `${headingPrefix}${headingLabel} `;
		const fillWidth = Math.max(0, innerWidth - visibleWidth(headingBase));
		const heading = `${theme.fg("borderAccent", headingPrefix)}${theme.bold(theme.fg("accent", headingLabel))}${theme.fg("borderAccent", ` ${"─".repeat(fillWidth)}`)}`;
		return this.#wrapLines([heading, ...hierarchyLines], innerWidth);
	}

	#footerControlsLine(): string {
		const controls = ["↑↓/j/k scroll", "PgUp/PgDn page", "Home/End", "←/→ task", "Tab/Shift+Tab nested"];
		controls.push(this.#contextExpanded ? "m collapse" : "m details");
		if ((this.#content.hierarchyLines?.length ?? 0) > 0) {
			controls.push("h hierarchy");
		}
		if (this.#content.metadata?.canStop) {
			controls.push("S stop");
		}
		if (this.#content.metadata?.canResume) {
			controls.push("R resume");
		}
		controls.push(`${this.#leaderKey} close`);
		return theme.fg("dim", controls.join("  "));
	}

	#footerRowCount(innerWidth: number): number {
		return 1 + this.#wrapLines([this.#footerControlsLine()], innerWidth).length;
	}

	#footerLines(totalBodyRows: number, transcriptViewportHeight: number, innerWidth: number): string[] {
		const maxOffset = Math.max(0, totalBodyRows - transcriptViewportHeight);
		const start = totalBodyRows === 0 ? 0 : Math.min(totalBodyRows, this.#scrollOffset + 1);
		const end = Math.min(totalBodyRows, this.#scrollOffset + transcriptViewportHeight);
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

	#sidebarLayout(innerWidth: number): { sidebarOpen: boolean; sidebarWidth: number; bodyWidth: number } {
		const hasHierarchy = (this.#content.hierarchyLines?.length ?? 0) > 0;
		const wantsSidebar = this.#hierarchyPanelOpen && hasHierarchy;
		if (!wantsSidebar) {
			return { sidebarOpen: false, sidebarWidth: 0, bodyWidth: innerWidth };
		}
		const maxSidebarWidth = innerWidth - MIN_WIDTH - 1;
		if (maxSidebarWidth < 1) {
			return { sidebarOpen: false, sidebarWidth: 0, bodyWidth: innerWidth };
		}
		const sidebarWidth = Math.min(SIDEBAR_WIDTH, maxSidebarWidth);
		return { sidebarOpen: true, sidebarWidth, bodyWidth: innerWidth - sidebarWidth - 1 };
	}

	#padOrTruncate(content: string, width: number): string {
		const truncated = truncateToWidth(content, width);
		const remaining = Math.max(0, width - visibleWidth(truncated));
		return `${truncated}${padding(remaining)}`;
	}

	#invalidateBodyCache(): void {
		this.#cachedBodyRows = [];
		this.#cachedBodyWidth = -1;
		this.#cachedBodyVersion = -1;
	}

	#bodyHeight(
		width: number,
		titleRows?: number,
		headerRows?: number,
		footerRows?: number,
		metadataRows?: number,
	): number {
		const maxHeight = Math.max(12, Math.floor(this.#getTerminalRows() * 0.82));
		const innerWidth = Math.max(1, Math.max(MIN_WIDTH, width) - 2);
		const resolvedTitleRows = titleRows ?? this.#wrapLines(this.#buildTitleLines(), innerWidth).length;
		const resolvedMetadataRows = metadataRows ?? this.#wrapLines(this.#buildMetadataLines(), innerWidth).length;
		const resolvedHeaderRows = headerRows ?? (this.#contextExpanded ? this.#wrapLines(this.#content.headerLines, innerWidth).length : 0);
		const resolvedFooterRows = footerRows ?? 2;
		const headerSectionRows = this.#contextExpanded ? resolvedHeaderRows + 1 : 0;
		return Math.max(
			MIN_BODY_HEIGHT,
			maxHeight - resolvedTitleRows - resolvedMetadataRows - 1 - headerSectionRows - resolvedFooterRows - 3,
		);
	}

	#transcriptViewportHeight(width: number): number {
		return this.#bodyHeight(width);
	}

	#maxScrollOffset(width: number): number {
		const innerWidth = Math.max(1, Math.max(MIN_WIDTH, width) - 2);
		const { bodyWidth } = this.#sidebarLayout(innerWidth);
		const bodyRows = this.#bodyRows(bodyWidth);
		return Math.max(0, bodyRows.length - this.#transcriptViewportHeight(width));
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

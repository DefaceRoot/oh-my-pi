import { type Component, matchesKey, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { theme } from "../theme/theme";

const MIN_WIDTH = 40;
const MIN_BODY_HEIGHT = 4;

export interface SubagentSessionViewerContent {
	headerLines: string[];
	bodyLines: string[];
	nestedArrowMode: boolean;
}

export interface SubagentSessionViewerOptions {
	getTerminalRows: () => number;
	leaderKey: string;
	onClose: () => void;
	onNavigateRoot: (direction: 1 | -1) => void;
	onNavigateNested: (direction: 1 | -1) => void;
	onCycleAgentMode: () => void;
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
		const headerRows = this.#wrapLines(this.#content.headerLines, innerWidth);
		const bodyRows = this.#wrapLines(this.#content.bodyLines, innerWidth);
		const footerRows = this.#wrapLines(this.#footerLines(bodyRows.length), innerWidth);
		const bodyHeight = this.#bodyHeight(this.#lastRenderWidth, headerRows.length, footerRows.length);
		const maxOffset = Math.max(0, bodyRows.length - bodyHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxOffset));
		const visibleBodyRows = bodyRows.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight);
		while (visibleBodyRows.length < bodyHeight) {
			visibleBodyRows.push("");
		}

		const lines: string[] = [this.#frameTop(innerWidth)];
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

	#footerLines(totalBodyRows: number): string[] {
		const bodyHeight = this.#bodyHeight(this.#lastRenderWidth);
		const maxOffset = Math.max(0, totalBodyRows - bodyHeight);
		const start = totalBodyRows === 0 ? 0 : Math.min(totalBodyRows, this.#scrollOffset + 1);
		const end = Math.min(totalBodyRows, this.#scrollOffset + bodyHeight);
		const navMode = this.#content.nestedArrowMode ? "Up/Down nested" : "Up/Down task";
		const status = theme.fg("dim", ` lines ${start}-${end}/${totalBodyRows} `);
		const controls = theme.fg(
			"dim",
			`${this.#leaderKey} toggle  ${navMode}  Left/Right task  Tab nested  PgUp/PgDn scroll  Home/End jump  Esc exit  A mode`,
		);
		const pinned = maxOffset === 0 || this.#scrollOffset >= maxOffset ? theme.fg("success", " newest") : "";
		return [status + pinned, controls];
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

	#bodyHeight(width: number, headerRows?: number): number {
		const maxHeight = Math.max(12, Math.floor(this.#getTerminalRows() * 0.82));
		const innerWidth = Math.max(1, Math.max(MIN_WIDTH, width) - 2);
		const resolvedHeaderRows = headerRows ?? this.#wrapLines(this.#content.headerLines, innerWidth).length;
		const footerRows = 2;
		return Math.max(MIN_BODY_HEIGHT, maxHeight - resolvedHeaderRows - footerRows - 4);
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
		return `${theme.boxSharp.topLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.topRight}`;
	}

	#frameSeparator(innerWidth: number): string {
		return `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.teeLeft}`;
	}

	#frameBottom(innerWidth: number): string {
		return `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.bottomRight}`;
	}

	#frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.vertical}${truncated}${padding(remaining)}${theme.boxSharp.vertical}`;
	}
}

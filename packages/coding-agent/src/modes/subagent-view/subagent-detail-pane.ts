import { Container, Text } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import type { SubagentStatus, SubagentViewRef } from "./types";

const STATUS_GLYPHS: Record<SubagentStatus, { glyph: string; color: "success" | "muted" | "error" | "dim" }> = {
	running: { glyph: "●", color: "success" },
	completed: { glyph: "◉", color: "muted" },
	failed: { glyph: "✗", color: "error" },
	pending: { glyph: "◌", color: "dim" },
	cancelled: { glyph: "⊘", color: "muted" },
};

const GAUGE_WIDTH = 16;
const ASSIGNMENT_MAX_LINES = 8;

/**
 * SubagentDetailPane renders the metadata detail sections for a selected subagent.
 *
 * Sections:
 *  1. Identity — agent name (bold accent), role/type, description
 *  2. Model — model name, thinking level
 *  3. Token gauge — ASCII progress bar + raw numbers
 *  4. Timing — elapsed duration, age, started time
 *  5. Session context — session ID, parent agent, depth
 *  6. Assignment preview — first 5-8 lines, separated by border
 */
export class SubagentDetailPane extends Container {
	#ref: SubagentViewRef | undefined;
	#scrollOffset = 0;
	#lastAvailableHeight = 0;
	#renderedLineCount = 0;

	constructor(ref?: SubagentViewRef) {
		super();
		this.#ref = ref;
		this.#rebuild();
	}

	setRef(ref: SubagentViewRef | undefined): void {
		this.#ref = ref;
		this.#scrollOffset = 0;
		this.#rebuild();
	}

	scrollBy(delta: number): void {
		if (this.#renderedLineCount <= this.#lastAvailableHeight) return;
		const max = Math.max(0, this.#renderedLineCount - this.#lastAvailableHeight);
		this.#scrollOffset = Math.max(0, Math.min(max, this.#scrollOffset + delta));
	}

	render(width: number): string[] {
		const allLines = super.render(width);
		this.#renderedLineCount = allLines.length;

		if (this.#lastAvailableHeight > 0 && allLines.length > this.#lastAvailableHeight) {
			return allLines.slice(this.#scrollOffset, this.#scrollOffset + this.#lastAvailableHeight);
		}
		return allLines;
	}

	setAvailableHeight(height: number): void {
		this.#lastAvailableHeight = height;
	}

	#rebuild(): void {
		this.clear();
		const ref = this.#ref;
		if (!ref) {
			this.addChild(new Text(theme.fg("dim", "No agent selected"), 1, 0));
			return;
		}

		this.#addIdentitySection(ref);
		this.#addModelSection(ref);
		this.#addTokenGaugeSection(ref);
		this.#addTimingSection(ref);
		this.#addSessionContextSection(ref);
		this.#addAssignmentSection(ref);
	}

	#addIdentitySection(ref: SubagentViewRef): void {
		const name = ref.agent ?? ref.id;
		this.addChild(new Text(theme.bold(theme.fg("accent", `Agent: ${name}`)), 1, 0));

		if (ref.agent && ref.agent !== ref.id) {
			this.addChild(new Text(theme.fg("dim", `  ID: ${ref.id}`), 1, 0));
		}

		if (ref.status) {
			const entry = STATUS_GLYPHS[ref.status];
			const statusText = `${entry.glyph} ${ref.status.toUpperCase()}`;
			this.addChild(new Text(`  ${theme.fg("text", "Status:")} ${theme.fg(entry.color, statusText)}`, 1, 0));
		}

		if (ref.description) {
			this.addChild(new Text(`  ${theme.fg("dim", ref.description)}`, 1, 0));
		}
		this.addChild(new Text("", 1, 0));
	}

	#addModelSection(ref: SubagentViewRef): void {
		if (!ref.model && !ref.thinkingLevel) return;

		this.addChild(new Text(theme.bold("Model"), 1, 0));
		if (ref.model) {
			this.addChild(new Text(`  ${theme.fg("text", ref.model)}`, 1, 0));
		}
		if (ref.thinkingLevel) {
			this.addChild(new Text(`  ${theme.fg("dim", `Thinking: ${ref.thinkingLevel}`)}`, 1, 0));
		}
		this.addChild(new Text("", 1, 0));
	}

	#addTokenGaugeSection(ref: SubagentViewRef): void {
		if (ref.tokens === undefined) return;

		this.addChild(new Text(theme.bold("Tokens"), 1, 0));

		const gauge = buildTokenGauge(ref.tokens, ref.tokenCapacity);
		this.addChild(new Text(`  ${gauge}`, 1, 0));
		this.addChild(new Text("", 1, 0));
	}

	#addTimingSection(ref: SubagentViewRef): void {
		if (ref.elapsedMs === undefined && ref.startedAt === undefined && ref.lastUpdatedMs === undefined) return;

		this.addChild(new Text(theme.bold("Timing"), 1, 0));

		if (ref.elapsedMs !== undefined) {
			this.addChild(new Text(`  ${theme.fg("text", "Elapsed:")} ${formatDuration(ref.elapsedMs)}`, 1, 0));
		}
		if (ref.startedAt !== undefined) {
			this.addChild(new Text(`  ${theme.fg("text", "Started:")} ${formatTimestamp(ref.startedAt)}`, 1, 0));
		}
		if (ref.lastUpdatedMs !== undefined) {
			this.addChild(new Text(`  ${theme.fg("text", "Age:")} ${formatAge(ref.lastUpdatedMs)}`, 1, 0));
		}
		this.addChild(new Text("", 1, 0));
	}

	#addSessionContextSection(ref: SubagentViewRef): void {
		if (!ref.sessionId && !ref.parentAgentName && ref.depth === undefined) return;

		this.addChild(new Text(theme.bold("Session"), 1, 0));

		if (ref.sessionId) {
			const displayId = ref.sessionId.length > 16 ? `${ref.sessionId.slice(0, 16)}...` : ref.sessionId;
			this.addChild(new Text(`  ${theme.fg("text", "ID:")} ${theme.fg("dim", displayId)}`, 1, 0));
		}
		if (ref.parentAgentName) {
			this.addChild(new Text(`  ${theme.fg("text", "Parent:")} ${theme.fg("dim", ref.parentAgentName)}`, 1, 0));
		}
		if (ref.depth !== undefined) {
			this.addChild(new Text(`  ${theme.fg("text", "Depth:")} ${theme.fg("dim", String(ref.depth))}`, 1, 0));
		}
		this.addChild(new Text("", 1, 0));
	}

	#addAssignmentSection(ref: SubagentViewRef): void {
		if (!ref.assignmentPreview) return;

		const border = theme.fg("border", `── Assignment ${theme.boxSharp.horizontal.repeat(20)}`);
		this.addChild(new Text(border, 1, 0));

		const lines = ref.assignmentPreview.split("\n").slice(0, ASSIGNMENT_MAX_LINES);
		for (const line of lines) {
			this.addChild(new Text(`  ${theme.fg("dim", line)}`, 1, 0));
		}
	}
}

/**
 * Builds an ASCII token gauge: ████████░░░░░░░░ 12,450 / 200,000
 */
export function buildTokenGauge(tokens: number, capacity: number | undefined): string {
	const formatted = formatTokenCount(tokens);

	if (capacity === undefined || capacity <= 0) {
		return `${theme.fg("text", formatted)}`;
	}

	const ratio = Math.min(1, Math.max(0, tokens / capacity));
	const filled = Math.round(ratio * GAUGE_WIDTH);
	const empty = GAUGE_WIDTH - filled;

	const bar = theme.fg("accent", "█".repeat(filled)) + theme.fg("muted", "░".repeat(empty));

	const pct = `${(ratio * 100).toFixed(1)}%`;
	const capacityFormatted = formatTokenCount(capacity);

	return `${bar} ${pct}  ${theme.fg("text", `${formatted} / ${capacityFormatted}`)}`;
}

function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAge(lastUpdatedMs: number): string {
	if (!Number.isFinite(lastUpdatedMs) || lastUpdatedMs <= 0) return "---";
	const diff = Math.max(0, Date.now() - lastUpdatedMs);
	if (diff < 5000) return "now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	return `${Math.floor(diff / 3_600_000)}h ago`;
}

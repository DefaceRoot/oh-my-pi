import { Container, Text } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import type { SubagentStatus, SubagentViewRef } from "./types";

/** A delegation field value that can be copied to clipboard. */
export interface CopyableField {
	label: string;
	value: string;
}

/** Action returned from detail pane input handling. */
export type DetailPaneAction =
	| { type: "copy"; label: string; value: string }
	| { type: "toggle-verbose"; visible: boolean };

const STATUS_GLYPHS: Record<SubagentStatus, { glyph: string; color: "success" | "muted" | "error" | "dim" }> = {
	running: { glyph: "●", color: "success" },
	completed: { glyph: "◉", color: "muted" },
	failed: { glyph: "✗", color: "error" },
	pending: { glyph: "◌", color: "dim" },
	cancelled: { glyph: "⊘", color: "muted" },
	user_stopped: { glyph: "⏹", color: "error" },
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
 *  6. Delegation — task metadata from sidecar (when populated)
 *  7. Assignment preview — first 5-8 lines, separated by border
 */
export class SubagentDetailPane extends Container {
	#ref: SubagentViewRef | undefined;
	#scrollOffset = 0;
	#lastAvailableHeight = 0;
	#renderedLineCount = 0;
	#copyableFields: CopyableField[] = [];
	#copyFieldIndex = -1;
	#verboseMode = true;

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

	/**
	 * Handle delegation-field interactions.
	 *
	 * - `c` / `y`: cycle-copy the next copiable delegation field value
	 * - `d`: toggle verbose delegation details (envelope IDs, profile, repo, worktree)
	 *
	 * @returns Action describing what happened, or undefined if key was not handled.
	 */
	handleInput(keyData: string): DetailPaneAction | undefined {
		if ((keyData === "c" || keyData === "y") && this.#copyableFields.length > 0) {
			this.#copyFieldIndex = (this.#copyFieldIndex + 1) % this.#copyableFields.length;
			const field = this.#copyableFields[this.#copyFieldIndex]!;
			return { type: "copy", label: field.label, value: field.value };
		}
		if (keyData === "d" && this.#ref && this.#hasDelegationFields(this.#ref)) {
			this.#verboseMode = !this.#verboseMode;
			this.#rebuild();
			return { type: "toggle-verbose", visible: this.#verboseMode };
		}
		return undefined;
	}

	/** Copiable delegation field entries for the current ref. */
	getCopyableFields(): readonly CopyableField[] {
		return this.#copyableFields;
	}

	/** Whether verbose delegation details are shown. */
	getVerboseMode(): boolean {
		return this.#verboseMode;
	}

	/** Set verbose delegation detail visibility. */
	setVerboseMode(visible: boolean): void {
		if (this.#verboseMode === visible) return;
		this.#verboseMode = visible;
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		this.#copyableFields = [];
		this.#copyFieldIndex = -1;
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
		this.#addDelegationSection(ref);
		this.#addAnomalyIndicators(ref);
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
		if (
			!ref.sessionId &&
			!ref.parentSessionId &&
			!ref.parentAgentName &&
			ref.depth === undefined &&
			!ref.mcpServers?.length
		)
			return;

		this.addChild(new Text(theme.bold("Session"), 1, 0));

		if (ref.sessionId) {
			const displayId = ref.sessionId.length > 16 ? `${ref.sessionId.slice(0, 16)}...` : ref.sessionId;
			this.addChild(new Text(`  ${theme.fg("text", "ID:")} ${theme.fg("dim", displayId)}`, 1, 0));
		}
		if (ref.parentSessionId) {
			this.addChild(
				new Text(`  ${theme.fg("text", "Parent Session:")} ${theme.fg("dim", ref.parentSessionId)}`, 1, 0),
			);
		}
		if (ref.parentAgentName) {
			this.addChild(new Text(`  ${theme.fg("text", "Parent:")} ${theme.fg("dim", ref.parentAgentName)}`, 1, 0));
		}
		if (ref.depth !== undefined) {
			this.addChild(new Text(`  ${theme.fg("text", "Depth:")} ${theme.fg("dim", String(ref.depth))}`, 1, 0));
		}
		if (ref.mcpServers?.length) {
			this.addChild(new Text(`  ${theme.fg("text", "MCP:")} ${theme.fg("dim", ref.mcpServers.join(", "))}`, 1, 0));
		}
		this.addChild(new Text("", 1, 0));
	}

	#hasDelegationFields(ref: SubagentViewRef): boolean {
		return !!(
			ref.taskTitle ||
			ref.taskId ||
			ref.taskIntent ||
			ref.delegatorRole ||
			ref.delegateRole ||
			ref.inputProfile ||
			ref.planPath ||
			ref.repoRoot ||
			ref.branch ||
			ref.worktreePath ||
			ref.envelopeId ||
			ref.parentEnvelopeId ||
			ref.retryAttempt !== undefined ||
			(ref.qualityWarnings?.length ?? 0) > 0 ||
			(ref.qualityErrors?.length ?? 0) > 0
		);
	}

	#addDelegationSection(ref: SubagentViewRef): void {
		if (!this.#hasDelegationFields(ref)) return;

		const border = theme.fg("border", `\u2500\u2500 Delegation ${theme.boxSharp.horizontal.repeat(20)}`);
		this.addChild(new Text(border, 1, 0));

		// Task title (primary heading)
		if (ref.taskTitle) {
			this.addChild(
				new Text(`  ${theme.fg("text", "Task:")} ${theme.bold(theme.fg("accent", ref.taskTitle))}`, 1, 0),
			);
		}
		// Task ID (subordinate, 4-space indent)
		if (ref.taskId) {
			this.addChild(new Text(`    ${theme.fg("text", "ID:")} ${theme.fg("dim", ref.taskId)}`, 1, 0));
			this.#pushCopyable("Task ID", ref.taskId);
		}
		// Intent (italic when present)
		if (ref.taskIntent) {
			this.addChild(
				new Text(`  ${theme.fg("text", "Intent:")} ${theme.italic(theme.fg("dim", ref.taskIntent))}`, 1, 0),
			);
		}
		// Delegation roles: From -> To (only when both roles are present)
		if (ref.delegatorRole && ref.delegateRole) {
			this.addChild(
				new Text(
					`  ${theme.fg("text", "From")} ${theme.fg("dim", "->")} ${theme.fg("text", "To:")} ${theme.fg("text", ref.delegatorRole)} ${theme.fg("dim", "->")} ${theme.fg("text", ref.delegateRole)}`,
					1,
					0,
				),
			);
		} else if (ref.delegatorRole) {
			this.addChild(new Text(`  ${theme.fg("text", "From:")} ${theme.fg("text", ref.delegatorRole)}`, 1, 0));
		} else if (ref.delegateRole) {
			this.addChild(new Text(`  ${theme.fg("text", "To:")} ${theme.fg("text", ref.delegateRole)}`, 1, 0));
		}
		// Input profile (verbose)
		if (ref.inputProfile && this.#verboseMode) {
			this.addChild(new Text(`  ${theme.fg("text", "Profile:")} ${theme.fg("dim", ref.inputProfile)}`, 1, 0));
		}
		// Plan path
		if (ref.planPath) {
			this.addChild(new Text(`  ${theme.fg("text", "Plan:")} ${theme.fg("accent", ref.planPath)}`, 1, 0));
			this.#pushCopyable("Plan", ref.planPath);
		} else {
			this.addChild(new Text(`  ${theme.fg("text", "Plan:")} ${theme.fg("dim", "No plan")}`, 1, 0));
		}
		// Repo root (verbose)
		if (ref.repoRoot && this.#verboseMode) {
			this.addChild(new Text(`  ${theme.fg("text", "Repo:")} ${theme.fg("text", ref.repoRoot)}`, 1, 0));
			this.#pushCopyable("Repo", ref.repoRoot);
		}
		// Branch
		if (ref.branch) {
			this.addChild(new Text(`  ${theme.fg("text", "Branch:")} ${theme.fg("text", ref.branch)}`, 1, 0));
			this.#pushCopyable("Branch", ref.branch);
		}
		// Worktree (verbose, omit row entirely when undefined)
		if (ref.worktreePath && this.#verboseMode) {
			this.addChild(new Text(`  ${theme.fg("text", "Worktree:")} ${theme.fg("text", ref.worktreePath)}`, 1, 0));
			this.#pushCopyable("Worktree", ref.worktreePath);
		}
		// Envelope ID (verbose)
		if (ref.envelopeId && this.#verboseMode) {
			this.addChild(new Text(`  ${theme.fg("text", "Envelope:")} ${theme.fg("dim", ref.envelopeId)}`, 1, 0));
			this.#pushCopyable("Envelope", ref.envelopeId);
		}
		// Parent envelope ID (verbose, omit row entirely when undefined)
		if (ref.parentEnvelopeId && this.#verboseMode) {
			this.addChild(new Text(`  ${theme.fg("text", "Parent:")} ${theme.fg("dim", ref.parentEnvelopeId)}`, 1, 0));
			this.#pushCopyable("Parent Envelope", ref.parentEnvelopeId);
		}
		// Retry attempt (omit row entirely when undefined)
		if (ref.retryAttempt !== undefined) {
			this.addChild(
				new Text(`  ${theme.fg("text", "Retry:")} ${theme.fg("warning", `Attempt ${ref.retryAttempt}`)}`, 1, 0),
			);
		}
		// Quality indicator
		this.#addQualityIndicator(ref);

		// Cost attribution (within delegation context)
		this.#addCostAttribution(ref);

		// Help text for delegation-field interactions
		const hints: string[] = [];
		if (this.#copyableFields.length > 0) {
			hints.push(`${theme.fg("dim", "c/y")} ${theme.fg("muted", "copy field")}`);
		}
		hints.push(`${theme.fg("dim", "d")} ${theme.fg("muted", this.#verboseMode ? "compact" : "details")}`);
		this.addChild(new Text(`  ${hints.join("  ")}`, 1, 0));

		this.addChild(new Text("", 1, 0));
	}

	#pushCopyable(label: string, value: string): void {
		this.#copyableFields.push({ label, value });
	}

	#addQualityIndicator(ref: SubagentViewRef): void {
		const errorCount = ref.qualityErrors?.length ?? 0;
		const warningCount = ref.qualityWarnings?.length ?? 0;

		if (errorCount === 0 && warningCount === 0) {
			// Only show clean indicator when delegation fields are populated
			if (this.#hasDelegationFields(ref)) {
				this.addChild(new Text(`  ${theme.fg("text", "Quality:")} ${theme.fg("success", "\u25CF clean")}`, 1, 0));
			}
			return;
		}

		if (errorCount > 0) {
			const errorText = `${errorCount} error${errorCount !== 1 ? "s" : ""}`;
			const warnText = warningCount > 0 ? `, ${warningCount} warning${warningCount !== 1 ? "s" : ""}` : "";
			this.addChild(
				new Text(`  ${theme.fg("text", "Quality:")} ${theme.fg("error", `\u2717 ${errorText}${warnText}`)}`, 1, 0),
			);
		} else {
			const warnText = `${warningCount} warning${warningCount !== 1 ? "s" : ""}`;
			this.addChild(
				new Text(`  ${theme.fg("text", "Quality:")} ${theme.fg("warning", `\u25B2 ${warnText}`)}`, 1, 0),
			);
		}
	}

	#addCostAttribution(ref: SubagentViewRef): void {
		const hasTokenBreakdown = ref.inputTokens !== undefined || ref.outputTokens !== undefined;
		const hasCost = ref.costUsd !== undefined && ref.costUsd > 0;

		if (!hasTokenBreakdown && !hasCost) return;

		// Attribution label: tied to task ID when available
		if (ref.taskId) {
			this.addChild(
				new Text(
					`  ${theme.fg("text", "Cost for")} ${theme.fg("accent", ref.taskId)}${theme.fg("text", ":")}`,
					1,
					0,
				),
			);
		} else {
			this.addChild(new Text(`  ${theme.fg("text", "Cost:")}`, 1, 0));
		}

		// Cost in USD
		if (hasCost) {
			this.addChild(new Text(`    ${theme.fg("text", "$")}${theme.fg("text", formatCostUsd(ref.costUsd!))}`, 1, 0));
		}

		// Token breakdown (verbose)
		if (hasTokenBreakdown && this.#verboseMode) {
			const parts: string[] = [];
			if (ref.inputTokens !== undefined) parts.push(`in:${formatTokenCount(ref.inputTokens)}`);
			if (ref.outputTokens !== undefined) parts.push(`out:${formatTokenCount(ref.outputTokens)}`);
			if (ref.cacheReadTokens !== undefined && ref.cacheReadTokens > 0)
				parts.push(`cache-r:${formatTokenCount(ref.cacheReadTokens)}`);
			if (ref.cacheWriteTokens !== undefined && ref.cacheWriteTokens > 0)
				parts.push(`cache-w:${formatTokenCount(ref.cacheWriteTokens)}`);
			if (parts.length > 0) {
				this.addChild(new Text(`    ${theme.fg("dim", parts.join(" · "))}`, 1, 0));
			}
		}
	}

	#addAnomalyIndicators(ref: SubagentViewRef): void {
		const anomalies = detectAttributionAnomalies(ref);
		if (anomalies.length === 0) return;

		for (const anomaly of anomalies) {
			const color = anomaly.severity === "error" ? "error" : "warning";
			const glyph = anomaly.severity === "error" ? "\u2717" : "\u25B2";
			this.addChild(new Text(`  ${theme.fg(color, `${glyph} ${anomaly.message}`)}`, 1, 0));
		}
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

/** High usage threshold — tokens exceeding this fraction of capacity trigger a warning. */
const HIGH_USAGE_THRESHOLD = 0.9;

export interface AttributionAnomaly {
	severity: "warning" | "error";
	message: string;
}

/**
 * Detect cost/token attribution anomalies for a subagent view ref.
 * Anomalies surface when:
 *  - Delegation exists but token data is absent (attribution gap)
 *  - Tokens/cost exist but no delegation task ID (unattributed cost)
 *  - Completed/failed agent has zero tokens (suspicious tracking)
 *  - Token usage exceeds 90% of capacity (potential overrun)
 */
export function detectAttributionAnomalies(ref: SubagentViewRef): AttributionAnomaly[] {
	const anomalies: AttributionAnomaly[] = [];
	const hasDelegation = !!ref.taskId;
	const hasTokens = ref.tokens !== undefined && ref.tokens > 0;
	const hasCost = ref.costUsd !== undefined && ref.costUsd > 0;
	const isTerminal = ref.status === "completed" || ref.status === "failed";

	// Delegation present but no token data on a terminal agent
	// (tokens: 0 is handled separately as a zero-token tracking gap)
	if (hasDelegation && ref.tokens === undefined && isTerminal) {
		anomalies.push({
			severity: "warning",
			message: "No token data for attributed delegation",
		});
	}

	// Token/cost data present but no delegation task ID to attribute to
	if ((hasTokens || hasCost) && !hasDelegation) {
		anomalies.push({
			severity: "warning",
			message: "Unattributed cost — no delegation task ID",
		});
	}

	// Completed agent shows zero tokens — possible tracking failure
	if (hasDelegation && isTerminal && ref.tokens === 0) {
		anomalies.push({
			severity: "error",
			message: "Zero tokens on completed delegation — tracking gap",
		});
	}

	// High token usage relative to capacity
	if (
		hasTokens &&
		ref.tokenCapacity !== undefined &&
		ref.tokenCapacity > 0 &&
		ref.tokens! / ref.tokenCapacity > HIGH_USAGE_THRESHOLD
	) {
		const pct = ((ref.tokens! / ref.tokenCapacity) * 100).toFixed(0);
		anomalies.push({
			severity: "warning",
			message: `High token usage (${pct}% of capacity)`,
		});
	}

	return anomalies;
}

function formatCostUsd(cost: number): string {
	if (cost < 0.01) return cost.toFixed(4);
	if (cost < 1) return cost.toFixed(3);
	return cost.toFixed(2);
}

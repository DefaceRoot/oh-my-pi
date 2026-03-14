/**
 * Visual Diff Viewer for Documentation Comparison
 *
 * Provides side-by-side comparison of documentation between versions
 * with support for multiple output formats (terminal, HTML, JSON).
 */

import { existsSync, readFileSync } from "fs";
import { basename } from "path";

/** Maximum file size (lines) to prevent O(n*m) memory exhaustion */
const MAX_LINES = 10000;

/** ANSI escape code pattern */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI escape codes from a string for accurate width calculation
 */
function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Get visible string width (excluding ANSI codes)
 */
function getStringWidth(text: string): number {
	return stripAnsi(text).length;
}

/**
 * Pad a string to a specified width, ignoring ANSI codes
 */
function padEndAnsiAware(text: string, width: number): string {
	const visibleWidth = getStringWidth(text);
	if (visibleWidth >= width) {
		return text;
	}
	return text + " ".repeat(width - visibleWidth);
}

/**
 * Represents a single diff change
 */
export interface DiffChange {
	/** Type of change */
	type: "added" | "removed" | "unchanged";
	/** Line number in old version */
	oldLine?: number;
	/** Line number in new version */
	newLine?: number;
	/** Content from old version */
	oldContent?: string;
	/** Content from new version */
	newContent?: string;
}

/**
 * Represents a complete diff result
 */
export interface DiffResult {
	/** File being compared */
	file: string;
	/** Array of changes */
	changes: DiffChange[];
	/** Summary statistics */
	summary: {
		added: number;
		removed: number;
		unchanged: number;
	};
}

/**
 * Configuration for diff generation
 */
export interface DiffGeneratorOptions {
	/** Number of context lines around changes */
	contextLines?: number;
	/** Output format */
	outputFormat?: "terminal" | "html" | "json";
	/** Whether to show unchanged lines */
	showUnchanged?: boolean;
	/** Line width for terminal output */
	terminalWidth?: number;
}

/**
 * Visual Diff Generator for Documentation
 */
export class DiffGenerator {
	private options: Required<DiffGeneratorOptions>;

	constructor(options: DiffGeneratorOptions = {}) {
		this.options = {
			contextLines: options.contextLines ?? 3,
			outputFormat: options.outputFormat ?? "terminal",
			showUnchanged: options.showUnchanged ?? true,
			terminalWidth: options.terminalWidth ?? 120,
		};
	}

	/**
	 * Compare two text files and generate diff
	 */
	compareFiles(oldFile: string, newFile: string): DiffResult {
		const oldContent = existsSync(oldFile) ? readFileSync(oldFile, "utf-8") : "";
		const newContent = existsSync(newFile) ? readFileSync(newFile, "utf-8") : "";

		const changes = this.computeDiff(oldContent, newContent);

		return {
			file: basename(newFile),
			changes,
			summary: this.computeSummary(changes),
		};
	}

	/**
	 * Compute diff between two text contents using line-by-line comparison
	 */
	private computeDiff(oldContent: string, newContent: string): DiffChange[] {
		const oldLines = oldContent.split("\n");
		const newLines = newContent.split("\n");

		// Enforce file size limits
		if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
			throw new Error(
				`File too large for diff (max ${MAX_LINES} lines). ` +
					`Old: ${oldLines.length}, New: ${newLines.length}`
			);
		}

		const changes: DiffChange[] = [];

		// Use Longest Common Subsequence (LCS) algorithm for better diff
		const lcs = this.computeLCS(oldLines, newLines);

		let oldIdx = 0;
		let newIdx = 0;
		let i = 0;

		while (i < lcs.length || oldIdx < oldLines.length || newIdx < newLines.length) {
			const lcsMatch = i < lcs.length ? lcs[i] : null;

			// Check if current positions match the LCS
			if (
				lcsMatch &&
				oldIdx === lcsMatch.oldIdx &&
				newIdx === lcsMatch.newIdx
			) {
				// Line unchanged
				if (this.options.showUnchanged) {
					changes.push({
						type: "unchanged",
						oldLine: oldIdx + 1,
						newLine: newIdx + 1,
						oldContent: oldLines[oldIdx],
						newContent: newLines[newIdx],
					});
				}
				oldIdx++;
				newIdx++;
				i++;
			} else if (
				lcsMatch &&
				newIdx === lcsMatch.newIdx &&
				oldIdx < lcsMatch.oldIdx
			) {
				// Line(s) removed before reaching next LCS match
				changes.push({
					type: "removed",
					oldLine: oldIdx + 1,
					oldContent: oldLines[oldIdx],
				});
				oldIdx++;
			} else if (
				lcsMatch &&
				oldIdx === lcsMatch.oldIdx &&
				newIdx < lcsMatch.newIdx
			) {
				// Line(s) added before reaching next LCS match
				changes.push({
					type: "added",
					newLine: newIdx + 1,
					newContent: newLines[newIdx],
				});
				newIdx++;
			} else if (!lcsMatch) {
				// No more LCS matches, remaining lines are additions/removals
				if (oldIdx < oldLines.length) {
					changes.push({
						type: "removed",
						oldLine: oldIdx + 1,
						oldContent: oldLines[oldIdx],
					});
					oldIdx++;
				} else if (newIdx < newLines.length) {
					changes.push({
						type: "added",
						newLine: newIdx + 1,
						newContent: newLines[newIdx],
					});
					newIdx++;
				} else {
					break;
				}
			} else {
				// Fallback: advance the pointer that's behind
				if (oldIdx < lcsMatch.oldIdx) {
					changes.push({
						type: "removed",
						oldLine: oldIdx + 1,
						oldContent: oldLines[oldIdx],
					});
					oldIdx++;
				} else if (newIdx < lcsMatch.newIdx) {
					changes.push({
						type: "added",
						newLine: newIdx + 1,
						newContent: newLines[newIdx],
					});
					newIdx++;
				} else {
					// Shouldn't reach here, but advance both to prevent infinite loop
					oldIdx++;
					newIdx++;
					i++;
				}
			}
		}

		return this.addContext(changes);
	}

	/**
	 * Compute Longest Common Subsequence for diff algorithm
	 * Returns matches with position indices for proper alignment
	 */
	private computeLCS(
		oldLines: string[],
		newLines: string[]
	): Array<{ oldIdx: number; newIdx: number; content: string }> {
		const m = oldLines.length;
		const n = newLines.length;
		const dp: number[][] = Array(m + 1)
			.fill(null)
			.map(() => Array(n + 1).fill(0));

		// Build DP table
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (oldLines[i - 1] === newLines[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		// Backtrack to find LCS with positions
		const lcs: Array<{ oldIdx: number; newIdx: number; content: string }> =
			[];
		let i = m,
			j = n;
		while (i > 0 && j > 0) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				lcs.unshift({ oldIdx: i - 1, newIdx: j - 1, content: oldLines[i - 1] });
				i--;
				j--;
			} else if (dp[i - 1][j] > dp[i][j - 1]) {
				i--;
			} else {
				j--;
			}
		}

		return lcs;
	}

	/**
	 * Add context lines around changes
	 */
	private addContext(changes: DiffChange[]): DiffChange[] {
		const result: DiffChange[] = [];
		const context = this.options.contextLines;

		// When contextLines is 0, return only non-unchanged changes
		if (context === 0) {
			return changes.filter((c) => c.type !== "unchanged");
		}

		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];

			if (change.type !== "unchanged") {
				// Add context before
				const start = Math.max(0, i - context);
				for (let j = start; j < i; j++) {
					if (
						changes[j].type === "unchanged" &&
						!result.some((r) => r.oldLine === changes[j].oldLine)
					) {
						result.push(changes[j]);
					}
				}

				// Add the change
				result.push(change);

				// Add context after
				const end = Math.min(changes.length, i + context + 1);
				for (let j = i + 1; j < end; j++) {
					if (
						changes[j].type === "unchanged" &&
						!result.some((r) => r.oldLine === changes[j].oldLine)
					) {
						result.push(changes[j]);
					}
				}
			}
		}

		// If no changes found and showUnchanged is true, show all
		if (result.length === 0 && this.options.showUnchanged) {
			return changes;
		}

		return result;
	}

	/**
	 * Compute summary statistics
	 */
	private computeSummary(changes: DiffChange[]): DiffResult["summary"] {
		return {
			added: changes.filter((c) => c.type === "added").length,
			removed: changes.filter((c) => c.type === "removed").length,
			unchanged: changes.filter((c) => c.type === "unchanged").length,
		};
	}

	/**
	 * Generate formatted diff output
	 */
	generateOutput(diffResult: DiffResult): string {
		switch (this.options.outputFormat) {
			case "terminal":
				return this.formatTerminal(diffResult);
			case "html":
				return this.formatHTML(diffResult);
			case "json":
				return JSON.stringify(diffResult, null, 2);
			default:
				return this.formatTerminal(diffResult);
		}
	}

	/**
	 * Truncate text to fit within width, preserving ANSI codes
	 */
	private truncateText(text: string, maxWidth: number): string {
		// If text fits without truncation, return as-is
		if (getStringWidth(text) <= maxWidth) {
			return text;
		}

		// Find where to truncate (leave room for "...")
		const targetWidth = maxWidth - 3;
		let visibleChars = 0;
		let result = "";
		let inAnsi = false;

		for (let i = 0; i < text.length && visibleChars < targetWidth; i++) {
			if (text[i] === "\x1b") {
				inAnsi = true;
			}

			if (inAnsi) {
				result += text[i];
				if (text[i] === "m") {
					inAnsi = false;
				}
			} else {
				result += text[i];
				visibleChars++;
			}
		}

		return result + "...";
	}

	/**
	 * Format diff for terminal output with side-by-side view
	 */
	private formatTerminal(diffResult: DiffResult): string {
		const width = this.options.terminalWidth;
		const halfWidth = Math.floor((width - 5) / 2);
		const output: string[] = [];

		// Header
		output.push("═".repeat(width));
		output.push(`Diff: ${diffResult.file}`);
		output.push("═".repeat(width));

		// Summary
		const s = diffResult.summary;
		output.push(`Summary: +${s.added} -${s.removed} =${s.unchanged}`);
		output.push("═".repeat(width));
		output.push("");

		// Column headers
		const oldHeader = "OLD VERSION".padEnd(halfWidth);
		const newHeader = "NEW VERSION".padEnd(halfWidth);
		output.push(`${oldHeader} │ ${newHeader}`);
		output.push(`${"─".repeat(halfWidth)}─┼─${"─".repeat(halfWidth)}`);

		// ANSI color codes
		const resetColor = "\x1b[0m";
		const red = "\x1b[31m";
		const green = "\x1b[32m";
		const grey = "\x1b[90m";

		// Side-by-side comparison
		for (const change of diffResult.changes) {
			const oldLine = change.oldLine !== undefined ? `${change.oldLine}: ` : "";
			const newLine = change.newLine !== undefined ? `${change.newLine}: ` : "";

			let oldText: string;
			let newText: string;

			switch (change.type) {
				case "removed":
					oldText =
						red +
						oldLine +
						this.truncateText(change.oldContent || "", halfWidth - oldLine.length - 1) +
						resetColor;
					newText = "";
					break;
				case "added":
					oldText = "";
					newText =
						green +
						newLine +
						this.truncateText(change.newContent || "", halfWidth - newLine.length - 1) +
						resetColor;
					break;
				case "unchanged":
					oldText =
						grey +
						oldLine +
						this.truncateText(change.oldContent || "", halfWidth - oldLine.length - 1) +
						resetColor;
					newText =
						grey +
						newLine +
						this.truncateText(change.newContent || "", halfWidth - newLine.length - 1) +
						resetColor;
					break;
				default:
					oldText = "";
					newText = "";
			}

			output.push(
				`${padEndAnsiAware(oldText, halfWidth)} │ ${padEndAnsiAware(newText, halfWidth)}`
			);
		}

		output.push("═".repeat(width));

		return output.join("\n");
	}

	/**
	 * Format diff as HTML with side-by-side view
	 */
	private formatHTML(diffResult: DiffResult): string {
		const s = diffResult.summary;

		let html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Documentation Diff: ${this.escapeHTML(diffResult.file)}</title>
	<style>
		body {
			font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
			margin: 0;
			padding: 20px;
			background: #1e1e1e;
			color: #d4d4d4;
		}
		.diff-container {
			max-width: 1400px;
			margin: 0 auto;
			background: #252526;
			border-radius: 8px;
			overflow: hidden;
			box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
		}
		.diff-header {
			background: #333333;
			padding: 16px 20px;
			border-bottom: 1px solid #3c3c3c;
		}
		.diff-title {
			font-size: 18px;
			font-weight: 600;
			margin-bottom: 8px;
		}
		.diff-summary {
			font-size: 13px;
			color: #858585;
		}
		.diff-summary .added { color: #73c991; }
		.diff-summary .removed { color: #f48771; }
		.diff-summary .unchanged { color: #858585; }
		.diff-content {
			display: flex;
			overflow-x: auto;
		}
		.diff-column {
			flex: 1;
			min-width: 400px;
		}
		.diff-column-header {
			background: #2d2d2d;
			padding: 8px 16px;
			font-size: 12px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			border-bottom: 1px solid #3c3c3c;
		}
		.diff-lines {
			font-size: 13px;
			line-height: 1.6;
		}
		.diff-line {
			display: flex;
			padding: 2px 16px;
			border-bottom: 1px solid #2d2d2d;
		}
		.diff-line-number {
			flex: 0 0 40px;
			color: #858585;
			text-align: right;
			padding-right: 16px;
			user-select: none;
		}
		.diff-line-content {
			flex: 1;
			white-space: pre-wrap;
			word-break: break-word;
		}
		.line-removed {
			background: rgba(244, 135, 113, 0.15);
		}
		.line-removed .diff-line-content {
			color: #f48771;
		}
		.line-added {
			background: rgba(115, 201, 145, 0.15);
		}
		.line-added .diff-line-content {
			color: #73c991;
		}
		.line-unchanged {
			background: transparent;
		}
		.line-unchanged .diff-line-content {
			color: #858585;
		}
		.empty-line {
			background: transparent;
		}
	</style>
</head>
<body>
	<div class="diff-container">
		<div class="diff-header">
			<div class="diff-title">${this.escapeHTML(diffResult.file)}</div>
			<div class="diff-summary">
				<span class="added">+${s.added} added</span> •
				<span class="removed">-${s.removed} removed</span> •
				<span class="unchanged">=${s.unchanged} unchanged</span>
			</div>
		</div>
		<div class="diff-content">
			<div class="diff-column">
				<div class="diff-column-header">Old Version</div>
				<div class="diff-lines">
`;

		// Build old version column
		for (const change of diffResult.changes) {
			const lineNum = change.oldLine !== undefined ? change.oldLine : "";
			const content = change.oldContent || "";

			if (change.type === "removed") {
				html += `					<div class="diff-line line-removed">
						<span class="diff-line-number">${lineNum}</span>
						<span class="diff-line-content">${this.escapeHTML(content)}</span>
					</div>
`;
			} else if (change.type === "unchanged" && this.options.showUnchanged) {
				html += `					<div class="diff-line line-unchanged">
						<span class="diff-line-number">${lineNum}</span>
						<span class="diff-line-content">${this.escapeHTML(content)}</span>
					</div>
`;
			} else if (change.type === "added") {
				html += `					<div class="diff-line empty-line">
						<span class="diff-line-number"></span>
						<span class="diff-line-content"></span>
					</div>
`;
			}
		}

		html += `				</div>
			</div>
			<div class="diff-column">
				<div class="diff-column-header">New Version</div>
				<div class="diff-lines">
`;

		// Build new version column
		for (const change of diffResult.changes) {
			const lineNum = change.newLine !== undefined ? change.newLine : "";
			const content = change.newContent || "";

			if (change.type === "added") {
				html += `					<div class="diff-line line-added">
						<span class="diff-line-number">${lineNum}</span>
						<span class="diff-line-content">${this.escapeHTML(content)}</span>
					</div>
`;
			} else if (change.type === "unchanged" && this.options.showUnchanged) {
				html += `					<div class="diff-line line-unchanged">
						<span class="diff-line-number">${lineNum}</span>
						<span class="diff-line-content">${this.escapeHTML(content)}</span>
					</div>
`;
			} else if (change.type === "removed") {
				html += `					<div class="diff-line empty-line">
						<span class="diff-line-number"></span>
						<span class="diff-line-content"></span>
					</div>
`;
			}
		}

		html += `				</div>
			</div>
		</div>
	</div>
</body>
</html>`;

		return html;
	}

	/**
	 * Escape HTML special characters
	 */
	private escapeHTML(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}
}

/**
 * Generate a visual diff between two documentation files
 */
export function generateDiff(
	oldPath: string,
	newPath: string,
	options?: Partial<DiffGeneratorOptions>
): string {
	const generator = new DiffGenerator(options);

	const diffResult = generator.compareFiles(oldPath, newPath);
	return generator.generateOutput(diffResult);
}

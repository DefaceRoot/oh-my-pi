import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cutover absence test for the Ctrl+X subagent viewer redesign (Phase 5, Unit 5.4).
 *
 * Proves that legacy identifiers and deleted file references have been fully
 * removed from the deterministic scan scope and the broader coding-agent tree.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const TEST_ROOT = path.join(REPO_ROOT, "test");

/**
 * Deterministic scan scope: the exact files where legacy identifiers must be absent.
 * These are the files that previously contained sync-scan / polling / old-navigator code.
 */
const DETERMINISTIC_SCOPE = [
	path.join(SRC_ROOT, "modes/interactive-mode.ts"),
	path.join(SRC_ROOT, "modes/controllers/input-controller.ts"),
	path.join(SRC_ROOT, "modes/types.ts"),
	path.join(TEST_ROOT, "subagent-view-lifecycle.test.ts"),
];

/** Collect all .ts files under the subagent-view directory. */
function collectSubagentViewFiles(): string[] {
	const dir = path.join(SRC_ROOT, "modes/subagent-view");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".ts"))
		.map(f => path.join(dir, f));
}

/**
 * Legacy identifiers that must not appear in the deterministic scope.
 * Each entry is a regex pattern and a human-readable label.
 */
const LEGACY_IDENTIFIERS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /collectSubagentViewRefs/, label: "collectSubagentViewRefs" },
	{ pattern: /startSubagentViewRefresh/, label: "startSubagentViewRefresh" },
	{ pattern: /stopSubagentViewRefresh/, label: "stopSubagentViewRefresh" },
	{ pattern: /refreshSubagentView\b/, label: "refreshSubagentView" },
	{ pattern: /subagentViewRefreshInterval/, label: "subagentViewRefreshInterval" },
	{ pattern: /\.scanSync\(/, label: ".scanSync(" },
	{ pattern: /\bstatSync\(/, label: "statSync(" },
	{ pattern: /handleSubagentNavigatorToggle/, label: "handleSubagentNavigatorToggle" },
	{ pattern: /handleSubagentArrowNavigation/, label: "handleSubagentArrowNavigation" },
	{ pattern: /handleSubagentRootNavigation/, label: "handleSubagentRootNavigation" },
	{ pattern: /handleSubagentNestedNavigation/, label: "handleSubagentNestedNavigation" },
	{ pattern: /handleSubagentAgentToggle/, label: "handleSubagentAgentToggle" },
	{ pattern: /\bcycleSubagentView\b/, label: "cycleSubagentView" },
	{ pattern: /cycleSubagentNestedView/, label: "cycleSubagentNestedView" },
	{ pattern: /isSubagentNestedArrowModeEnabled/, label: "isSubagentNestedArrowModeEnabled" },
];

/**
 * Subagent-specific legacy methods that must be absent from the entire source tree.
 * Excludes generic fs calls (statSync/scanSync) that are legitimate outside the
 * subagent-view scope.
 */
const LEGACY_METHODS_REPO_WIDE: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /collectSubagentViewRefs/, label: "collectSubagentViewRefs" },
	{ pattern: /startSubagentViewRefresh/, label: "startSubagentViewRefresh" },
	{ pattern: /stopSubagentViewRefresh/, label: "stopSubagentViewRefresh" },
	{ pattern: /refreshSubagentView\b/, label: "refreshSubagentView" },
	{ pattern: /subagentViewRefreshInterval/, label: "subagentViewRefreshInterval" },
	{ pattern: /handleSubagentNavigatorToggle/, label: "handleSubagentNavigatorToggle" },
	{ pattern: /handleSubagentArrowNavigation/, label: "handleSubagentArrowNavigation" },
	{ pattern: /handleSubagentRootNavigation/, label: "handleSubagentRootNavigation" },
	{ pattern: /handleSubagentNestedNavigation/, label: "handleSubagentNestedNavigation" },
	{ pattern: /handleSubagentAgentToggle/, label: "handleSubagentAgentToggle" },
	{ pattern: /\bcycleSubagentView\b/, label: "cycleSubagentView" },
	{ pattern: /cycleSubagentNestedView/, label: "cycleSubagentNestedView" },
	{ pattern: /isSubagentNestedArrowModeEnabled/, label: "isSubagentNestedArrowModeEnabled" },
];

/**
 * Deleted file path patterns. No import in the entire coding-agent tree
 * should reference the old navigator module.
 */
const DELETED_IMPORT_PATTERN =
	/(?:from|require\()\s*["'](?:@oh-my-pi\/pi-coding-agent\/modes\/subagent-navigator|\.\.?(?:\/[^"']*)*\/subagent-navigator)["']/;

/** Collect all .ts files recursively under a directory. */
function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(full));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			results.push(full);
		}
	}
	return results;
}

function findViolations(
	filePaths: string[],
	patterns: Array<{ pattern: RegExp; label: string }>,
): Array<{ file: string; line: number; label: string; text: string }> {
	const violations: Array<{ file: string; line: number; label: string; text: string }> = [];
	for (const filePath of filePaths) {
		if (!fs.existsSync(filePath)) continue;
		const lines = fs.readFileSync(filePath, "utf-8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			for (const { pattern, label } of patterns) {
				if (pattern.test(line)) {
					violations.push({
						file: path.relative(REPO_ROOT, filePath),
						line: i + 1,
						label,
						text: line.trim(),
					});
				}
			}
		}
	}
	return violations;
}

describe("Subagent cutover absence proof", () => {
	test("deleted file: subagent-navigator.ts no longer exists", () => {
		const deletedPath = path.join(SRC_ROOT, "modes/subagent-navigator.ts");
		expect(fs.existsSync(deletedPath)).toBe(false);
	});

	test("deterministic scope: no legacy identifiers remain", () => {
		const scopeFiles = [...DETERMINISTIC_SCOPE, ...collectSubagentViewFiles()];
		const violations = findViolations(scopeFiles, LEGACY_IDENTIFIERS);

		if (violations.length > 0) {
			const report = violations.map(v => `  ${v.file}:${v.line} — ${v.label}: ${v.text}`).join("\n");
			throw new Error(`Legacy identifiers found in deterministic scope:\n${report}`);
		}

		expect(violations).toHaveLength(0);
	});

	test("repo-wide: no imports reference deleted subagent-navigator path", () => {
		const allSrc = collectTsFiles(SRC_ROOT);
		const allTest = collectTsFiles(TEST_ROOT);
		const thisFile = path.resolve(import.meta.dir, "subagent-cutover-absence.test.ts");
		const allFiles = [...allSrc, ...allTest].filter(f => f !== thisFile);

		const violations: Array<{ file: string; line: number; label: string; text: string }> = [];
		for (const filePath of allFiles) {
			if (!fs.existsSync(filePath)) continue;
			const lines = fs.readFileSync(filePath, "utf-8").split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (DELETED_IMPORT_PATTERN.test(line)) {
					violations.push({
						file: path.relative(REPO_ROOT, filePath),
						line: i + 1,
						label: "deleted module import",
						text: line.trim(),
					});
				}
			}
		}

		if (violations.length > 0) {
			const report = violations.map(v => `  ${v.file}:${v.line} — ${v.label}: ${v.text}`).join("\n");
			throw new Error(`Deleted module references found in coding-agent tree:\n${report}`);
		}

		expect(violations).toHaveLength(0);
	});

	test("repo-wide: no legacy subagent method calls remain in source tree", () => {
		const allSrc = collectTsFiles(SRC_ROOT);
		const violations = findViolations(allSrc, LEGACY_METHODS_REPO_WIDE);

		if (violations.length > 0) {
			const report = violations.map(v => `  ${v.file}:${v.line} — ${v.label}: ${v.text}`).join("\n");
			throw new Error(`Legacy method references found in source tree:\n${report}`);
		}

		expect(violations).toHaveLength(0);
	});
});

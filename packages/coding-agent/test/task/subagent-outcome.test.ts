import { describe, expect, test } from "bun:test";
import {
	deriveSubagentOutcomeFromReviewData,
	normalizeSubagentOutcome,
} from "../../src/task/subagent-outcome";

function resolveSubmitResultOutcomeForTest(item: { outcome?: unknown; data?: unknown }) {
	return normalizeSubagentOutcome(item.outcome) ?? deriveSubagentOutcomeFromReviewData(item.data);
}

describe("deriveSubagentOutcomeFromReviewData", () => {
	test("derives lint pass/fail from passed boolean", () => {
		expect(deriveSubagentOutcomeFromReviewData({ passed: true, summary: "No issues" })).toEqual({
			status: "pass",
			label: "lint",
			summary: "No issues",
		});
		expect(deriveSubagentOutcomeFromReviewData({ passed: false, summary: "Type errors found" })).toEqual({
			status: "fail",
			label: "lint",
			summary: "Type errors found",
		});
	});

	test("derives review go/no_go from verdict", () => {
		expect(deriveSubagentOutcomeFromReviewData({ verdict: "go", summary: "Looks good" })).toEqual({
			status: "go",
			label: "review",
			summary: "Looks good",
		});
		expect(deriveSubagentOutcomeFromReviewData({ verdict: "no_go", summary: "Blocking findings" })).toEqual({
			status: "no_go",
			label: "review",
			summary: "Blocking findings",
		});
		expect(deriveSubagentOutcomeFromReviewData({ verdict: "no-go", summary: "Still blocked" })).toEqual({
			status: "no_go",
			label: "review",
			summary: "Still blocked",
		});
	});

	test("derives legacy pass/fail from overall_correctness", () => {
		expect(
			deriveSubagentOutcomeFromReviewData({ overall_correctness: "correct", explanation: "All clear" }),
		).toEqual({
			status: "pass",
			label: "review",
			summary: "All clear",
		});
		expect(
			deriveSubagentOutcomeFromReviewData({ overall_correctness: "incorrect", explanation: "Found regressions" }),
		).toEqual({
			status: "fail",
			label: "review",
			summary: "Found regressions",
		});
	});

	test("returns undefined for nullish and unsupported values", () => {
		expect(deriveSubagentOutcomeFromReviewData(null)).toBeUndefined();
		expect(deriveSubagentOutcomeFromReviewData(undefined)).toBeUndefined();
		expect(deriveSubagentOutcomeFromReviewData({})).toBeUndefined();
		expect(deriveSubagentOutcomeFromReviewData([])).toBeUndefined();
		expect(deriveSubagentOutcomeFromReviewData("nope")).toBeUndefined();
	});
});

describe("submit_result outcome precedence", () => {
	test("prefers explicit outcome object over derived data", () => {
		expect(
			resolveSubmitResultOutcomeForTest({
				outcome: { status: "pass", label: "lint", summary: "Explicit outcome" },
				data: { verdict: "no_go", summary: "Derived failure" },
			}),
		).toEqual({
			status: "pass",
			label: "lint",
			summary: "Explicit outcome",
		});
	});
});

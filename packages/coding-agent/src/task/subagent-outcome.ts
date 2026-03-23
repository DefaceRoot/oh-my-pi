export type SubagentOutcomeStatus = "pass" | "fail" | "go" | "no_go";

export interface SubagentOutcome {
	status: SubagentOutcomeStatus;
	label?: string;
	summary?: string;
}

export function getSubagentOutcomeLabel(status: SubagentOutcomeStatus): string {
	switch (status) {
		case "pass":
			return "PASS";
		case "fail":
			return "FAIL";
		case "go":
			return "GO";
		case "no_go":
			return "NO-GO";
	}
}

export function getSubagentOutcomeTone(status: SubagentOutcomeStatus): "success" | "error" {
	switch (status) {
		case "pass":
		case "go":
			return "success";
		case "fail":
		case "no_go":
			return "error";
	}
}

function normalizeOutcomeStatus(value: unknown): SubagentOutcomeStatus | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replace(/-/g, "_");
	if (normalized === "pass" || normalized === "fail" || normalized === "go" || normalized === "no_go") {
		return normalized;
	}
	return undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSubagentOutcome(value: unknown): SubagentOutcome | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const status = normalizeOutcomeStatus(record.status);
	if (!status) return undefined;
	return {
		status,
		label: normalizeOptionalText(record.label),
		summary: normalizeOptionalText(record.summary),
	};
}

export function deriveSubagentOutcomeFromReviewData(value: unknown): SubagentOutcome | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;

	if (typeof record.passed === "boolean") {
		return {
			status: record.passed ? "pass" : "fail",
			label: "lint",
			summary: normalizeOptionalText(record.summary),
		};
	}

	const verdict = normalizeOptionalText(record.verdict)?.toLowerCase().replace(/-/g, "_");
	if (verdict === "go") {
		return {
			status: "go",
			label: "review",
			summary: normalizeOptionalText(record.summary),
		};
	}
	if (verdict === "no_go") {
		return {
			status: "no_go",
			label: "review",
			summary: normalizeOptionalText(record.summary),
		};
	}

	const correctness = normalizeOptionalText(record.overall_correctness)?.toLowerCase();
	if (correctness === "correct") {
		return {
			status: "pass",
			label: "review",
			summary: normalizeOptionalText(record.explanation),
		};
	}
	if (correctness === "incorrect") {
		return {
			status: "fail",
			label: "review",
			summary: normalizeOptionalText(record.explanation),
		};
	}
	return undefined;
}

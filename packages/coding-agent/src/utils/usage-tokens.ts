const TOTAL_TOKEN_FIELDS = ["totalTokens", "total_tokens"] as const;
const INPUT_FIELDS = ["input", "input_tokens", "inputTokens"] as const;
const OUTPUT_FIELDS = ["output", "output_tokens", "outputTokens"] as const;
const CACHE_READ_FIELDS = ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"] as const;
const CACHE_WRITE_FIELDS = ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"] as const;

function readFirstFiniteNumber(record: Record<string, unknown>, fields: readonly string[]): number | undefined {
	for (const field of fields) {
		const value = record[field];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

export function getDirectUsageTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") {
		return undefined;
	}

	const record = usage as Record<string, unknown>;
	const totalTokens = readFirstFiniteNumber(record, TOTAL_TOKEN_FIELDS);
	if (totalTokens !== undefined) {
		return totalTokens;
	}

	const input = readFirstFiniteNumber(record, INPUT_FIELDS);
	const output = readFirstFiniteNumber(record, OUTPUT_FIELDS);
	const cacheRead = readFirstFiniteNumber(record, CACHE_READ_FIELDS);
	const cacheWrite = readFirstFiniteNumber(record, CACHE_WRITE_FIELDS);

	if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
		return undefined;
	}

	return (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
}

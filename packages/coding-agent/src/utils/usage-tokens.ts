const TOTAL_TOKEN_FIELDS = ["totalTokens", "total_tokens"] as const;
const INPUT_FIELDS = ["input", "input_tokens", "inputTokens"] as const;
const OUTPUT_FIELDS = ["output", "output_tokens", "outputTokens"] as const;
const CACHE_READ_FIELDS = [
	"cacheRead",
	"cache_read",
	"cacheReadTokens",
	"cache_read_tokens",
	"cacheReadInputTokens",
	"cache_read_input_tokens",
] as const;
const CACHE_WRITE_FIELDS = [
	"cacheWrite",
	"cache_write",
	"cacheWriteTokens",
	"cache_write_tokens",
	"cacheCreationInputTokens",
	"cache_creation_input_tokens",
	"cacheWriteInputTokens",
	"cache_write_input_tokens",
] as const;

function readFirstFiniteNumber(record: Record<string, unknown>, fields: readonly string[]): number | undefined {
	for (const field of fields) {
		const value = record[field];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

function readUsageTokens(usage: unknown):
	| {
			input: number | undefined;
			output: number | undefined;
			cacheRead: number | undefined;
			cacheWrite: number | undefined;
			totalTokens: number | undefined;
	  }
	| undefined {
	if (!usage || typeof usage !== "object") {
		return undefined;
	}

	const record = usage as Record<string, unknown>;
	return {
		input: readFirstFiniteNumber(record, INPUT_FIELDS),
		output: readFirstFiniteNumber(record, OUTPUT_FIELDS),
		cacheRead: readFirstFiniteNumber(record, CACHE_READ_FIELDS),
		cacheWrite: readFirstFiniteNumber(record, CACHE_WRITE_FIELDS),
		totalTokens: readFirstFiniteNumber(record, TOTAL_TOKEN_FIELDS),
	};
}

export function getTotalUsageTokens(usage: unknown): number | undefined {
	const tokens = readUsageTokens(usage);
	if (!tokens) {
		return undefined;
	}

	if (tokens.totalTokens !== undefined) {
		return Math.max(0, tokens.totalTokens);
	}

	if (
		tokens.input !== undefined ||
		tokens.output !== undefined ||
		tokens.cacheRead !== undefined ||
		tokens.cacheWrite !== undefined
	) {
		return Math.max(
			0,
			(tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0),
		);
	}

	return undefined;
}

export function getDirectUsageTokens(usage: unknown): number | undefined {
	const tokens = readUsageTokens(usage);
	if (!tokens) {
		return undefined;
	}

	if (tokens.input !== undefined || tokens.output !== undefined) {
		return (tokens.input ?? 0) + (tokens.output ?? 0);
	}

	if (tokens.totalTokens !== undefined) {
		if (tokens.cacheRead !== undefined || tokens.cacheWrite !== undefined) {
			return Math.max(0, tokens.totalTokens - (tokens.cacheRead ?? 0) - (tokens.cacheWrite ?? 0));
		}
		return Math.max(0, tokens.totalTokens);
	}

	if (tokens.cacheRead !== undefined || tokens.cacheWrite !== undefined) {
		return 0;
	}

	return undefined;
}

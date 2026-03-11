import { describe, expect, test } from "bun:test";
import { getDirectUsageTokens } from "@oh-my-pi/pi-coding-agent/utils/usage-tokens";

describe("getDirectUsageTokens", () => {
	test("prefers direct input/output even when totals and cache fields exist", () => {
		expect(
			getDirectUsageTokens({
				input: 20,
				output: 5,
				cacheRead: 100,
				cacheWrite: 50,
				totalTokens: 175,
			}),
		).toBe(25);
	});

	test("derives uncached tokens from total minus cache when direct fields are missing", () => {
		expect(getDirectUsageTokens({ total_tokens: 80, cache_read: 10, cache_write: 5 })).toBe(65);
	});

	test("uses total token field when no direct or cache breakdown exists", () => {
		expect(getDirectUsageTokens({ totalTokens: 42 })).toBe(42);
	});

	test("returns zero when usage reports cache-only fields", () => {
		expect(getDirectUsageTokens({ cacheRead: 10, cacheWrite: 5 })).toBe(0);
	});

	test("returns undefined when usage object has no token fields", () => {
		expect(getDirectUsageTokens({})).toBeUndefined();
		expect(getDirectUsageTokens(undefined)).toBeUndefined();
	});
});

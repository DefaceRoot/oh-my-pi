import { describe, expect, test } from "bun:test";
import { getDirectUsageTokens, getTotalUsageTokens } from "@oh-my-pi/pi-coding-agent/utils/usage-tokens";

describe("getTotalUsageTokens", () => {
	test("prefers provider-reported total when direct and cache fields are also present", () => {
		expect(
			getTotalUsageTokens({
				input: 20,
				output: 5,
				cacheRead: 100,
				cacheWrite: 50,
				totalTokens: 175,
			}),
		).toBe(175);
	});

	test("sums direct and cache fields when total is missing", () => {
		expect(getTotalUsageTokens({ input: 100, output: 50, cacheRead: 25, cacheWrite: 5 })).toBe(180);
	});

	test("supports alternate provider field names", () => {
		expect(
			getTotalUsageTokens({
				inputTokens: 10,
				outputTokens: 8,
				cacheReadInputTokens: 4_000,
				cacheCreationInputTokens: 2_000,
			}),
		).toBe(6_018);
	});

	test("handles cache-only usage objects", () => {
		expect(getTotalUsageTokens({ cacheRead: 10, cacheWrite: 5 })).toBe(15);
		expect(getTotalUsageTokens({ cacheReadInputTokens: 25, cacheCreationInputTokens: 75 })).toBe(100);
	});

	test("returns undefined when no token fields are present", () => {
		expect(getTotalUsageTokens({})).toBeUndefined();
		expect(getTotalUsageTokens(undefined)).toBeUndefined();
	});
});

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
		expect(
			getDirectUsageTokens({
				total_tokens: 120,
				cache_read_input_tokens: 20,
				cache_creation_input_tokens: 10,
			}),
		).toBe(90);
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

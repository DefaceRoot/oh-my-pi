import { describe, expect, it } from "bun:test";
import { Snowflake } from "../src/snowflake";

const {
	valid,
	next,
	Source,
	lowerbound,
	upperbound,
	getSequence,
	getTimestamp,
	getDate,
	PATTERN,
	EPOCH_TIMESTAMP,
	MAX_SEQUENCE,
} = Snowflake;

describe("snowflake", () => {
	describe("valid()", () => {
		it("returns true for valid 16-char lowercase hex strings", () => {
			expect(valid("0000000000000000")).toBe(true);
			expect(valid("ffffffffffffffff")).toBe(true);
			expect(valid("0123456789abcdef")).toBe(true);
			expect(valid("a1b2c3d4e5f6a7b8")).toBe(true);
		});

		it("returns false for wrong length", () => {
			expect(valid("")).toBe(false);
			expect(valid("abc")).toBe(false);
			expect(valid("0123456789abcdef0")).toBe(false); // 17 chars
			expect(valid("0123456789abcde")).toBe(false); // 15 chars
		});

		it("returns false for uppercase hex chars", () => {
			expect(valid("0123456789ABCDEF")).toBe(false);
			expect(valid("FFFFFFFFFFFFFFFF")).toBe(false);
			expect(valid("A1B2C3D4E5F6A7B8")).toBe(false);
		});

		it("returns false for non-hex chars", () => {
			expect(valid("0123456789ghijkl")).toBe(false);
			expect(valid("gggggggggggggggg")).toBe(false);
			expect(valid("0123456789abcdef ")).toBe(false);
			expect(valid(" 0123456789abcdef")).toBe(false);
		});
	});

	describe("next()", () => {
		it("generates valid snowflakes", () => {
			const id = next();
			expect(valid(id)).toBe(true);
		});

		it("generates different values when called twice", () => {
			const id1 = next();
			const id2 = next();
			expect(id1).not.toBe(id2);
		});
	});

	describe("Snowflake.Source", () => {
		describe("constructor", () => {
			it("creates source with random sequence when no args", () => {
				const source = new Source();
				expect(source.sequence).toBeGreaterThanOrEqual(0);
				expect(source.sequence).toBeLessThanOrEqual(MAX_SEQUENCE);
			});

			it("creates source with specified seed value", () => {
				const source = new Source(12345);
				expect(source.sequence).toBe(12345);
			});

			it("masks seed value to MAX_SEQUENCE", () => {
				const source = new Source(MAX_SEQUENCE + 100);
				expect(source.sequence).toBe(99);
			});
		});

		describe("sequence getter/setter", () => {
			it("gets current sequence value", () => {
				const source = new Source(500);
				expect(source.sequence).toBe(500);
			});

			it("sets sequence value", () => {
				const source = new Source(0);
				source.sequence = 999;
				expect(source.sequence).toBe(999);
			});

			it("masks set value to MAX_SEQUENCE", () => {
				const source = new Source(0);
				source.sequence = MAX_SEQUENCE + 200;
				expect(source.sequence).toBe(199);
			});
		});

		describe("reset()", () => {
			it("sets sequence to 0", () => {
				const source = new Source(12345);
				expect(source.sequence).toBe(12345);
				source.reset();
				expect(source.sequence).toBe(0);
			});
		});

		describe("generate()", () => {
			it("creates valid snowflakes", () => {
				const source = new Source(0);
				const timestamp = Date.now();
				const id = source.generate(timestamp);
				expect(valid(id)).toBe(true);
			});

			it("increments sequence on each generate", () => {
				const source = new Source(0);
				const timestamp = Date.now();

				const id1 = source.generate(timestamp);
				const id2 = source.generate(timestamp);
				const id3 = source.generate(timestamp);

				expect(getSequence(id1)).toBe(1);
				expect(getSequence(id2)).toBe(2);
				expect(getSequence(id3)).toBe(3);
			});

			it("wraps sequence at MAX_SEQUENCE", () => {
				const source = new Source(MAX_SEQUENCE - 1);
				const timestamp = Date.now();

				const id1 = source.generate(timestamp);
				const id2 = source.generate(timestamp);

				expect(getSequence(id1)).toBe(MAX_SEQUENCE);
				expect(getSequence(id2)).toBe(0);
			});
		});
	});

	describe("lowerbound()", () => {
		it("accepts Date and returns snowflake with sequence 0", () => {
			const date = new Date(1700000000000);
			const id = lowerbound(date);
			expect(valid(id)).toBe(true);
			expect(getSequence(id)).toBe(0);
			expect(getTimestamp(id)).toBe(1700000000000);
		});

		it("accepts number timestamp and returns snowflake with sequence 0", () => {
			const timestamp = 1700000000000;
			const id = lowerbound(timestamp);
			expect(valid(id)).toBe(true);
			expect(getSequence(id)).toBe(0);
			expect(getTimestamp(id)).toBe(timestamp);
		});

		it("accepts snowflake string and returns it unchanged", () => {
			const original = next();
			const id = lowerbound(original);
			expect(id).toBe(original);
		});
	});

	describe("upperbound()", () => {
		it("accepts Date and returns snowflake with MAX_SEQUENCE", () => {
			const date = new Date(1700000000000);
			const id = upperbound(date);
			expect(valid(id)).toBe(true);
			expect(getSequence(id)).toBe(MAX_SEQUENCE);
			expect(getTimestamp(id)).toBe(1700000000000);
		});

		it("accepts number timestamp and returns snowflake with MAX_SEQUENCE", () => {
			const timestamp = 1700000000000;
			const id = upperbound(timestamp);
			expect(valid(id)).toBe(true);
			expect(getSequence(id)).toBe(MAX_SEQUENCE);
			expect(getTimestamp(id)).toBe(timestamp);
		});

		it("accepts snowflake string and returns it unchanged", () => {
			const original = next();
			const id = upperbound(original);
			expect(id).toBe(original);
		});
	});

	describe("getSequence()", () => {
		it("extracts sequence from snowflake", () => {
			const source = new Source(0);
			const timestamp = Date.now();

			const id1 = source.generate(timestamp);
			const id2 = source.generate(timestamp);

			expect(getSequence(id1)).toBe(1);
			expect(getSequence(id2)).toBe(2);
		});
	});

	describe("getTimestamp()", () => {
		it("extracts timestamp from snowflake", () => {
			const timestamp = 1700000000000;
			const source = new Source(0);
			const id = source.generate(timestamp);

			expect(getTimestamp(id)).toBe(timestamp);
		});
	});

	describe("getDate()", () => {
		it("returns Date object from snowflake", () => {
			const timestamp = 1700000000000;
			const source = new Source(0);
			const id = source.generate(timestamp);

			const date = getDate(id);
			expect(date).toBeInstanceOf(Date);
			expect(date.getTime()).toBe(timestamp);
		});
	});

	describe("constants", () => {
		it("exports PATTERN regex for validation", () => {
			expect(PATTERN).toBeInstanceOf(RegExp);
			expect(PATTERN.test("0123456789abcdef")).toBe(true);
			expect(PATTERN.test("0123456789ABCDEF")).toBe(false);
			expect(PATTERN.test("0123456789abcde")).toBe(false);
		});

		it("exports EPOCH_TIMESTAMP (Discord epoch: 2015-01-01)", () => {
			expect(EPOCH_TIMESTAMP).toBe(1420070400000);
			const epochDate = new Date(EPOCH_TIMESTAMP);
			expect(epochDate.getUTCFullYear()).toBe(2015);
			expect(epochDate.getUTCMonth()).toBe(0); // January
			expect(epochDate.getUTCDate()).toBe(1);
		});

		it("exports MAX_SEQUENCE (22-bit max: 0x3fffff)", () => {
			expect(MAX_SEQUENCE).toBe(0x3fffff);
			expect(MAX_SEQUENCE).toBe(4194303);
		});
	});
});

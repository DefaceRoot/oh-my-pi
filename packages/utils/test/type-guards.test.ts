import { describe, expect, it } from "bun:test";
import { asRecord, isRecord, toError } from "../src/type-guards";

describe("isRecord", () => {
	it("returns true for plain object", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ foo: "bar" })).toBe(true);
	});

	it("returns true for nested object", () => {
		expect(isRecord({ nested: { deep: true } })).toBe(true);
	});

	it("returns false for array", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord([1, 2, 3])).toBe(false);
	});

	it("returns false for null", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("returns false for string", () => {
		expect(isRecord("string")).toBe(false);
	});

	it("returns false for number", () => {
		expect(isRecord(42)).toBe(false);
		expect(isRecord(0)).toBe(false);
		expect(isRecord(NaN)).toBe(false);
	});

	it("returns false for boolean", () => {
		expect(isRecord(true)).toBe(false);
		expect(isRecord(false)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isRecord(undefined)).toBe(false);
	});
});

describe("asRecord", () => {
	it("returns object for plain object", () => {
		const obj = { foo: "bar" };
		expect(asRecord(obj)).toBe(obj);
	});

	it("returns object for nested object", () => {
		const nested = { nested: { deep: true } };
		expect(asRecord(nested)).toBe(nested);
	});

	it("returns null for array", () => {
		expect(asRecord([])).toBeNull();
		expect(asRecord([1, 2, 3])).toBeNull();
	});

	it("returns null for null", () => {
		expect(asRecord(null)).toBeNull();
	});

	it("returns null for string", () => {
		expect(asRecord("string")).toBeNull();
	});

	it("returns null for number", () => {
		expect(asRecord(42)).toBeNull();
	});

	it("returns null for boolean", () => {
		expect(asRecord(true)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(asRecord(undefined)).toBeNull();
	});
});

describe("toError", () => {
	it("passes through Error instance", () => {
		const error = new Error("test error");
		expect(toError(error)).toBe(error);
	});

	it("wraps string in Error", () => {
		const result = toError("error message");
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("error message");
	});

	it("converts object with message to Error", () => {
		const obj = { message: "object error" };
		const result = toError(obj);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("[object Object]");
	});

	it("converts null to Error with string 'null'", () => {
		const result = toError(null);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("null");
	});

	it("converts undefined to Error with string 'undefined'", () => {
		const result = toError(undefined);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("undefined");
	});

	it("converts number to Error", () => {
		const result = toError(42);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("42");
	});

	it("converts boolean to Error", () => {
		const result = toError(true);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("true");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $pickenv, parseEnvFile } from "../src/env";

describe("parseEnvFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("parses basic KEY=value pairs", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "FOO=bar\nBAZ=qux");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("bar");
		expect(result.BAZ).toBe("qux");
	});

	test("unquotes double-quoted values", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, 'FOO="quoted value"\nBAR="another"');
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("quoted value");
		expect(result.BAR).toBe("another");
	});

	test("unquotes single-quoted values", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "FOO='single quoted'\nBAR='another'");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("single quoted");
		expect(result.BAR).toBe("another");
	});

	test("ignores comment lines starting with #", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "# This is a comment\nFOO=bar\n# Another comment");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("bar");
		expect(Object.keys(result).length).toBe(1);
	});

	test("ignores empty lines", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "\n\nFOO=bar\n\n\nBAZ=qux\n\n");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("bar");
		expect(result.BAZ).toBe("qux");
		expect(Object.keys(result).length).toBe(2);
	});

	test("trims whitespace around key and value", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "  FOO  =  bar  \n\tBAZ\t=\tqux\t");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("bar");
		expect(result.BAZ).toBe("qux");
	});

	test("returns empty object for non-existent file", () => {
		const envPath = join(tempDir, "nonexistent.env");
		const result = parseEnvFile(envPath);
		expect(result).toEqual({});
	});

	test("OMP_ prefixes override PI_ prefixes", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "OMP_FOO=override\nOMP_BAR=test");
		const result = parseEnvFile(envPath);
		expect(result.OMP_FOO).toBe("override");
		expect(result.PI_FOO).toBe("override");
		expect(result.OMP_BAR).toBe("test");
		expect(result.PI_BAR).toBe("test");
	});

	test("OMP_ override overwrites existing PI_ keys", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "PI_FOO=original\nOMP_FOO=override");
		const result = parseEnvFile(envPath);
		expect(result.PI_FOO).toBe("override");
		expect(result.OMP_FOO).toBe("override");
	});

	test("handles lines without equals sign gracefully", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "INVALIDLINE\nFOO=bar");
		const result = parseEnvFile(envPath);
		expect(result.FOO).toBe("bar");
		expect(Object.keys(result).length).toBe(1);
	});

	test("handles empty values", () => {
		const envPath = join(tempDir, ".env");
		writeFileSync(envPath, "EMPTY=\nFOO=bar");
		const result = parseEnvFile(envPath);
		expect(result.EMPTY).toBe("");
		expect(result.FOO).toBe("bar");
	});
});

describe("$pickenv", () => {
	test("returns first existing key value", () => {
		const originalValue = Bun.env.PICKENV_TEST_KEY;
		Bun.env.PICKENV_TEST_KEY = "test_value";

		const result = $pickenv("PICKENV_TEST_KEY", "NONEXISTENT_KEY");
		expect(result).toBe("test_value");

		if (originalValue === undefined) {
			delete Bun.env.PICKENV_TEST_KEY;
		} else {
			Bun.env.PICKENV_TEST_KEY = originalValue;
		}
	});

	test("returns undefined if no keys found", () => {
		const result = $pickenv("NONEXISTENT_KEY_1", "NONEXISTENT_KEY_2", "NONEXISTENT_KEY_3");
		expect(result).toBeUndefined();
	});

	test("skips empty string values", () => {
		const originalValue = Bun.env.PICKENV_EMPTY_TEST;
		Bun.env.PICKENV_EMPTY_TEST = "";

		const result = $pickenv("PICKENV_EMPTY_TEST");
		expect(result).toBeUndefined();

		if (originalValue === undefined) {
			delete Bun.env.PICKENV_EMPTY_TEST;
		} else {
			Bun.env.PICKENV_EMPTY_TEST = originalValue;
		}
	});

	test("skips whitespace-only values", () => {
		const originalValue = Bun.env.PICKENV_WHITESPACE_TEST;
		Bun.env.PICKENV_WHITESPACE_TEST = "   \t\n";

		const result = $pickenv("PICKENV_WHITESPACE_TEST");
		expect(result).toBeUndefined();

		if (originalValue === undefined) {
			delete Bun.env.PICKENV_WHITESPACE_TEST;
		} else {
			Bun.env.PICKENV_WHITESPACE_TEST = originalValue;
		}
	});

	test("returns second key when first is empty", () => {
		const original1 = Bun.env.PICKENV_FIRST;
		const original2 = Bun.env.PICKENV_SECOND;
		Bun.env.PICKENV_FIRST = "";
		Bun.env.PICKENV_SECOND = "second_value";

		const result = $pickenv("PICKENV_FIRST", "PICKENV_SECOND");
		expect(result).toBe("second_value");

		if (original1 === undefined) delete Bun.env.PICKENV_FIRST;
		else Bun.env.PICKENV_FIRST = original1;
		if (original2 === undefined) delete Bun.env.PICKENV_SECOND;
		else Bun.env.PICKENV_SECOND = original2;
	});

	test("trims whitespace from values", () => {
		const originalValue = Bun.env.PICKENV_TRIM_TEST;
		Bun.env.PICKENV_TRIM_TEST = "  trimmed  ";

		const result = $pickenv("PICKENV_TRIM_TEST");
		expect(result).toBe("trimmed");

		if (originalValue === undefined) {
			delete Bun.env.PICKENV_TRIM_TEST;
		} else {
			Bun.env.PICKENV_TRIM_TEST = originalValue;
		}
	});
});

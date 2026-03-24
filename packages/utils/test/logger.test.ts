import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { debug, error, warn } from "../src/logger";

function createEaccesError(): Error & { code: string } {
	const err = new Error("permission denied") as Error & { code: string };
	err.code = "EACCES";
	return err;
}

describe("logger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables file logging after a write permission failure", () => {
		const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
			throw createEaccesError();
		});

		expect(() => debug("first message")).not.toThrow();
		expect(() => warn("second message")).not.toThrow();
		expect(() => error("third message")).not.toThrow();

		expect(appendSpy).toHaveBeenCalledTimes(1);
	});
});

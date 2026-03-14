import { describe, expect, test } from "bun:test";
import { withTimeout } from "../src/async";

describe("withTimeout", () => {
	test("resolves before timeout - returns value", async () => {
		const promise = Promise.resolve("success");
		const result = await withTimeout(promise, 50, "Timeout exceeded");
		expect(result).toBe("success");
	});

	test("resolves before timeout - async value", async () => {
		const promise = new Promise<string>(resolve => {
			setTimeout(() => resolve("delayed success"), 10);
		});
		const result = await withTimeout(promise, 50, "Timeout exceeded");
		expect(result).toBe("delayed success");
	});

	test("rejects before timeout - propagates error", async () => {
		const error = new Error("original error");
		const promise = Promise.reject(error);
		const result = withTimeout(promise, 50, "Timeout exceeded");
		await expect(result).rejects.toThrow("original error");
	});

	test("rejects before timeout - async error", async () => {
		const promise = new Promise<string>((_, reject) => {
			setTimeout(() => reject(new Error("async error")), 10);
		});
		const result = withTimeout(promise, 50, "Timeout exceeded");
		await expect(result).rejects.toThrow("async error");
	});

	test("times out - rejects with message", async () => {
		const promise = new Promise<string>(() => {
			// Never resolves
		});
		const result = withTimeout(promise, 10, "Timeout exceeded");
		await expect(result).rejects.toThrow("Timeout exceeded");
	});

	test("already aborted signal - rejects immediately with abort reason", async () => {
		const controller = new AbortController();
		controller.abort(new Error("Already aborted"));
		const promise = Promise.resolve("success");
		const result = withTimeout(promise, 50, "Timeout exceeded", controller.signal);
		await expect(result).rejects.toThrow("Already aborted");
	});

	test("already aborted signal - non-Error reason wrapped", async () => {
		const controller = new AbortController();
		controller.abort("string reason");
		const promise = Promise.resolve("success");
		const result = withTimeout(promise, 50, "Timeout exceeded", controller.signal);
		await expect(result).rejects.toThrow("Aborted");
	});

	test("aborted during execution - rejects with abort reason", async () => {
		const controller = new AbortController();
		const promise = new Promise<string>(() => {
			// Never resolves on its own
		});
		const result = withTimeout(promise, 100, "Timeout exceeded", controller.signal);
		setTimeout(() => controller.abort(new Error("Aborted mid-flight")), 10);
		await expect(result).rejects.toThrow("Aborted mid-flight");
	});

	test("aborted during execution - clears timeout", async () => {
		const controller = new AbortController();
		const promise = new Promise<string>(() => {
			// Never resolves
		});
		// If timeout isn't cleared, this would reject with "Timeout exceeded"
		// Instead it should reject with abort reason first
		const result = withTimeout(promise, 30, "Timeout exceeded", controller.signal);
		setTimeout(() => controller.abort(new Error("Aborted first")), 10);
		await expect(result).rejects.toThrow("Aborted first");
	});

	test("multiple concurrent withTimeout calls - independent behavior", async () => {
		const controller1 = new AbortController();
		const controller2 = new AbortController();
		const controller3 = new AbortController();

		const promise1 = new Promise<string>(resolve => {
			setTimeout(() => resolve("first"), 10);
		});
		const promise2 = new Promise<string>(() => {
			// Never resolves - will timeout
		});
		const promise3 = new Promise<string>(() => {
			// Never resolves - will be aborted
		});

		const result1 = withTimeout(promise1, 50, "Timeout 1", controller1.signal);
		const result2 = withTimeout(promise2, 20, "Timeout 2", controller2.signal);
		const result3 = withTimeout(promise3, 100, "Timeout 3", controller3.signal);

		setTimeout(() => controller3.abort(new Error("Aborted 3")), 10);

		// Use Promise.allSettled to handle all promises without unhandled rejection warnings
		const results = await Promise.allSettled([result1, result2, result3]);

		expect(results[0].status).toBe("fulfilled");
		expect((results[0] as PromiseFulfilledResult<string>).value).toBe("first");

		expect(results[1].status).toBe("rejected");
		expect((results[1] as PromiseRejectedResult).reason.message).toBe("Timeout 2");

		expect(results[2].status).toBe("rejected");
		expect((results[2] as PromiseRejectedResult).reason.message).toBe("Aborted 3");
	});

	test("no signal provided - timeout still works", async () => {
		const promise = new Promise<string>(() => {
			// Never resolves
		});
		const result = withTimeout(promise, 10, "No signal timeout");
		await expect(result).rejects.toThrow("No signal timeout");
	});

	test("no signal provided - resolves normally", async () => {
		const promise = Promise.resolve("no signal success");
		const result = await withTimeout(promise, 50, "Should not happen");
		expect(result).toBe("no signal success");
	});
});

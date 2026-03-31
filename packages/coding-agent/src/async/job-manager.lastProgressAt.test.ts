import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async/job-manager";

describe("AsyncJobManager.lastProgressAt", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({
			onJobComplete: () => {},
			retentionMs: 0,
		});
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 500 });
	});

	test("lastProgressAt is undefined before any updateProgress call", () => {
		const id = manager.register("task", "test job", () => new Promise(() => {}));
		const job = manager.getJob(id);
		expect(job?.lastProgressAt).toBeUndefined();
		manager.cancel(id);
	});

	test("updateProgress sets lastProgressAt to approximately now", async () => {
		const before = Date.now();
		const id = manager.register("task", "test job", () => new Promise(() => {}));
		manager.updateProgress(id, { tokens: 42 });
		const after = Date.now();

		const job = manager.getJob(id);
		expect(job?.lastProgressAt).toBeGreaterThanOrEqual(before);
		expect(job?.lastProgressAt).toBeLessThanOrEqual(after);
		manager.cancel(id);
	});

	test("updateProgress advances lastProgressAt on each call", async () => {
		const id = manager.register("task", "test job", () => new Promise(() => {}));

		manager.updateProgress(id, { tokens: 10 });
		const first = manager.getJob(id)?.lastProgressAt;

		// Small delay to ensure timestamps differ
		await Bun.sleep(5);

		manager.updateProgress(id, { tokens: 20 });
		const second = manager.getJob(id)?.lastProgressAt;

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second!).toBeGreaterThanOrEqual(first!);
		manager.cancel(id);
	});

	test("updateProgress is ignored for non-running jobs", () => {
		const id = manager.register("task", "test job", () => new Promise(() => {}));
		manager.cancel(id);

		// This call should be a no-op because the job is cancelled
		manager.updateProgress(id, { tokens: 99 });

		// The job was cancelled before updateProgress; lastProgressAt must remain unset
		const job = manager.getJob(id);
		expect(job?.lastProgressAt).toBeUndefined();
	});
});

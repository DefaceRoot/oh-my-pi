import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../async/job-manager";
import type { Settings } from "../config/settings";
import type { ToolSession } from "./index";
import { AwaitTool } from "./await-tool";

/** Builds a minimal ToolSession stub for AwaitTool tests. */
function makeSession(stallThresholdSeconds: number, manager: AsyncJobManager): ToolSession {
	return {
		asyncJobManager: manager,
		settings: {
			get(key: string) {
				if (key === "async.stallThresholdSeconds") return stallThresholdSeconds;
				return undefined;
			},
		} as unknown as Settings,
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

/** Registers a never-resolving task job (simulates a frozen subagent). */
function registerFrozenJob(manager: AsyncJobManager, type: "task" | "bash" = "task"): string {
	return manager.register(type, "frozen agent", ({ signal }) => {
		return new Promise<string>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			// Never resolves on its own — simulates a model freeze
		});
	});
}

describe("AwaitTool stall detection", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		manager = new AsyncJobManager({
			onJobComplete: () => {},
			retentionMs: 0,
		});
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1000 });
	});

	test("cancels a frozen task job and marks it stalledAndCancelled", async () => {
		// Very short stall threshold (50ms) and short call timeout (300ms) so the test is fast.
		// The sleep per poll iteration = min(15000, 300) = 300ms.
		// After 300ms the stall check fires: now - startTime >= 50ms → cancel.
		const stallMs = 50;
		const tool = new AwaitTool(makeSession(stallMs / 1000, manager));
		const jobId = registerFrozenJob(manager);

		const result = await tool.execute("call-1", { jobs: [jobId], timeout: 0.3 });

		const job = result.details!.jobs.find(j => j.id === jobId);
		expect(job).toBeDefined();
		expect(job?.stalledAndCancelled).toBe(true);

		// The output text should contain the stall section header
		const text = (result.content[0] as { type: "text"; text: string } | undefined)?.text ?? "";
		expect(text).toContain("Stalled");
		expect(text).toContain("Resubmit");
	}, 2000);

	test("does not cancel bash jobs regardless of inactivity", async () => {
		// Bash jobs are excluded from stall detection even if frozen.
		const stallMs = 50;
		const tool = new AwaitTool(makeSession(stallMs / 1000, manager));
		const jobId = registerFrozenJob(manager, "bash");

		// Use a short call timeout so the test returns without waiting forever.
		const result = await tool.execute("call-2", { jobs: [jobId], timeout: 0.3 });

		const job = result.details!.jobs.find(j => j.id === jobId);
		expect(job).toBeDefined();
		expect(job?.stalledAndCancelled).toBeUndefined();
		// Job should still be running (bash stall immunity)
		expect(job?.status).toBe("running");

		manager.cancel(jobId);
	}, 2000);

	test("disables stall detection when threshold is zero", async () => {
		// threshold=0 must never cancel any job
		const tool = new AwaitTool(makeSession(0, manager));
		const jobId = registerFrozenJob(manager, "task");

		const result = await tool.execute("call-3", { jobs: [jobId], timeout: 0.3 });

		const job = result.details!.jobs.find(j => j.id === jobId);
		expect(job?.stalledAndCancelled).toBeUndefined();
		expect(job?.status).toBe("running");

		manager.cancel(jobId);
	}, 2000);

	test("does not stall a task job that produces recent progress", async () => {
		// Register a task job that completes immediately — before the poll fires.
		// A completing job is never stalled because it leaves "running" status before
		// the stall check can inspect it.
		const tool = new AwaitTool(makeSession(0.05, manager)); // 50ms threshold

		const jobId = manager.register("task", "fast job", async () => "ok");

		const result = await tool.execute("call-4", { jobs: [jobId], timeout: 1 });

		const job = result.details!.jobs.find(j => j.id === jobId);
		expect(job?.stalledAndCancelled).toBeUndefined();
		expect(job?.status).toBe("completed");
	}, 3000);

	test("stall check respects lastProgressAt over startTime when progress was received", async () => {
		// Register a frozen job, then immediately update its progress so lastProgressAt = now.
		// With a 10s stall threshold and 300ms call timeout, the job should NOT be stalled yet.
		const tool = new AwaitTool(makeSession(10, manager)); // 10s threshold — well beyond 300ms timeout
		const jobId = registerFrozenJob(manager);

		// Simulate a recent progress event
		manager.updateProgress(jobId, { tokens: 100 });

		const result = await tool.execute("call-5", { jobs: [jobId], timeout: 0.3 });

		const job = result.details!.jobs.find(j => j.id === jobId);
		// lastProgressAt is recent; threshold not exceeded → not stalled
		expect(job?.stalledAndCancelled).toBeUndefined();
		expect(job?.status).toBe("running");

		manager.cancel(jobId);
	}, 2000);
});

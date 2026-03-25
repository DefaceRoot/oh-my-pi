import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	clearSubagentRuntimeRegistry,
	registerSubagentRuntime,
	resumeSubagentRuntime,
	stopSubagentRuntime,
	unregisterSubagentRuntime,
} from "@oh-my-pi/pi-coding-agent/task/subagent-runtime-registry";

describe("subagent runtime registry", () => {
	afterEach(() => {
		clearSubagentRuntimeRegistry();
		vi.restoreAllMocks();
	});

	it("stops a registered subagent by runtime id", async () => {
		const stop = vi.fn(async () => true);
		const resume = vi.fn(async () => true);
		registerSubagentRuntime({
			id: "22-VerifyPhase07",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/22-VerifyPhase07.jsonl",
			stop,
			resume,
		});

		await expect(
			stopSubagentRuntime({ id: "22-VerifyPhase07" }, "User stopped: waiting on product clarification"),
		).resolves.toBe(true);
		expect(stop).toHaveBeenCalledWith("User stopped: waiting on product clarification");
	});

	it("can resolve a registered subagent by OMP session id", async () => {
		const stop = vi.fn(async () => true);
		const resume = vi.fn(async () => true);
		registerSubagentRuntime({
			id: "22-VerifyPhase07",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/22-VerifyPhase07.jsonl",
			stop,
			resume,
		});

		await expect(
			stopSubagentRuntime({ sessionId: "omp-session-1497" }, "User stopped: no longer needed"),
		).resolves.toBe(true);
		expect(stop).toHaveBeenCalledWith("User stopped: no longer needed");
	});

	it("does not stop an unregistered subagent", async () => {
		const stop = vi.fn(async () => true);
		const resume = vi.fn(async () => true);
		registerSubagentRuntime({
			id: "22-VerifyPhase07",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/22-VerifyPhase07.jsonl",
			stop,
			resume,
		});
		unregisterSubagentRuntime("22-VerifyPhase07");

		await expect(stopSubagentRuntime({ id: "22-VerifyPhase07" }, "User stopped: done")).resolves.toBe(false);
		expect(stop).not.toHaveBeenCalled();
	});

	it("passes the continuation message to a registered subagent resume handler", async () => {
		const stop = vi.fn(async () => true);
		const resume = vi.fn(async () => true);
		registerSubagentRuntime({
			id: "22-VerifyPhase07",
			sessionId: "omp-session-1497",
			sessionPath: "/tmp/22-VerifyPhase07.jsonl",
			stop,
			resume,
		});

		await expect(
			resumeSubagentRuntime({ sessionPath: "/tmp/22-VerifyPhase07.jsonl" }, "Continue from the last tool call"),
		).resolves.toBe(true);
		expect(resume).toHaveBeenCalledWith("Continue from the last tool call");
	});
});

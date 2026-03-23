import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { TASK_SUBAGENT_STOP_REQUEST_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const capturedSignals = new Map<string, AbortSignal | undefined>();
const resultResolvers = new Map<string, (result: SingleResult) => void>();

function createDeferredResult(id: string): Promise<SingleResult> {
	const { promise, resolve } = Promise.withResolvers<SingleResult>();
	resultResolvers.set(id, resolve);
	return promise;
}

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: (opts: Record<string, unknown>) => {
		const id = String(opts.id);
		const signal = opts.signal as AbortSignal | undefined;
		capturedSignals.set(id, signal);

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					const reason = typeof signal.reason === "string" ? signal.reason : "aborted";
					resultResolvers.get(id)?.({
						index: 0,
						id,
						agent: "explore",
						agentSource: "bundled",
						task: `task ${id}`,
						description: id,
						exitCode: 1,
						output: "",
						stderr: reason,
						truncated: false,
						durationMs: 1,
						tokens: 0,
						aborted: true,
						abortReason: reason,
					});
				},
				{ once: true },
			);
		}

		return createDeferredResult(id);
	},
	resumeCancelledSubagent: async () => null,
}));


mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: [
			{
				name: "explore",
				description: "test agent",
				source: "bundled",
				model: "default",
				systemPrompt: "You are a test agent.",
			},
		],
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(a => a.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

function createMinimalSession(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		taskDepth: 0,
		// Return IDs as-is so signal lookups in the test use declared task IDs.
		agentOutputManager: { allocateBatch: async (ids: string[]) => ids },
		...overrides,
	} as Parameters<typeof TaskTool.create>[0];
}

describe("TaskTool targeted subagent stop requests", () => {
	beforeEach(() => {
		capturedSignals.clear();
		resultResolvers.clear();
	});

	test("aborts only the matching subagent signal and preserves the user reason", async () => {
		const bus = new EventBus();
		const session = createMinimalSession({ eventBus: bus });
		const tool = await TaskTool.create(session);

		const executePromise = tool.execute("call-stop", {
			agent: "explore",
			tasks: [
				{ id: "StopMe", description: "stop me", assignment: "one" },
				{ id: "KeepGoing", description: "keep going", assignment: "two" },
			],
		});

		while (capturedSignals.size < 2) {
			await Bun.sleep(1);
		}
		let respondArg: boolean | undefined;
		let handled = false;
		bus.emit(TASK_SUBAGENT_STOP_REQUEST_CHANNEL, {
			id: "StopMe",
			reason: "User stopped from flight deck: duplicate workstream",
			respond: (v: boolean) => {
				respondArg = v;
				handled = true;
			},
		});

		console.log('DBG respond arg (abortSubtask returned):', respondArg);
		console.log('DBG StopMe aborted:', capturedSignals.get('StopMe')?.aborted);
		
		expect(handled).toBe(true);
		expect(capturedSignals.get("StopMe")?.aborted).toBe(true);
		expect(capturedSignals.get("StopMe")?.reason).toBe("User stopped from flight deck: duplicate workstream");
		expect(capturedSignals.get("KeepGoing")?.aborted).toBe(false);

		resultResolvers.get("KeepGoing")?.({
			index: 1,
			id: "KeepGoing",
			agent: "explore",
			agentSource: "bundled",
			task: "task KeepGoing",
			description: "KeepGoing",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
		});

		const result = await executePromise;
		expect(result.details?.results).toHaveLength(2);
		expect(result.details?.results[0]).toMatchObject({
			id: "StopMe",
			aborted: true,
			abortReason: "User stopped from flight deck: duplicate workstream",
		});
		expect(result.details?.results[1]).toMatchObject({
			id: "KeepGoing",
			exitCode: 0,
		});
	});
});

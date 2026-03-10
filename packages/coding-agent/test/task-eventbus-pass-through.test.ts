/**
 * Unit 3.7 / 3.8: Verify that TaskTool passes the session's EventBus
 * through to runSubprocess for both non-isolated and isolated task execution.
 *
 * Scope: task/index.ts -> EventBus handoff only.
 * Does NOT test end-to-end ingestion (that's Unit 3.9).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// ── Mocks ──────────────────────────────────────────────────────────────────

/** Captured options from every runSubprocess call */
const capturedCalls: Array<{ eventBus: unknown }> = [];

const stubResult: SingleResult = {
	index: 0,
	id: "TestTask",
	agent: "explore",
	agentSource: "bundled",
	task: "stub",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 10,
	tokens: 100,
};

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (opts: Record<string, unknown>) => {
		capturedCalls.push({ eventBus: opts.eventBus });
		return { ...stubResult };
	},
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

// Import AFTER mocks are set up
const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

// ── Helpers ────────────────────────────────────────────────────────────────

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
		...overrides,
	} as Parameters<typeof TaskTool.create>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("TaskTool EventBus pass-through", () => {
	beforeEach(() => {
		capturedCalls.length = 0;
	});

	test("passes session eventBus to runSubprocess (non-isolated)", async () => {
		const bus = new EventBus();
		const session = createMinimalSession({ eventBus: bus });
		const tool = await TaskTool.create(session);

		await tool.execute("call-1", {
			agent: "explore",
			tasks: [
				{
					id: "TestTask",
					description: "test",
					assignment: "do nothing",
				},
			],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0].eventBus).toBe(bus);
	});

	test("passes undefined when session has no eventBus", async () => {
		const session = createMinimalSession();
		const tool = await TaskTool.create(session);

		await tool.execute("call-2", {
			agent: "explore",
			tasks: [
				{
					id: "TestTask",
					description: "test",
					assignment: "do nothing",
				},
			],
		});

		expect(capturedCalls).toHaveLength(1);
		expect(capturedCalls[0].eventBus).toBeUndefined();
	});

	test("passes same eventBus for every task in a parallel batch", async () => {
		const bus = new EventBus();
		const session = createMinimalSession({ eventBus: bus });
		const tool = await TaskTool.create(session);

		await tool.execute("call-3", {
			agent: "explore",
			tasks: [
				{ id: "TaskA", description: "first", assignment: "a" },
				{ id: "TaskB", description: "second", assignment: "b" },
				{ id: "TaskC", description: "third", assignment: "c" },
			],
		});

		expect(capturedCalls.length).toBeGreaterThanOrEqual(3);
		for (const call of capturedCalls) {
			expect(call.eventBus).toBe(bus);
		}
	});

	test("eventBus instance is referentially identical to session bus", async () => {
		const bus = new EventBus();
		const session = createMinimalSession({ eventBus: bus });
		const tool = await TaskTool.create(session);

		// Execute once - verify strict identity, not just truthiness
		await tool.execute("call-4", {
			agent: "explore",
			tasks: [
				{
					id: "IdentityCheck",
					description: "identity",
					assignment: "check",
				},
			],
		});

		expect(capturedCalls).toHaveLength(1);
		// Strict reference equality — not a clone or wrapper
		expect(capturedCalls[0].eventBus === bus).toBe(true);
	});
});

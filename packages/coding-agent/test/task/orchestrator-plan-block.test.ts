import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";

const runSubprocessAgents: string[] = [];

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

const availableAgents = ["explore", "research", "implement", "verifier", "coderabbit", "lint", "code-reviewer", "commit"].map(
	name => ({
		name,
		description: `${name} test agent`,
		source: "bundled" as const,
		model: "default",
		systemPrompt: `You are ${name}.`,
	}),
);

mock.module("@oh-my-pi/pi-coding-agent/task/executor", () => ({
	runSubprocess: async (opts: Record<string, unknown>) => {
		const agent = opts.agent as { name: string };
		runSubprocessAgents.push(agent.name);
		return { ...stubResult, agent: agent.name };
	},
}));

mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
	discoverAgents: async () => ({
		agents: availableAgents,
		projectAgentsDir: null,
	}),
	getAgent: (agents: Array<{ name: string }>, name: string) => agents.find(a => a.name === name) ?? null,
}));

const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");

type SessionOverrides = Partial<Parameters<typeof TaskTool.create>[0]>;

function createMinimalSession(overrides: SessionOverrides = {}) {
	return {
		cwd: "/tmp/test-cwd",
		hasUI: true,
		settings: Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": false,
		}),
		getSessionFile: () => "/tmp/test-session.jsonl",
		getSessionSpawns: () => "*",
		getRuntimeRole: () => "orchestrator",
		taskDepth: 0,
		...overrides,
	} as Parameters<typeof TaskTool.create>[0];
}

async function executeWithAgent(agent: string, overrides: SessionOverrides = {}) {
	const tool = await TaskTool.create(createMinimalSession(overrides));
	return tool.execute(`call-${agent}`, {
		agent,
		tasks: [
			{
				id: `task-${agent}`,
				description: "test",
				assignment: "no-op",
			},
		],
	});
}

function collectText(result: Awaited<ReturnType<typeof executeWithAgent>>): string {
	return result.content
		.map(part => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

describe("orchestrator implementation-boundary spawn policy", () => {
	beforeEach(() => {
		runSubprocessAgents.length = 0;
	});

	for (const restrictedAgent of ["lint", "code-reviewer", "commit"] as const) {
		test(`blocks orchestrator parent from spawning ${restrictedAgent}`, async () => {
			const result = await executeWithAgent(restrictedAgent);
			const text = collectText(result);
			expect(text).toContain(`Cannot spawn '${restrictedAgent}' from orchestrator parent sessions`);
			expect(text).toContain("Delegate an 'implement' worker first");
			expect(runSubprocessAgents).toHaveLength(0);
		});
	}

	test("blocks orchestrator boundary when runtime role casing varies", async () => {
		const result = await executeWithAgent("commit", { getRuntimeRole: () => "  ORCHESTRATOR  " });
		const text = collectText(result);
		expect(text).toContain("Cannot spawn 'commit' from orchestrator parent sessions");
		expect(runSubprocessAgents).toHaveLength(0);
	});

	test("blocks forbidden orchestrator spawns before async scheduling", async () => {
		const asyncSettings = Settings.isolated({
			"task.isolation.mode": "none",
			"task.maxConcurrency": 4,
			"task.disabledAgents": [],
			"async.enabled": true,
		});
		const result = await executeWithAgent("lint", { settings: asyncSettings });
		const text = collectText(result);
		expect(text).toContain("Cannot spawn 'lint' from orchestrator parent sessions");
		expect(text).not.toContain("Async execution is enabled but no async job manager is available.");
		expect(runSubprocessAgents).toHaveLength(0);
	});

	test("allows orchestrator parent to delegate implementation-phase workers", async () => {
		const results = [
			await executeWithAgent("explore"),
			await executeWithAgent("research"),
			await executeWithAgent("implement"),
			await executeWithAgent("verifier"),
			await executeWithAgent("coderabbit"),
		];
		expect(runSubprocessAgents).toEqual(["explore", "research", "implement", "verifier", "coderabbit"]);
		for (const result of results) {
			const text = collectText(result);
			expect(text).not.toContain("orchestrator parent sessions");
			expect(text).not.toContain("Delegate an 'implement' worker first");
		}
	});

	test("does not block UI sessions when runtime role is unset", async () => {
		const result = await executeWithAgent("lint", { getRuntimeRole: undefined });
		expect(runSubprocessAgents).toEqual(["lint"]);
		const text = collectText(result);
		expect(text).not.toContain("Cannot spawn 'lint' from orchestrator parent sessions");
		expect(text).not.toContain("Delegate an 'implement' worker first");
	});

	test("allows implement sessions to spawn lint, review, and commit", async () => {
		const childSession = { hasUI: false, getRuntimeRole: () => "implement" };
		const results = [
			await executeWithAgent("lint", childSession),
			await executeWithAgent("code-reviewer", childSession),
			await executeWithAgent("commit", childSession),
		];
		expect(runSubprocessAgents).toEqual(["lint", "code-reviewer", "commit"]);
		for (const result of results) {
			const text = collectText(result);
			expect(text).not.toContain("orchestrator parent sessions");
			expect(text).not.toContain("Delegate an 'implement' worker first");
		}
	});
});

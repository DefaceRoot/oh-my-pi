import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import planModeExtension from "./index";

type ToolCallHandler = (
	event: { toolName: string; input?: Record<string, unknown> },
	ctx: ExtensionContext,
) => Promise<{ block: boolean; reason: string } | void> | { block: boolean; reason: string } | void;

type BeforeAgentStartHandler = (
	event: { systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt: string } | void> | { systemPrompt: string } | void;

function setupExtensionHandlers(): {
beforeAgentStart: BeforeAgentStartHandler;
toolCall: ToolCallHandler;
} {
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	let toolCall: ToolCallHandler | undefined;
	const extensionApi = {
		logger: {
			debug: () => {},
		},
		on: (eventName: string, handler: unknown) => {
			if (eventName === "before_agent_start") beforeAgentStart = handler as BeforeAgentStartHandler;
			if (eventName === "tool_call") toolCall = handler as ToolCallHandler;
		},
	} as unknown as ExtensionAPI;
	planModeExtension(extensionApi);
	if (!beforeAgentStart || !toolCall) {
		throw new Error("plan mode extension handlers are not registered");
	}
	return { beforeAgentStart, toolCall };
}

function createContext(entries: Array<Record<string, unknown>>): ExtensionContext {
	return {
		cwd: "/repo",
		sessionManager: {
			getEntries: () => entries as never,
			getArtifactsDir: () => "/tmp/agent-artifacts",
			getSessionId: () => "session-abc",
		},
	} as unknown as ExtensionContext;
}

describe("plan mode tool guardrails", () => {
	test("allows plan-file edits but blocks verifier-artifact writes in local:// plan sessions", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext([
			{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
			{ type: "model_change", role: "plan" },
		]);

		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const editDecision = await toolCall({ toolName: "edit", input: { path: "local://PLAN.md" } }, ctx);
		const writeDecision = await toolCall(
			{ toolName: "write", input: { path: "local://artifacts/plan-verifier/phase-1/run-1/verification.md" } },
			ctx,
		);

		expect(startResult?.systemPrompt).toContain("write and edit tools ONLY");
		expect(editDecision).toBeUndefined();
		expect(writeDecision).toEqual(expect.objectContaining({ block: true }));
		expect(writeDecision?.reason).toContain("active plan workspace");

	});

	test("allows plan-file edits but blocks verifier-artifact writes in repo-relative plan sessions", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext([
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/slug/plan.md" } },
			{ type: "model_change", role: "plan" },
		]);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const editDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/slug/plan.md" } },
			ctx,
		);
		const writeDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/slug/artifacts/plan-verifier/p1/run1/verification.md" } },
			ctx,
		);

		expect(editDecision).toBeUndefined();
		expect(writeDecision).toEqual(expect.objectContaining({ block: true }));
		expect(writeDecision?.reason).toContain("active plan workspace");

	});

	test("blocks edit and write outside active plan workspace", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext([
			{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
			{ type: "model_change", role: "plan" },
		]);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const editDecision = await toolCall({ toolName: "edit", input: { path: "/repo/outside.md" } }, ctx);
		const writeDecision = await toolCall({ toolName: "write", input: { path: "/repo/outside.md" } }, ctx);

		expect(editDecision).toEqual(expect.objectContaining({ block: true }));
		expect(editDecision?.reason).toContain("active plan workspace");
		expect(writeDecision).toEqual(expect.objectContaining({ block: true }));
		expect(writeDecision?.reason).toContain("active plan workspace");
	});

	test("keeps notebook blocked in plan mode", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext([
			{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
			{ type: "model_change", role: "plan" },
		]);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const decision = await toolCall({ toolName: "notebook", input: { path: "local://PLAN.md" } }, ctx);

		expect(decision).toEqual({ block: true, reason: "Plan mode blocks notebook edits." });
	});
});
import * as os from "node:os";
import * as path from "node:path";
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

type InputHandler = (
	event: { type: "input"; text: string; source: "interactive" | "rpc" | "extension" },
	ctx: ExtensionContext,
 ) => Promise<{ handled?: boolean; text?: string } | void> | { handled?: boolean; text?: string } | void;

function setupExtensionHandlers(entries: Array<Record<string, unknown>>): {
	beforeAgentStart: BeforeAgentStartHandler;
	toolCall: ToolCallHandler;
	input: InputHandler;
} {
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	let toolCall: ToolCallHandler | undefined;
	let input: InputHandler | undefined;
	const extensionApi = {
		logger: {
			debug: () => {},
		},
		on: (eventName: string, handler: unknown) => {
			if (eventName === "before_agent_start") beforeAgentStart = handler as BeforeAgentStartHandler;
			if (eventName === "tool_call") toolCall = handler as ToolCallHandler;
			if (eventName === "input") input = handler as InputHandler;
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	planModeExtension(extensionApi);
	if (!beforeAgentStart || !toolCall || !input) {
		throw new Error("plan mode extension handlers are not registered");
	}
	return { beforeAgentStart, toolCall, input };
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
	test("allows markdown writes inside the plans root but blocks verifier artifacts and non-markdown files", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/slug/plan.md" } },
			{ type: "model_change", role: "plan" },
		];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const nestedEditDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/slug/notes/research.md" } },
			ctx,
		);
		const siblingPlanWriteDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/another-slug/plan.md" } },
			ctx,
		);
		const verifierWriteDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/slug/artifacts/plan-verifier/p1/run1/verification.md" } },
			ctx,
		);
		const jsonWriteDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/slug/state.json" } },
			ctx,
		);

		expect(startResult?.systemPrompt).toContain("markdown files under `.omp/sessions/plans/`");
		expect(nestedEditDecision).toBeUndefined();
		expect(siblingPlanWriteDecision).toBeUndefined();
		expect(verifierWriteDecision).toEqual(expect.objectContaining({ block: true }));
		expect(verifierWriteDecision?.reason).toContain("plans root");
		expect(jsonWriteDecision).toEqual(expect.objectContaining({ block: true }));
		expect(jsonWriteDecision?.reason).toContain("markdown files");
	});

	test("rebinds the active plan file from explicit user input before prompting", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/manual/plan.md" } },
			{ type: "model_change", role: "plan" },
		];
		const { beforeAgentStart, toolCall, input } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		await input(
			{
				type: "input",
				text: "Review and update @.omp/sessions/plans/existing-plan/plan.md in place.",
				source: "interactive",
			},
			ctx,
		);
		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const reboundEditDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/existing-plan/notes/outline.md" } },
			ctx,
		);
		const outsideWriteDecision = await toolCall({ toolName: "write", input: { path: "/repo/outside.md" } }, ctx);

		expect(startResult?.systemPrompt).toContain(".omp/sessions/plans/existing-plan/plan.md");
		expect(reboundEditDecision).toBeUndefined();
		expect(outsideWriteDecision).toEqual(expect.objectContaining({ block: true }));
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "plan-mode/active-plan-file",
				data: expect.objectContaining({
					planFilePath: ".omp/sessions/plans/existing-plan/plan.md",
				}),
			}),
		);
	});

	test("rebinds the active plan file when user input points at an existing plan with a ~/ path", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/manual/plan.md" } },
			{ type: "model_change", role: "plan" },
		];
		const { beforeAgentStart, toolCall, input } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);
		const externalPlanPath = path.join(
			os.homedir(),
			"devpod-repos",
			"DefaceRoot",
			"CISEN-Dashboard",
			".omp",
			"sessions",
			"plans",
			"existing-plan",
			"plan.md",
		);
		const tildePlanPath = `~${externalPlanPath.slice(os.homedir().length)}`;

		await input(
			{
				type: "input",
				text: `Review and update @${tildePlanPath} in place.`,
				source: "interactive",
			},
			ctx,
		);
		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const reboundEditDecision = await toolCall(
			{ toolName: "edit", input: { path: tildePlanPath.replace(/plan\.md$/, "notes/research.md") } },
			ctx,
		);
		const absoluteWriteDecision = await toolCall(
			{ toolName: "write", input: { path: externalPlanPath } },
			ctx,
		);

		expect(startResult?.systemPrompt).toContain(externalPlanPath);
		expect(reboundEditDecision).toBeUndefined();
		expect(absoluteWriteDecision).toBeUndefined();
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "plan-mode/active-plan-file",
				data: expect.objectContaining({
					planFilePath: externalPlanPath,
				}),
			}),
		);
	});

	test("keeps the rebound plan file after resume re-enters plan mode", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/manual/plan.md" } },
			{ type: "model_change", role: "plan" },
			{
				type: "custom",
				customType: "plan-mode/active-plan-file",
				data: { planFilePath: ".omp/sessions/plans/existing-plan/plan.md", reason: "user-input" },
			},
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/manual/plan.md" } },
		];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const reboundEditDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/existing-plan/notes/outline.md" } },
			ctx,
		);
		const sameRootWriteDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/manual/notes/outline.md" } },
			ctx,
		);

		expect(startResult?.systemPrompt).toContain(".omp/sessions/plans/existing-plan/plan.md");
		expect(reboundEditDecision).toBeUndefined();
		expect(sameRootWriteDecision).toBeUndefined();
	});


	test("bootstraps the active plan file from the first canonical plan write when no mode_change entry exists", async () => {
		const entries = [{ type: "model_change", role: "plan" }];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const initialWriteDecision = await toolCall(
			{ toolName: "write", input: { path: ".omp/sessions/plans/new-customer-deploy-wizard/plan.md" } },
			ctx,
		);
		const nestedEditDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/new-customer-deploy-wizard/notes/research.md" } },
			ctx,
		);

		expect(initialWriteDecision).toBeUndefined();
		expect(nestedEditDecision).toBeUndefined();
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "plan-mode/active-plan-file",
				data: expect.objectContaining({
					planFilePath: ".omp/sessions/plans/new-customer-deploy-wizard/plan.md",
					reason: "tool-path",
				}),
			}),
		);
	});

	test("infers the active plan file from recent canonical plan references when mode_change entries are absent", async () => {
		const entries = [
			{ type: "model_change", role: "plan" },
			{
				type: "custom",
				customType: "implementation-engine/plan-new-metadata",
				data: {
					planFilePath: ".omp/sessions/plans/new-customer-deploy-wizard/plan.md",
				},
			},
		];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		const startResult = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const nestedEditDecision = await toolCall(
			{ toolName: "edit", input: { path: ".omp/sessions/plans/new-customer-deploy-wizard/notes/research.md" } },
			ctx,
		);

		expect(startResult?.systemPrompt).toContain(".omp/sessions/plans/new-customer-deploy-wizard/plan.md");
		expect(nestedEditDecision).toBeUndefined();
	});


	test("blocks edit and write outside the plans root", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/slug/plan.md" } },
			{ type: "model_change", role: "plan" },
		];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const editDecision = await toolCall({ toolName: "edit", input: { path: "/repo/outside.md" } }, ctx);
		const writeDecision = await toolCall({ toolName: "write", input: { path: "/repo/outside.md" } }, ctx);

		expect(editDecision).toEqual(expect.objectContaining({ block: true }));
		expect(editDecision?.reason).toContain("plans root");
		expect(writeDecision).toEqual(expect.objectContaining({ block: true }));
		expect(writeDecision?.reason).toContain("plans root");
	});

	test("keeps notebook blocked in plan mode", async () => {
		const entries = [
			{ type: "mode_change", mode: "plan", data: { planFilePath: ".omp/sessions/plans/slug/plan.md" } },
			{ type: "model_change", role: "plan" },
		];
		const { beforeAgentStart, toolCall } = setupExtensionHandlers(entries);
		const ctx = createContext(entries);

		await beforeAgentStart({ systemPrompt: "base" }, ctx);
		const decision = await toolCall({ toolName: "notebook", input: { path: ".omp/sessions/plans/slug/plan.md" } }, ctx);

		expect(decision).toEqual({ block: true, reason: "Plan mode blocks notebook edits." });
	});
});

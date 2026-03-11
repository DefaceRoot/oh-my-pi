import { describe, expect, test } from "bun:test";
import worktreePolicyExtension, { _testExports } from "./index";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type ToolCallHandler = (
	event: { toolName: string; input?: Record<string, unknown> },
	ctx: ExtensionContext,
) => Promise<{ block: boolean; reason: string } | void> | { block: boolean; reason: string } | void;

type BeforeAgentStartHandler = (
	event: { systemPrompt: string; prompt?: string },
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
			warn: () => {},
		},
		on: (eventName: string, handler: unknown) => {
			if (eventName === "before_agent_start") beforeAgentStart = handler as BeforeAgentStartHandler;
			if (eventName === "tool_call") toolCall = handler as ToolCallHandler;
		},
	} as unknown as ExtensionAPI;
	worktreePolicyExtension(extensionApi);
	if (!beforeAgentStart || !toolCall) {
		throw new Error("worktree policy extension handlers are not registered");
	}
	return { beforeAgentStart, toolCall };
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("worktree-policy helpers", () => {
	test("detects explicit worktree requests without false-positive complaint text", () => {
		expect(_testExports.detectExplicitWorktreeRequest("create a worktree for this change")).toBe(true);
		expect(_testExports.detectExplicitWorktreeRequest("please use a worktree and continue there")).toBe(true);
		expect(
			_testExports.detectExplicitWorktreeRequest(
				"Why are agents using isolated worktrees when never directed to do so?",
			),
		).toBe(false);
	});

	test("detects git worktree roots by .git file vs main repo .git directory", async () => {
		const rootMode = await _testExports.detectCheckoutMode("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");
		expect(rootMode).toBe("repo");

		const worktreeDir = "/tmp/omp-worktree-policy-test";
		await Bun.write(`${worktreeDir}/.git`, "gitdir: /tmp/main/.git/worktrees/test\n");
		const worktreeMode = await _testExports.detectCheckoutMode(worktreeDir);
		expect(worktreeMode).toBe("worktree");
	});
});

describe("worktree-policy extension", () => {
	test("injects a no-worktree guard in ordinary sessions", async () => {
		const { beforeAgentStart } = setupExtensionHandlers();
		const ctx = createContext("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");

		const result = await beforeAgentStart(
			{ systemPrompt: "base system prompt", prompt: "fix the footer click bug" },
			ctx,
		);

		expect(result?.systemPrompt).toContain("MUST NOT create or switch to a new git worktree");
		expect(result?.systemPrompt).toContain("Do NOT spawn `worktree-setup`");
	});

	test("blocks worktree setup and isolated task mode without explicit request", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");

		await beforeAgentStart({ systemPrompt: "base system prompt", prompt: "fix the footer click bug" }, ctx);

		const worktreeSetupDecision = await toolCall(
			{ toolName: "task", input: { agent: "worktree-setup" } },
			ctx,
		);
		const isolatedDecision = await toolCall(
			{ toolName: "task", input: { agent: "implement", isolated: true } },
			ctx,
		);
		const bashDecision = await toolCall(
			{ toolName: "bash", input: { command: "git worktree add ../tmp-branch -b tmp-branch" } },
			ctx,
		);

		expect(worktreeSetupDecision).toEqual(expect.objectContaining({ block: true }));
		expect(worktreeSetupDecision?.reason).toContain("user did not explicitly request a worktree");
		expect(isolatedDecision).toEqual(expect.objectContaining({ block: true }));
		expect(isolatedDecision?.reason).toContain("isolated task workspaces");
		expect(bashDecision).toEqual(expect.objectContaining({ block: true }));
		expect(bashDecision?.reason).toContain("git worktree add");
	});

	test("allows worktree operations when the user explicitly asks", async () => {
		const { beforeAgentStart, toolCall } = setupExtensionHandlers();
		const ctx = createContext("/home/colin/devpod-repos/DefaceRoot/oh-my-pi");

		const result = await beforeAgentStart(
			{ systemPrompt: "base system prompt", prompt: "create and use a worktree for this task" },
			ctx,
		);
		const worktreeSetupDecision = await toolCall(
			{ toolName: "task", input: { agent: "worktree-setup" } },
			ctx,
		);
		const bashDecision = await toolCall(
			{ toolName: "bash", input: { command: "git worktree add ../tmp-branch -b tmp-branch" } },
			ctx,
		);

		expect(result).toBeUndefined();
		expect(worktreeSetupDecision).toBeUndefined();
		expect(bashDecision).toBeUndefined();
	});
});

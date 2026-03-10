import { describe, expect, test } from "bun:test";
import {
	RESUME_AGENT_MODE_STYLES,
	extractLastResumeAgentMode,
	resolveResumeAgentMode,
} from "./resume-agent-mode.ts";

describe("resume agent mode detection", () => {
	test("recognizes all main agent roles from model_change entries", () => {
		const cases = [
			{ role: undefined, expected: "default" },
			{ role: "default", expected: "default" },
			{ role: "ask", expected: "ask" },
			{ role: "orchestrator", expected: "orchestrator" },
			{ role: "plan", expected: "plan" },
		] as const;

		for (const { role, expected } of cases) {
			const lines = [
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
				JSON.stringify({ type: "model_change", model: "anthropic/claude-opus-4-6", role }),
			];
			expect(extractLastResumeAgentMode(lines)).toBe(expected);
		}
	});

	test("treats non-main model roles as unknown instead of misclassifying them from message text", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "You are in Orchestrator mode in this worktree." }] } }),
			JSON.stringify({ type: "model_change", model: "openai/gpt-5", role: "implement" }),
		];

		expect(extractLastResumeAgentMode(lines)).toBeNull();
		expect(
			resolveResumeAgentMode({
				sessionLines: lines,
				allMessagesText: "You are in Orchestrator mode in this worktree.",
			}),
		).toBe("unknown");
	});

	test("falls back to legacy text detection when a session has no model_change entry", () => {
		expect(resolveResumeAgentMode({ allMessagesText: "Plan mode enabled. Plan file: docs/plans/demo.md" })).toBe("plan");
		expect(resolveResumeAgentMode({ allMessagesText: "Ask mode is read-only." })).toBe("ask");
	});
});

describe("resume agent mode styles", () => {
	test("matches the status-line labels and colors for main agents", () => {
		expect(RESUME_AGENT_MODE_STYLES.default).toEqual({ label: "Default", color: "success" });
		expect(RESUME_AGENT_MODE_STYLES.ask).toEqual({ label: "Ask", color: "statusLineSubagents" });
		expect(RESUME_AGENT_MODE_STYLES.orchestrator).toEqual({ label: "Orchestrator", color: "warning" });
		expect(RESUME_AGENT_MODE_STYLES.plan).toEqual({ label: "Plan", color: "error" });
		expect(RESUME_AGENT_MODE_STYLES.unknown).toEqual({ label: "unknown", color: "dim" });
	});
});

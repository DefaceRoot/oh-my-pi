import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { findLastAssistantWithUsageAfterRewindReport } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";

function assistantMessage(usage: AssistantMessage["usage"], overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function rewindReportMessage(): AgentMessage {
	return {
		role: "custom",
		customType: "rewind-report",
		content: "rewind summary",
		display: false,
		details: {},
		attribution: "agent",
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("findLastAssistantWithUsageAfterRewindReport", () => {
	it("returns the latest valid assistant after the rewind barrier", () => {
		const beforeBarrier = assistantMessage({
			input: 1000,
			output: 200,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const afterBarrierValid = assistantMessage({
			input: 40,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const afterBarrierAborted = assistantMessage(
			{
				input: 500,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			{ stopReason: "aborted" },
		);

		const result = findLastAssistantWithUsageAfterRewindReport([
			beforeBarrier,
			rewindReportMessage(),
			afterBarrierValid,
			afterBarrierAborted,
		]);

		expect(result).toBe(afterBarrierValid);
	});

	it("returns undefined when no assistant exists after rewind barrier", () => {
		const result = findLastAssistantWithUsageAfterRewindReport([
			assistantMessage({
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
			rewindReportMessage(),
		]);

		expect(result).toBeUndefined();
	});

	it("falls back to latest assistant when no rewind barrier exists", () => {
		const olderAssistant = assistantMessage({
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const newerAssistant = assistantMessage({
			input: 200,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 240,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		const result = findLastAssistantWithUsageAfterRewindReport([olderAssistant, newerAssistant]);
		expect(result).toBe(newerAssistant);
	});
});

import { describe, expect, test } from "bun:test";
import type { SidebarModel } from "./model";
import { renderSidebar } from "./render";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const FULL_MODEL: SidebarModel = {
	width: 38,
	tokens: { contextUsedPercent: 67, tokensUsed: 25_000, tokensTotal: 40_000, costUsd: 0.42 },
	mcpServers: [
		{ name: "augment", connected: true },
		{ name: "better-context", connected: true },
		{ name: "chrome-devtools", connected: false },
	],
	lspServers: [
		{ name: "typescript", active: true },
		{ name: "eslint", active: false },
	],
	todos: [
		{ id: "1", content: "Add unit tests", status: "completed" },
		{ id: "2", content: "Fix the thing", status: "in_progress" },
		{ id: "3", content: "Review PR", status: "pending" },
		{ id: "4", content: "Old task", status: "abandoned" },
	],
	subagents: [
		{ id: "a1", agentName: "implement", status: "completed", description: "Add sidebar" },
		{ id: "a2", agentName: "lint", status: "running", description: "Run lint" },
	],
	modifiedFiles: [
		{ path: "packages/coding-agent/src/modes/interactive-mode.ts", status: "M" },
		{ path: "packages/coding-agent/src/modes/components/sidebar/model.ts", status: "A" },
		{ path: "src/old-file.ts", status: "D" },
	],
};

describe("sidebar perf", () => {
	test("renderSidebar completes 1000 iterations in under 5000ms (5ms each)", () => {
		const iterations = 1000;
		const budget = 5000;
		const start = performance.now();
		for (let i = 0; i < iterations; i += 1) {
			renderSidebar(FULL_MODEL);
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(budget);
	});

	test("rendered sidebar lines are all within width constraint", () => {
		const lines = renderSidebar(FULL_MODEL);
		for (const line of lines) {
			const stripped = line.replace(ANSI_PATTERN, "");
			expect(stripped.length).toBeLessThanOrEqual(FULL_MODEL.width);
		}
	});
});

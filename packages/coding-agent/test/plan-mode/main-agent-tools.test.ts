import { describe, expect, it } from "bun:test";
import {
	mergePlanModeMainAgentTools,
	PLAN_MODE_MAIN_AGENT_REQUIRED_TOOLS,
} from "../../src/plan-mode/main-agent-tools";

describe("PLAN_MODE_MAIN_AGENT_REQUIRED_TOOLS", () => {
	it("requires write edit and exit for plan authoring", () => {
		expect(PLAN_MODE_MAIN_AGENT_REQUIRED_TOOLS).toEqual(["write", "edit", "exit_plan_mode"]);
	});
});

describe("mergePlanModeMainAgentTools", () => {
	it("adds missing plan-authoring tools when they are available", () => {
		const merged = mergePlanModeMainAgentTools(["read", "grep"], toolName =>
			["write", "edit", "exit_plan_mode"].includes(toolName),
		);

		expect(merged).toEqual(["read", "grep", "write", "edit", "exit_plan_mode"]);
	});

	it("preserves existing order and skips unavailable tools", () => {
		const merged = mergePlanModeMainAgentTools(["read", "write", "ask"], toolName =>
			["write", "edit"].includes(toolName),
		);

		expect(merged).toEqual(["read", "write", "ask", "edit"]);
	});
});

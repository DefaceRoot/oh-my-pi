import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeReferencePrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-reference.md" with {
	type: "text",
};
import planModeSubagentPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-subagent.md" with {
	type: "text",
};

describe("plan-mode-reference prompt", () => {
	it("keeps prior-plan context lean and path-oriented", () => {
		const rendered = renderPromptTemplate(planModeReferencePrompt, {
			planFilePath: "local://PLAN.md",
			planContent: "SENTINEL_PLAN_BODY",
		});

		expect(rendered).toContain("local://PLAN.md");
		expect(rendered).toContain("inspect `local://PLAN.md` directly");
		expect(rendered).toContain("delegate a focused read/review task only if needed");
		expect(rendered).toContain("You **MUST NOT** inline the full plan body into parent context");
		expect(rendered).not.toContain("SENTINEL_PLAN_BODY");
		expect(rendered).not.toContain("Plan contents");
	});
});

describe("plan-mode-subagent prompt", () => {
	it("directs delegated subagents to review assigned plan artifacts first", () => {
		expect(planModeSubagentPrompt).toContain("If assignment/context includes prior-plan artifacts");
		expect(planModeSubagentPrompt).toContain("you **MUST** read them first");
	});
});

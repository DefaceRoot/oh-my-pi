import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeApprovedPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-approved.md" with {
	type: "text",
};

describe("plan-mode-approved prompt", () => {
	it("includes final plan artifact path and enforces parallel-safety rechecks during execution", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: ".omp/sessions/plans/manual/plan.md",
		});

		expect(rendered).toContain(".omp/sessions/plans/manual/plan.md");
		expect(rendered).toContain("explicit unit dependencies");
		expect(rendered).toContain("`Parallel safety` assumptions against current repo state");
		expect(rendered).toContain("fall back to sequential execution");
	});
});

import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeActivePrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-active.md" with { type: "text" };

describe("plan-mode-active prompt", () => {
	it("requires parallel-first unit planning and safety verification detail", () => {
		const rendered = renderPromptTemplate(planModeActivePrompt, {
			planExists: true,
			planFilePath: ".omp/sessions/plans/manual/plan.md",
			editToolName: "edit",
			writeToolName: "write",
			exitToolName: "exit_plan_mode",
			askToolName: "ask",
			askToolAvailable: true,
			askDisabledReason: "",
			askAvailabilityLabel: "ask",
			askToolSupportNote: "",
			askToolRecommendation: "",
			findToolName: "find",
			grepToolName: "grep",
			readToolName: "read",
			astGrepToolName: "ast_grep",
			lspToolName: "lsp",
			fetchToolName: "fetch",
			webSearchToolName: "web_search",
			askToolLabel: "ask",
			askUsageHint: "",
			askParallelHint: "",
			askSequentialHint: "",
			askEdgeCaseHint: "",
			askWarningHint: "",
			askAvailabilityHint: "",
			taskDisabledHint: "",
			askUnavailableHint: "",
			askFallbackHint: "",
			askToolMessage: "",
			askToolSuffix: "",
			askToolNote: "",
			askToolReminder: "",
			askToolDirective: "",
			askToolSupport: "",
			askToolAdvice: "",
			askToolConstraint: "",
			askToolRequirement: "",
			askToolGuidance: "",
			askToolInstruction: "",
			askToolExpectation: "",
			askToolCue: "",
			askToolStatus: "",
			askToolContext: "",
			iterative: true,
			reentry: false,
		});

		expect(rendered).toContain("parallel-first grouping before sequential follow-on work");
		expect(rendered).toContain("`Verification`: end-to-end checks plus safety checks");
		expect(rendered).toContain("`Parallel safety` and verification independence are explicit");
	});
});

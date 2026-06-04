import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };

function render(overrides: Record<string, unknown> = {}): string {
	return prompt.render(planModeActivePrompt, {
		askToolName: "ask",
		writeToolName: "write",
		editToolName: "edit",
		planFilePath: "local://plan.md",
		planExists: false,
		reentry: false,
		iterative: false,
		persistToRepo: false,
		...overrides,
	});
}

describe("plan-mode-active prompt render contract", () => {
	it("default non-persist render contains planning guidance without Linear integration", () => {
		const out = render({ persistToRepo: false, iterative: false });

		expect(out).toContain("10");
		expect(out).toContain("tdd-red");
		expect(out).toContain("reviewer");
		expect(out).toContain("Acceptance criteria");
		expect(out).toContain("Tracer-bullet");
		expect(out).toContain("Bucket");
		expect(out).not.toContain("Linear");
		expect(out).not.toContain("plan-to-linear");
	});

	it("persistToRepo:true render contains repo-backed plan guidance", () => {
		const out = render({ persistToRepo: true });

		expect(out).toContain(".plans/");
		expect(out).toContain("kebab-case");
		expect(out).toMatch(/max.{0,5}three.{0,5}word/i);
	});

	it("iterative:true renders the Iterative Planning branch", () => {
		const out = render({ iterative: true });

		expect(out).toContain("Iterative Planning");
	});
});

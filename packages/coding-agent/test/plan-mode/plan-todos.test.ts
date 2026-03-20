import { describe, expect, it } from "bun:test";
import { buildPlanTodoBootstrapData, parsePlanToTodoPhases } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-todos";

const standardPlan = [
	"# Example Plan",
	"",
	"## Phased Implementation Plan",
	"",
	"### Phase 1 — Bootstrap",
	"**Goal:** Prepare plan parsing.",
	"",
	"#### Unit 1.1: Parse headings",
	"**Depends on:** None",
	"",
	"#### 1.2 — Wire session bootstrap (P)",
	"**Depends on:** Unit 1.1",
	"",
	"### Phase 2 — Validation",
	"**Goal:** Keep manual fallback available.",
].join("\n");

const incompletePlan = [
	"# Example Plan",
	"",
	"## Phased Implementation Plan",
	"",
	"### Phase 1 — Bootstrap",
	"**Goal:** Prepare plan parsing.",
	"",
	"#### Notes",
	"Document constraints.",
	"",
	"#### Risks",
	"Capture fallback behavior.",
	"",
	"#### Unit 1.1: Parse headings",
	"**Depends on:** None",
].join("\n");

const planWithDuplicatePhaseNumberOutsidePlanSection = [
	"# Example Plan",
	"",
	"### Phase 1 — Outside Section",
	"**Goal:** Ignore this heading.",
	"",
	"## Phased Implementation Plan",
	"",
	"### Phase 1 — Bootstrap",
	"**Goal:** Use this heading.",
	"",
	"### Phase 2 — Validation",
	"**Goal:** Keep this heading.",
].join("\n");

describe("plan todo parsing", () => {
	it("parses standard and variant unit headings into todo phases", () => {
		const result = parsePlanToTodoPhases(standardPlan);

		expect(result.fallbackReason).toBeUndefined();
		expect(result.totalUnitHeadings).toBe(2);
		expect(result.extractedUnitTasks).toBe(2);
		expect(result.phases).toEqual([
			{
				name: "Phase 1 — Bootstrap",
				tasks: [
					{ content: "Unit 1.1: Parse headings", notes: "Depends on: None" },
					{ content: "1.2: Wire session bootstrap (P)", notes: "Depends on: Unit 1.1" },
				],
			},
			{
				name: "Phase 2 — Validation",
				tasks: [{ content: "Keep manual fallback available." }],
			},
		]);
	});

	it("keeps in-section phase headings when duplicate phase numbers exist outside the selected plan section", () => {
		const result = parsePlanToTodoPhases(planWithDuplicatePhaseNumberOutsidePlanSection);

		expect(result.fallbackReason).toBeUndefined();
		expect(result.phases).toEqual([
			{ name: "Phase 1 — Bootstrap", tasks: [{ content: "Use this heading." }] },
			{ name: "Phase 2 — Validation", tasks: [{ content: "Keep this heading." }] },
		]);
	});

	it("refuses bootstrap data when fewer than half of level-four headings become todo tasks", () => {
		const result = parsePlanToTodoPhases(incompletePlan);

		expect(result.totalUnitHeadings).toBe(3);
		expect(result.extractedUnitTasks).toBe(1);
		expect(result.fallbackReason).toContain("fewer than half");
		expect(buildPlanTodoBootstrapData(incompletePlan, ".omp/sessions/plans/example/plan.md")).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "../../src/task/render";
import type { TaskToolDetails } from "../../src/task/types";

describe("taskToolRenderer report_finding safety", () => {
	it("renders progress without crashing when report_finding payload is malformed", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 42,
			progress: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					status: "running",
					task: "Review patch",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					tokens: 0,
					durationMs: 42,
					extractedToolData: {
						report_finding: [{}],
					},
				},
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		expect(() => rendered.render(120)).not.toThrow();
	});

	it("renders abort reason inline for aborted subagent results", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					task: "Review patch",
					exitCode: 1,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 42,
					tokens: 0,
					aborted: true,
					abortReason: "blocked by permissions",
				},
			],
			totalDurationMs: 42,
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const lines = rendered.render(120);
		expect(lines.join("\n")).toContain("blocked by permissions");
	});

	it("renders user-stopped aborts with a distinct label", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "2-PlanVerifier",
					agent: "plan-verifier",
					agentSource: "bundled",
					task: "Verify phase 7",
					exitCode: 1,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 42,
					tokens: 0,
					aborted: true,
					abortReason: "User stopped: waiting on reviewer input",
				},
			],
			totalDurationMs: 42,
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const text = rendered.render(120).join("\n");
		expect(text).toContain("user stopped");
		expect(text).toContain("waiting on reviewer input");
	});

	it("renders running progress with per-session elapsed time and outcome badges", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 65_000,
			progress: [
				{
					index: 0,
					id: "3-Lint",
					agent: "lint",
					agentSource: "bundled",
					status: "running",
					task: "Run lint over the coding-agent package",
					recentTools: [],
					recentOutput: [],
					toolCount: 3,
					tokens: 1_250,
					durationMs: 65_000,
					outcome: {
						status: "pass",
						label: "lint",
						summary: "No lint violations found",
					},
				},
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		const text = rendered.render(140).join("\n");
		expect(text).toContain("1m5s");
		expect(text).toContain("PASS");
		expect(text).toContain("No lint violations found");
	});

	it("renders final results with deterministic outcome badges", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "4-CodeReview",
					agent: "code-reviewer",
					agentSource: "bundled",
					task: "Review the subagent modal changes",
					exitCode: 0,
					output: "Review completed",
					stderr: "",
					truncated: false,
					durationMs: 42_000,
					tokens: 900,
					outcome: {
						status: "fail",
						label: "review",
						summary: "Two blocking findings remain",
					},
				},
			],
			totalDurationMs: 42_000,
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const text = rendered.render(140).join("\n");
		expect(text).toContain("FAIL");
		expect(text).toContain("Two blocking findings remain");
	});
	it("renders mixed-agent calls and tolerates partial task arguments", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const partialCall = taskToolRenderer.renderCall(
			{ agent: "designer" } as never,
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		expect(() => partialCall.render(120)).not.toThrow();

		const mixedCall = taskToolRenderer.renderCall(
			{
				tasks: [
					{ id: "DesignNav", agent: "designer", description: "Design navigation", assignment: "Review navigation layout." },
					{ id: "ResearchDom", agent: "research", description: "Research DOM contract", assignment: "Inspect sidebar DOM expectations." },
				],
			} as never,
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const mixedText = mixedCall.render(140).join("\n");
		expect(mixedText).toContain("designer");
		expect(mixedText).toContain("research");
	});


});

import { beforeAll, describe, expect, test } from "bun:test";
import {
	buildTokenGauge,
	type DetailPaneAction,
	SubagentDetailPane,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-detail-pane";
import type { SubagentViewRef } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function renderText(pane: SubagentDetailPane, width = 80): string {
	return Bun.stripANSI(pane.render(width).join("\n"));
}

function renderGaugeText(tokens: number, capacity: number | undefined): string {
	return Bun.stripANSI(buildTokenGauge(tokens, capacity));
}

function makeFullRef(overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id: "abc-research-001",
		agent: "research",
		description: "Research best practices for TUI modal design",
		model: "claude-sonnet-4-20250514",
		tokens: 12_450,
		tokenCapacity: 200_000,
		status: "running",
		thinkingLevel: "medium",
		startedAt: Date.now() - 134_000,
		elapsedMs: 134_000,
		lastUpdatedMs: Date.now() - 2_000,
		sessionId: "abc123-def456-ghi789-jkl012",
		parentAgentName: "orchestrator",
		depth: 2,
		assignmentPreview:
			"Research best practices for TUI\nmodal design patterns from mature\ntools like lazygit, k9s, btop.\nFocus on split-pane layouts.",
		...overrides,
	};
}

describe("SubagentDetailPane", () => {
	beforeAll(() => {
		initTheme();
	});

	describe("identity section", () => {
		test("renders agent name in bold accent", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Agent: research");
		});

		test("renders status with glyph and uppercase label", () => {
			const pane = new SubagentDetailPane(makeFullRef({ status: "running" }));
			const text = renderText(pane);
			expect(text).toContain("● RUNNING");
		});

		test("renders all status variants", () => {
			const statuses = [
				{ status: "running" as const, expected: "● RUNNING" },
				{ status: "completed" as const, expected: "◉ COMPLETED" },
				{ status: "failed" as const, expected: "✗ FAILED" },
				{ status: "pending" as const, expected: "◌ PENDING" },
				{ status: "cancelled" as const, expected: "⊘ CANCELLED" },
			];

			for (const { status, expected } of statuses) {
				const pane = new SubagentDetailPane(makeFullRef({ status }));
				const text = renderText(pane);
				expect(text).toContain(expected);
			}
		});

		test("renders description when present", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Research best practices for TUI modal design");
		});

		test("falls back to id when agent name is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ agent: undefined }));
			const text = renderText(pane);
			expect(text).toContain("Agent: abc-research-001");
		});
	});

	describe("model section", () => {
		test("renders model name", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("claude-sonnet-4-20250514");
		});

		test("renders thinking level", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Thinking: medium");
		});

		test("omits model section entirely when both model and thinkingLevel are missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ model: undefined, thinkingLevel: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Model");
			expect(text).not.toContain("Thinking:");
		});
	});

	describe("token gauge section", () => {
		test("renders gauge bar with percentage when capacity is set", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: 12_450, tokenCapacity: 200_000 }));
			const text = renderText(pane);
			expect(text).toContain("Tokens");
			expect(text).toContain("12.4k / 200.0k");
			expect(text).toContain("%");
		});

		test("renders just token count when capacity is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: 5000, tokenCapacity: undefined }));
			const text = renderText(pane);
			expect(text).toContain("5.0k");
			expect(text).not.toContain("░");
		});

		test("omits token section when tokens are undefined", () => {
			const pane = new SubagentDetailPane(makeFullRef({ tokens: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Tokens");
		});
	});

	describe("token gauge boundary cases", () => {
		test("0% gauge — all empty blocks", () => {
			const gauge = renderGaugeText(0, 200_000);
			// 0 tokens means ratio=0, filled=0
			expect(gauge).toContain("░░░░░░░░░░░░░░░░");
			expect(gauge).toContain("0.0%");
			expect(gauge).toContain("0 / 200.0k");
		});

		test("50% gauge — half filled, half empty", () => {
			const gauge = renderGaugeText(100_000, 200_000);
			expect(gauge).toContain("████████░░░░░░░░");
			expect(gauge).toContain("50.0%");
			expect(gauge).toContain("100.0k / 200.0k");
		});

		test("100% gauge — all filled blocks", () => {
			const gauge = renderGaugeText(200_000, 200_000);
			expect(gauge).toContain("████████████████");
			expect(gauge).not.toContain("░");
			expect(gauge).toContain("100.0%");
		});

		test("exceeds capacity — clamped to 100%", () => {
			const gauge = renderGaugeText(300_000, 200_000);
			expect(gauge).toContain("████████████████");
			expect(gauge).toContain("100.0%");
		});

		test("zero capacity — falls back to plain count", () => {
			const gauge = renderGaugeText(5000, 0);
			expect(gauge).toContain("5.0k");
			expect(gauge).not.toContain("░");
			expect(gauge).not.toContain("█");
		});

		test("small token count — uses raw number, not k suffix", () => {
			const gauge = renderGaugeText(42, 1000);
			expect(gauge).toContain("42 / 1.0k");
		});

		test("million-scale tokens — uses M suffix", () => {
			const gauge = renderGaugeText(1_500_000, 2_000_000);
			expect(gauge).toContain("1.5M / 2.0M");
		});
	});

	describe("timing section", () => {
		test("renders elapsed duration in mm:ss", () => {
			const pane = new SubagentDetailPane(makeFullRef({ elapsedMs: 134_000 }));
			const text = renderText(pane);
			expect(text).toContain("Elapsed:");
			expect(text).toContain("02:14");
		});

		test("renders started time", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Started:");
		});

		test("renders age", () => {
			const pane = new SubagentDetailPane(makeFullRef({ lastUpdatedMs: Date.now() - 120_000 }));
			const text = renderText(pane);
			expect(text).toContain("Age:");
			expect(text).toContain("2m ago");
		});

		test("omits timing section when all timing fields are missing", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({ elapsedMs: undefined, startedAt: undefined, lastUpdatedMs: undefined }),
			);
			const text = renderText(pane);
			expect(text).not.toContain("Timing");
			expect(text).not.toContain("Elapsed:");
		});
	});

	describe("session context section", () => {
		test("renders session ID truncated to 16 chars", () => {
			const pane = new SubagentDetailPane(makeFullRef({ sessionId: "abc123-def456-ghi789-jkl012" }));
			const text = renderText(pane);
			expect(text).toContain("ID:");
			expect(text).toContain("abc123-def456-gh...");
		});

		test("renders short session ID untruncated", () => {
			const pane = new SubagentDetailPane(makeFullRef({ sessionId: "abc123" }));
			const text = renderText(pane);
			expect(text).toContain("abc123");
			expect(text).not.toContain("...");
		});

		test("renders parent agent name", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Parent:");
			expect(text).toContain("orchestrator");
		});

		test("renders depth", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Depth:");
			expect(text).toContain("2");
		});

		test("renders parent session id and enabled MCP servers", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({
					parentSessionId: "root-session-1234",
					mcpServers: ["augment", "github"],
				}),
			);
			const text = renderText(pane);
			expect(text).toContain("Parent Session:");
			expect(text).toContain("root-session-1234");
			expect(text).toContain("MCP:");
			expect(text).toContain("augment, github");
		});

		test("omits session section when all context fields are missing", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({
					sessionId: undefined,
					parentSessionId: undefined,
					parentAgentName: undefined,
					depth: undefined,
					mcpServers: undefined,
				}),
			);
			const text = renderText(pane);
			expect(text).not.toContain("Session");
			expect(text).not.toContain("Parent:");
			expect(text).not.toContain("Depth:");
		});
	});

	describe("delegation section", () => {
		const DELEGATION_FIELDS: Partial<SubagentViewRef> = {
			taskTitle: "Build TOON delegation builder",
			taskId: "task-2",
			taskIntent: "Implement the core builder module",
			delegatorRole: "orchestrator",
			delegateRole: "implement",
			inputProfile: "detailed",
			planPath: "/repo/.omp/sessions/plans/toon/plan.md",
			repoRoot: "/repo/oh-my-pi",
			branch: "feature/toon-delegation",
			worktreePath: "/repo/.worktrees/feature-toon",
			envelopeId: "del_f1a2b3c4d5e6",
			parentEnvelopeId: "del_4a9b2c1e8f3d",
		};

		test("renders full delegation section with all fields populated", () => {
			const pane = new SubagentDetailPane(makeFullRef(DELEGATION_FIELDS));
			const text = renderText(pane);

			expect(text).toContain("Delegation");
			expect(text).toContain("Task:");
			expect(text).toContain("Build TOON delegation builder");
			expect(text).toContain("ID:");
			expect(text).toContain("task-2");
			expect(text).toContain("Intent:");
			expect(text).toContain("Implement the core builder module");
			expect(text).toContain("orchestrator");
			expect(text).toContain("implement");
			expect(text).toContain("Profile:");
			expect(text).toContain("detailed");
			expect(text).toContain("Plan:");
			expect(text).toContain("/repo/.omp/sessions/plans/toon/plan.md");
			expect(text).toContain("Repo:");
			expect(text).toContain("/repo/oh-my-pi");
			expect(text).toContain("Branch:");
			expect(text).toContain("feature/toon-delegation");
			expect(text).toContain("Worktree:");
			expect(text).toContain("/repo/.worktrees/feature-toon");
			expect(text).toContain("Envelope:");
			expect(text).toContain("del_f1a2b3c4d5e6");
			expect(text).toContain("del_4a9b2c1e8f3d");
		});

		test("omits delegation section entirely when no delegation fields are set", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).not.toContain("Delegation");
			expect(text).not.toContain("Task:");
			expect(text).not.toContain("Quality:");
		});

		test("renders partial delegation (only taskTitle + taskId)", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "My Task", taskId: "t-1" }));
			const text = renderText(pane);
			expect(text).toContain("Delegation");
			expect(text).toContain("Task:");
			expect(text).toContain("My Task");
			expect(text).toContain("ID:");
			expect(text).toContain("t-1");
			// Plan should show "No plan" when task fields exist but planPath is missing
			expect(text).toContain("No plan");
			// Should not render empty rows for missing fields
			expect(text).not.toContain("Branch:");
			expect(text).not.toContain("Repo:");
			expect(text).not.toContain("Worktree:");
			expect(text).not.toContain("Envelope:");
		});

		test("shows 'No plan' when delegation fields present but planPath missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "Build X", planPath: undefined }));
			const text = renderText(pane);
			expect(text).toContain("Plan:");
			expect(text).toContain("No plan");
		});

		test("shows 'No plan' for non-task delegation fields when planPath missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ branch: "main" }));
			const text = renderText(pane);
			expect(text).toContain("Delegation");
			expect(text).toContain("Branch:");
			expect(text).toContain("Plan:");
			expect(text).toContain("No plan");
		});

		test("renders retry attempt with warning color label", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "X", retryAttempt: 2 }));
			const text = renderText(pane);
			expect(text).toContain("Retry:");
			expect(text).toContain("Attempt 2");
		});

		test("omits retry row when retryAttempt is undefined", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "X", retryAttempt: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Retry:");
		});

		test("renders quality clean indicator when no warnings or errors", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "X" }));
			const text = renderText(pane);
			expect(text).toContain("Quality:");
			expect(text).toContain("clean");
		});

		test("renders quality warnings indicator", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({ taskTitle: "X", qualityWarnings: ["lint issue", "type warning"] }),
			);
			const text = renderText(pane);
			expect(text).toContain("Quality:");
			expect(text).toContain("2 warnings");
		});

		test("renders quality errors indicator with combined counts", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({
					taskTitle: "X",
					qualityErrors: ["build failed"],
					qualityWarnings: ["lint issue"],
				}),
			);
			const text = renderText(pane);
			expect(text).toContain("Quality:");
			expect(text).toContain("1 error");
			expect(text).toContain("1 warning");
		});

		test("renders singular 'error' and 'warning' for count of 1", () => {
			const pane = new SubagentDetailPane(
				makeFullRef({ taskTitle: "X", qualityErrors: ["fail"], qualityWarnings: ["warn"] }),
			);
			const text = renderText(pane);
			expect(text).toContain("1 error,");
			expect(text).toContain("1 warning");
			expect(text).not.toContain("errors");
			expect(text).not.toContain("warnings");
		});

		test("renders delegation section before assignment section", () => {
			const pane = new SubagentDetailPane(makeFullRef({ ...DELEGATION_FIELDS, assignmentPreview: "Do the thing" }));
			const text = renderText(pane);
			const delegationIdx = text.indexOf("Delegation");
			const assignmentIdx = text.indexOf("Assignment");
			expect(delegationIdx).toBeGreaterThan(-1);
			expect(assignmentIdx).toBeGreaterThan(-1);
			expect(delegationIdx).toBeLessThan(assignmentIdx);
		});

		test("renders roles row with From -> To when both roles present", () => {
			const pane = new SubagentDetailPane(makeFullRef({ delegatorRole: "orchestrator", delegateRole: "implement" }));
			const text = renderText(pane);
			expect(text).toContain("From");
			expect(text).toContain("To:");
			expect(text).toContain("orchestrator");
			expect(text).toContain("implement");
		});

		test("renders partial role as 'From:' label when only delegatorRole is present", () => {
			const pane = new SubagentDetailPane(makeFullRef({ delegatorRole: "orchestrator" }));
			const text = renderText(pane);
			expect(text).toContain("From:");
			expect(text).toContain("orchestrator");
			expect(text).not.toContain("unknown");
		});

		test("renders partial role as 'To:' label when only delegateRole is present", () => {
			const pane = new SubagentDetailPane(makeFullRef({ delegateRole: "implement" }));
			const text = renderText(pane);
			expect(text).toContain("To:");
			expect(text).toContain("implement");
			expect(text).not.toContain("unknown");
		});

		test("omits worktree row when worktreePath is undefined", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "X", worktreePath: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Worktree:");
		});

		test("omits parentEnvelopeId row when undefined", () => {
			const pane = new SubagentDetailPane(makeFullRef({ taskTitle: "X", parentEnvelopeId: undefined }));
			const text = renderText(pane);
			// 'Parent:' may still appear from session section's parentAgentName
			// but no envelope parent row content
			expect(text).not.toContain("del_");
		});
	});

	describe("assignment preview section", () => {
		test("renders assignment with separator border", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);
			expect(text).toContain("Assignment");
			expect(text).toContain("Research best practices for TUI");
			expect(text).toContain("tools like lazygit, k9s, btop.");
		});

		test("omits assignment section when preview is missing", () => {
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: undefined }));
			const text = renderText(pane);
			expect(text).not.toContain("Assignment");
		});

		test("truncates to 8 lines", () => {
			const longAssignment = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n");
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: longAssignment }));
			const text = renderText(pane);
			expect(text).toContain("Line 8");
			expect(text).not.toContain("Line 9");
		});
	});

	describe("no agent selected state", () => {
		test("renders fallback message when ref is undefined", () => {
			const pane = new SubagentDetailPane(undefined);
			const text = renderText(pane);
			expect(text).toContain("No agent selected");
		});

		test("renders fallback after setRef(undefined)", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setRef(undefined);
			const text = renderText(pane);
			expect(text).toContain("No agent selected");
		});
	});

	describe("full metadata rendering", () => {
		test("renders all sections for a fully-populated ref", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			const text = renderText(pane);

			// Identity
			expect(text).toContain("Agent: research");
			expect(text).toContain("● RUNNING");
			expect(text).toContain("Research best practices for TUI modal design");

			// Model
			expect(text).toContain("claude-sonnet-4-20250514");
			expect(text).toContain("Thinking: medium");

			// Tokens
			expect(text).toContain("Tokens");
			expect(text).toContain("12.4k / 200.0k");

			// Timing
			expect(text).toContain("Elapsed:");
			expect(text).toContain("02:14");

			// Session
			expect(text).toContain("Parent:");
			expect(text).toContain("orchestrator");
			expect(text).toContain("Depth:");

			// Assignment
			expect(text).toContain("Assignment");
			expect(text).toContain("Research best practices for TUI");
		});

		test("renders gracefully with minimal ref (only id)", () => {
			const pane = new SubagentDetailPane({ id: "minimal-agent" });
			const text = renderText(pane);
			expect(text).toContain("Agent: minimal-agent");
			// No sections should throw or render broken
			expect(text).not.toContain("undefined");
			expect(text).not.toContain("NaN");
		});
	});

	describe("setRef updates content", () => {
		test("transitions between refs correctly", () => {
			const pane = new SubagentDetailPane(makeFullRef({ agent: "explore" }));
			let text = renderText(pane);
			expect(text).toContain("Agent: explore");

			pane.setRef(makeFullRef({ agent: "lint", status: "failed" }));
			text = renderText(pane);
			expect(text).toContain("Agent: lint");
			expect(text).toContain("✗ FAILED");
			expect(text).not.toContain("Agent: explore");
		});
	});

	describe("scrolling", () => {
		test("scrollBy moves viewport when content exceeds available height", () => {
			const longAssignment = Array.from({ length: 10 }, (_, i) => `Assignment line ${i + 1}`).join("\n");
			const pane = new SubagentDetailPane(makeFullRef({ assignmentPreview: longAssignment }));

			// Set a small available height to force scrolling
			pane.setAvailableHeight(5);
			const initialLines = pane.render(80);
			expect(initialLines.length).toBe(5);

			// Scroll down
			pane.scrollBy(3);
			const scrolledLines = pane.render(80);
			expect(scrolledLines.length).toBe(5);

			// The content should have shifted
			const initialText = Bun.stripANSI(initialLines.join("\n"));
			const scrolledText = Bun.stripANSI(scrolledLines.join("\n"));
			expect(scrolledText).not.toBe(initialText);
		});

		test("scrollBy clamps to valid range", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setAvailableHeight(5);

			// Scroll way past the end
			pane.scrollBy(999);
			const lines = pane.render(80);
			expect(lines.length).toBe(5);

			// Scroll way before the start
			pane.scrollBy(-999);
			const linesAfter = pane.render(80);
			expect(linesAfter.length).toBe(5);
		});

		test("setRef resets scroll offset", () => {
			const pane = new SubagentDetailPane(makeFullRef());
			pane.setAvailableHeight(5);
			pane.render(80);
			pane.scrollBy(5);

			// Set a new ref — scroll should reset
			pane.setRef(makeFullRef({ agent: "different" }));
			const lines = pane.render(80);
			const text = Bun.stripANSI(lines.join("\n"));
			expect(text).toContain("Agent: different");
		});
	});

	describe("delegation-field interactions", () => {
		const DELEGATION_COPY_FIELDS: Partial<SubagentViewRef> = {
			taskTitle: "Build TOON delegation builder",
			taskId: "task-2",
			taskIntent: "Implement the core builder module",
			delegatorRole: "orchestrator",
			delegateRole: "implement",
			inputProfile: "detailed",
			planPath: "/repo/.omp/sessions/plans/toon/plan.md",
			repoRoot: "/repo/oh-my-pi",
			branch: "feature/toon-delegation",
			worktreePath: "/repo/.worktrees/feature-toon",
			envelopeId: "del_f1a2b3c4d5e6",
			parentEnvelopeId: "del_4a9b2c1e8f3d",
		};

		describe("copy cycling", () => {
			test("c cycles through copiable delegation field values", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80); // trigger layout

				const fields = pane.getCopyableFields();
				expect(fields.length).toBeGreaterThan(0);

				// First press: copies first field
				const action1 = pane.handleInput("c");
				expect(action1).toBeDefined();
				expect(action1!.type).toBe("copy");
				expect((action1 as Extract<DetailPaneAction, { type: "copy" }>).value).toBe(fields[0]!.value);

				// Second press: copies next field
				const action2 = pane.handleInput("c");
				expect(action2).toBeDefined();
				expect((action2 as Extract<DetailPaneAction, { type: "copy" }>).value).toBe(fields[1]!.value);
			});

			test("y is an alias for c (copy)", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				const action = pane.handleInput("y");
				expect(action).toBeDefined();
				expect(action!.type).toBe("copy");
			});

			test("copy wraps around to first field after last", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				const fields = pane.getCopyableFields();
				const total = fields.length;

				// Cycle through all fields
				let lastAction: DetailPaneAction | undefined;
				for (let i = 0; i < total; i++) {
					lastAction = pane.handleInput("c");
				}
				// Should have copied the last field
				expect((lastAction as Extract<DetailPaneAction, { type: "copy" }>).value).toBe(fields[total - 1]!.value);

				// Next press wraps to first field
				const wrapAction = pane.handleInput("c");
				expect((wrapAction as Extract<DetailPaneAction, { type: "copy" }>).value).toBe(fields[0]!.value);
			});

			test("returns undefined for c when no delegation fields", () => {
				const pane = new SubagentDetailPane(makeFullRef());
				pane.render(80);

				const action = pane.handleInput("c");
				expect(action).toBeUndefined();
			});

			test("includes expected copyable fields from delegation metadata", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				const fields = pane.getCopyableFields();
				const labels = fields.map(f => f.label);
				const values = fields.map(f => f.value);

				expect(labels).toContain("Task ID");
				expect(labels).toContain("Plan");
				expect(labels).toContain("Branch");
				expect(labels).toContain("Repo");
				expect(labels).toContain("Worktree");
				expect(labels).toContain("Envelope");
				expect(labels).toContain("Parent Envelope");

				expect(values).toContain("task-2");
				expect(values).toContain("/repo/.omp/sessions/plans/toon/plan.md");
				expect(values).toContain("feature/toon-delegation");
				expect(values).toContain("/repo/oh-my-pi");
				expect(values).toContain("/repo/.worktrees/feature-toon");
				expect(values).toContain("del_f1a2b3c4d5e6");
				expect(values).toContain("del_4a9b2c1e8f3d");
			});

			test("copy returns label and value in action", () => {
				const pane = new SubagentDetailPane(makeFullRef({ taskId: "t-42", planPath: "/my/plan.md" }));
				pane.render(80);

				const action = pane.handleInput("c") as Extract<DetailPaneAction, { type: "copy" }>;
				expect(action.type).toBe("copy");
				expect(action.label).toBe("Task ID");
				expect(action.value).toBe("t-42");

				const action2 = pane.handleInput("c") as Extract<DetailPaneAction, { type: "copy" }>;
				expect(action2.label).toBe("Plan");
				expect(action2.value).toBe("/my/plan.md");
			});

			test("setRef resets copy field index", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				pane.handleInput("c"); // advance to first field
				pane.handleInput("c"); // advance to second field

				pane.setRef(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				// After setRef, copy should start from first field again
				const fields = pane.getCopyableFields();
				const action = pane.handleInput("c") as Extract<DetailPaneAction, { type: "copy" }>;
				expect(action.value).toBe(fields[0]!.value);
			});
		});

		describe("verbose toggle", () => {
			test("d toggles verbose delegation details", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				expect(pane.getVerboseMode()).toBe(true);

				const action = pane.handleInput("d");
				expect(action).toBeDefined();
				expect(action!.type).toBe("toggle-verbose");
				expect((action as Extract<DetailPaneAction, { type: "toggle-verbose" }>).visible).toBe(false);
				expect(pane.getVerboseMode()).toBe(false);

				// Toggle back
				const action2 = pane.handleInput("d");
				expect((action2 as Extract<DetailPaneAction, { type: "toggle-verbose" }>).visible).toBe(true);
				expect(pane.getVerboseMode()).toBe(true);
			});

			test("compact mode hides verbose fields", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.setVerboseMode(false);
				const text = renderText(pane);

				// Core fields remain visible
				expect(text).toContain("Task:");
				expect(text).toContain("Build TOON delegation builder");
				expect(text).toContain("Branch:");
				expect(text).toContain("feature/toon-delegation");
				expect(text).toContain("Plan:");

				// Verbose fields are hidden
				expect(text).not.toContain("Profile:");
				expect(text).not.toContain("detailed");
				expect(text).not.toContain("Repo:");
				expect(text).not.toContain("/repo/oh-my-pi");
				expect(text).not.toContain("Worktree:");
				expect(text).not.toContain("/repo/.worktrees/feature-toon");
				expect(text).not.toContain("Envelope:");
				expect(text).not.toContain("del_f1a2b3c4d5e6");
			});

			test("verbose mode shows all fields", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				// Default is verbose=true
				const text = renderText(pane);

				expect(text).toContain("Profile:");
				expect(text).toContain("Repo:");
				expect(text).toContain("Worktree:");
				expect(text).toContain("Envelope:");
				expect(text).toContain("del_f1a2b3c4d5e6");
				expect(text).toContain("del_4a9b2c1e8f3d");
			});

			test("compact mode reduces copyable field count", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);
				const verboseFieldCount = pane.getCopyableFields().length;

				pane.setVerboseMode(false);
				pane.render(80);
				const compactFieldCount = pane.getCopyableFields().length;

				expect(compactFieldCount).toBeLessThan(verboseFieldCount);
			});

			test("d returns undefined when no delegation fields", () => {
				const pane = new SubagentDetailPane(makeFullRef());
				pane.render(80);

				const action = pane.handleInput("d");
				expect(action).toBeUndefined();
			});

			test("setVerboseMode is idempotent when value unchanged", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);
				const initialFields = pane.getCopyableFields().length;

				pane.setVerboseMode(true); // already true
				pane.render(80);
				expect(pane.getCopyableFields().length).toBe(initialFields);
			});
		});

		describe("help text", () => {
			test("renders copy and toggle help hints when delegation fields present", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				const text = renderText(pane);

				expect(text).toContain("c/y");
				expect(text).toContain("copy field");
				expect(text).toContain("d");
				expect(text).toContain("compact");
			});

			test("help text shows 'details' label when in compact mode", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.setVerboseMode(false);
				const text = renderText(pane);

				expect(text).toContain("details");
				expect(text).not.toContain("compact");
			});

			test("no help text when no delegation fields", () => {
				const pane = new SubagentDetailPane(makeFullRef());
				const text = renderText(pane);

				expect(text).not.toContain("copy field");
				expect(text).not.toContain("compact");
			});
		});

		describe("unhandled keys", () => {
			test("returns undefined for non-delegation keys", () => {
				const pane = new SubagentDetailPane(makeFullRef(DELEGATION_COPY_FIELDS));
				pane.render(80);

				expect(pane.handleInput("x")).toBeUndefined();
				expect(pane.handleInput("q")).toBeUndefined();
				expect(pane.handleInput("z")).toBeUndefined();
			});
		});
	});
});

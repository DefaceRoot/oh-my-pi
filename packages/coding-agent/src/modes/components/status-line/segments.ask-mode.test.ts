import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentSession } from "../../../session/agent-session";
import { initTheme, theme } from "../../../modes/theme/theme";
import type { SegmentContext } from "./segments";
import { renderSegment } from "./segments";

function createContext(options: {
	lastRole?: string;
	model?: { provider: string; id: string; name?: string; reasoning?: boolean };
	roles?: Partial<Record<"default" | "ask" | "orchestrator" | "plan", string>>;
}): SegmentContext {
	const model = options.model ?? {
		provider: "anthropic",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
	};

	const roleMap: Record<string, string | undefined> = {
		default: options.roles?.default,
		ask: options.roles?.ask,
		orchestrator: options.roles?.orchestrator,
		plan: options.roles?.plan,
	};

	const session = {
		sessionManager: {
			getLastModelChangeRole: () => options.lastRole,
		},
		state: {
			model,
			thinkingLevel: "high",
		},
		settings: {
			getModelRole: (role: string) => roleMap[role],
		},
		isFastModeEnabled: () => false,
	} as unknown as AgentSession;

	return {
		session,
		width: 120,
		options: { model: { showThinkingLevel: true } },
		planMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: true,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
	};
}

describe("status-line model segment agent modes", () => {
	beforeAll(() => {
		initTheme();
	});

	it("shows Ask label when current session role is ask", () => {
		const ctx = createContext({
			lastRole: "ask",
			roles: {
				default: "anthropic/claude-opus-4-6",
				ask: "anthropic/claude-opus-4-6",
			},
		});

		const rendered = renderSegment("model", ctx);

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("Ask");
		expect(rendered.content).not.toContain("Default");
	});

	it("prefers Ask label over Default when ask/default map to the same model", () => {
		const ctx = createContext({
			roles: {
				default: "anthropic/claude-opus-4-6",
				ask: "anthropic/claude-opus-4-6",
			},
		});

		const rendered = renderSegment("model", ctx);

		expect(rendered.content).toContain("Ask");
		expect(rendered.content).not.toContain("Default");
	});

	it("renders distinct labels and colors for each main agent role", () => {
		const cases = [
			{ role: "default", label: "Default", style: theme.fg("success", "Default") },
			{ role: "ask", label: "Ask", style: theme.fg("statusLineSubagents", "Ask") },
			{ role: "orchestrator", label: "Orchestrator", style: theme.fg("warning", "Orchestrator") },
			{ role: "plan", label: "Plan", style: theme.fg("statusLineContext", "Plan") },
		] as const;

		for (const testCase of cases) {
			const rendered = renderSegment(
				"model",
				createContext({
 					lastRole: testCase.role,
					roles: {
						default: "anthropic/default-model",
						ask: "anthropic/ask-model",
						orchestrator: "anthropic/orchestrator-model",
						plan: "anthropic/plan-model",
					},
				}),
			);

			expect(rendered.content).toContain(testCase.label);
			expect(rendered.content).toContain(testCase.style);
		}
	});
});

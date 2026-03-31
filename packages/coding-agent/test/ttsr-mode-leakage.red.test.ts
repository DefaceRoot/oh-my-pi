/**
 * Regression tests for cross-mode TTSR and session-authority leakage.
 *
 * These cases reproduced the bug before the fix:
 * 1. orchestrator-only rules could trigger outside orchestrator mode
 * 2. restoreInjected recreated injection state for rules absent from the current session
 */
import { describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

const ORCHESTRATOR_DELEGATE_RULE_NAME = "orchestrator-delegate";

function makeOrchestratorDelegateRule(): Rule {
	return {
		name: ORCHESTRATOR_DELEGATE_RULE_NAME,
		path: "/tmp/orchestrator-delegate.md",
		content: "Stop doing the work yourself — delegate to subagents.",
		condition: ['_i":\\s*"(Reading|Editing|Writing|Finding|Grep|Bash|Running|Executing)'],
		scope: ["tool"],
		interruptMode: "always",
		_source: {
			provider: "test",
			providerName: "test",
			path: "/tmp/orchestrator-delegate.md",
			level: "project",
		},
	};
}

const TRIGGERING_DELTA = '_i":"Reading file contents';
const createManagerForRole = (role: string) => new TtsrManager(undefined, undefined, () => role);
const toolContext = (toolName: string): { source: "tool"; toolName: string } => ({
	source: "tool",
	toolName,
});

describe("TTSR mode leakage — orchestrator-only rules in non-orchestrator sessions", () => {
	it("orchestrator-delegate rule does not fire in default-mode sessions after repeated tool calls", () => {
		const manager = createManagerForRole("default");
		manager.addRule(makeOrchestratorDelegateRule());

		for (let i = 0; i < 11; i++) {
			expect(manager.checkDelta(TRIGGERING_DELTA, toolContext("read"))).toEqual([]);
		}
	});

	it("orchestrator-delegate rule does not fire in ask-mode sessions after repeated tool calls", () => {
		const manager = createManagerForRole("ask");
		manager.addRule(makeOrchestratorDelegateRule());

		for (let i = 0; i < 11; i++) {
			expect(manager.checkDelta(TRIGGERING_DELTA, toolContext("read"))).toEqual([]);
		}
	});
});

describe("TTSR mode leakage — injection record restore across mode boundaries", () => {
	it("restoreInjected does not create records for rule names not currently registered", () => {
		const manager = new TtsrManager();

		manager.restoreInjected([ORCHESTRATOR_DELEGATE_RULE_NAME, "some-other-orchestrator-rule"]);

		expect(manager.getInjectedRuleNames()).toEqual([]);
	});

	it("orchestrator session injection records do not persist into a fresh default session", () => {
		const manager = new TtsrManager();

		manager.restoreInjected([ORCHESTRATOR_DELEGATE_RULE_NAME]);

		expect(manager.getInjectedRuleNames()).toEqual([]);
	});
});

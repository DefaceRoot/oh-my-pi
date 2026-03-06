import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	resolveParentRuntimeRole,
	shouldEnforceOrchestratorGuards,
} from "./orchestrator-guard.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const planWorktreePath = path.join(repoRoot, "agent/extensions/plan-worktree/index.ts");

const readExtensionSource = async (): Promise<string> => Bun.file(planWorktreePath).text();

describe("handoff orchestrator bypass", () => {
	test("before_agent_start detects native handoff prompt", async () => {
		const content = await readExtensionSource();

		// Must check for the native handoff prompt signature
		expect(content).toMatch(
			/Write a comprehensive handoff document that will allow another instance/,
		);
		// Must set role to "default" when handoff detected
		expect(content).toMatch(/isNativeHandoffPrompt/);
		expect(content).toMatch(/activeParentRuntimeRole\s*=\s*"default"/);
	});

	test("handoff bypass only activates when orchestrator mode is active", async () => {
		const content = await readExtensionSource();

		// The handoff bypass must be gated on orchestrator mode being active
		expect(content).toMatch(
			/isNativeHandoffPrompt\s*=\s*activeAgentIsParentTurn\s*&&\s*\n?\s*activeParentRuntimeRole\s*===\s*"orchestrator"/,
		);
	});

	test("after handoff bypass, orchestrator guards are not enforced", () => {
		// When the runtime role is set to "default", guards should not fire
		expect(
			shouldEnforceOrchestratorGuards({
				activeAgentIsParentTurn: true,
				parentRuntimeRole: resolveParentRuntimeRole("default"),
			}),
		).toBe(false);
	});

	test("handoff bypass logs the override", async () => {
		const content = await readExtensionSource();

		expect(content).toMatch(
			/bypassing orchestrator mode for native \/handoff/,
		);
	});
});

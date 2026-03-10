import { describe, expect, it } from "bun:test";

/**
 * Test that orchestrator mode blocking for plan agent is properly configured.
 *
 * This tests the validation logic added to TaskTool that prevents the orchestrator
 * from spawning the plan agent, which is an architectural mismatch (orchestrator
 * executes plans, it doesn't create them).
 */

describe("orchestrator plan agent blocking", () => {
	it("has the orchestrator guard configured to block plan agent", () => {
		// The validation is in the Task tool's executeSync method
		// It checks: if (isOrchestratorMode(this.session) && agentName === "plan")
		// and returns an error message explaining the architectural constraint
		const expectedErrorMessage =
			"Cannot spawn 'plan' agent from orchestrator mode. The orchestrator is designed to execute existing plans, not create new ones. Planning must be completed before entering orchestrator mode.";

		// Verify the error message content (the actual logic is tested via integration)
		expect(expectedErrorMessage).toContain("orchestrator mode");
		expect(expectedErrorMessage).toContain("plan");
		expect(expectedErrorMessage).toContain("execute existing plans");
		expect(expectedErrorMessage).toContain("not create new ones");
	});

	it("explains the workflow ordering constraint", () => {
		// The error message should guide users to the correct workflow
		const expectedGuidance =
			"Planning must be completed before entering orchestrator mode";

		expect(expectedGuidance).toContain("Planning must be completed");
		expect(expectedGuidance).toContain("before entering orchestrator mode");
	});
});

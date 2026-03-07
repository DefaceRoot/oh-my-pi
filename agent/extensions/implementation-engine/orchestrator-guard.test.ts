import { describe, expect, test } from "bun:test";
import {
	isOrchestratorParentToolAllowed,
	resolveParentRuntimeRole,
	shouldEnforceOrchestratorGuards,
} from "./orchestrator-guard.ts";

describe("orchestrator parent guard decisions", () => {
	test("enforces guard for parent turns when model role is orchestrator", () => {
		expect(
			shouldEnforceOrchestratorGuards({
				activeAgentIsParentTurn: true,
				parentRuntimeRole: resolveParentRuntimeRole("orchestrator"),
			}),
		).toBe(true);
	});

	test("does not enforce guard for subagent turns", () => {
		expect(
			shouldEnforceOrchestratorGuards({
				activeAgentIsParentTurn: false,
				parentRuntimeRole: resolveParentRuntimeRole("orchestrator"),
			}),
		).toBe(false);
	});

	test("does not enforce guard for default role parent turns", () => {
		expect(
			shouldEnforceOrchestratorGuards({
				activeAgentIsParentTurn: true,
				parentRuntimeRole: resolveParentRuntimeRole("default"),
			}),
		).toBe(false);
	});

	test("parent orchestrator allowlist excludes mutating tools", () => {
		expect(isOrchestratorParentToolAllowed("task")).toBe(true);
		expect(isOrchestratorParentToolAllowed("todo_write")).toBe(true);
		expect(isOrchestratorParentToolAllowed("edit")).toBe(false);
		expect(isOrchestratorParentToolAllowed("write")).toBe(false);
		expect(isOrchestratorParentToolAllowed("notebook")).toBe(false);
	});

	test("parent orchestrator allowlist allows augment retrieval and blocks other MCP tools", () => {
		expect(isOrchestratorParentToolAllowed("mcp_augment_codebase_retrieval")).toBe(true);
		expect(isOrchestratorParentToolAllowed("mcp_better_context_ask")).toBe(false);
	});
});

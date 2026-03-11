import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { YAML } from "bun";
import {
isOrchestratorParentToolAllowed,
resolveParentRuntimeRole,
shouldEnforceOrchestratorGuards,
} from "./orchestrator-guard.ts";

type RolesFileShape = {
	roles?: Record<string, { tools?: unknown }>;
};

async function readOrchestratorToolsFromRepoRoles(): Promise<string[]> {
	const rolesPath = path.resolve(import.meta.dir, "..", "..", "roles.yml");
	const parsed = YAML.parse(await Bun.file(rolesPath).text()) as RolesFileShape;
	const tools = parsed.roles?.orchestrator?.tools;
	if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string")) {
		throw new Error("Expected roles.yml to define roles.orchestrator.tools as a string array");
	}
	return tools;
}

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

	test("keeps persisted orchestrator tools aligned with enforced parent guard allowlist", async () => {
		const configuredTools = await readOrchestratorToolsFromRepoRoles();
		for (const tool of configuredTools) {
			expect(isOrchestratorParentToolAllowed(tool)).toBe(true);
		}
	});
});

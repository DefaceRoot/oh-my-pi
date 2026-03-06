import { describe, expect, test } from "bun:test";
import {
	CANONICAL_AGENT_IDS,
	CANONICAL_MODEL_ROLES,
	normalizeAgentId,
	normalizeModelRole,
} from "./naming-map";

describe("naming-map", () => {
	test("normalizes task agent alias to implement", () => {
		expect(normalizeAgentId("task")).toBe("implement");
	});

	test("keeps canonical implement agent unchanged", () => {
		expect(normalizeAgentId("implement")).toBe("implement");
	});

	test("keeps unchanged agent names as-is", () => {
		expect(normalizeAgentId("explore")).toBe("explore");
	});

	test("normalizes subagent model role alias to implement", () => {
		expect(normalizeModelRole("subagent")).toBe("implement");
	});

	test("keeps unchanged model roles as-is", () => {
		expect(normalizeModelRole("default")).toBe("default");
	});

	test("canonical agent IDs include implement but exclude task", () => {
		expect(CANONICAL_AGENT_IDS).toContain("implement");
		expect(CANONICAL_AGENT_IDS).not.toContain("task");
	});

	test("canonical model roles include implement but exclude subagent", () => {
		expect(CANONICAL_MODEL_ROLES).toContain("implement");
		expect(CANONICAL_MODEL_ROLES).not.toContain("subagent");
	});
});

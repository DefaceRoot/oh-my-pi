import { describe, expect, it } from "bun:test";
import { resolveSubagentRole } from "../../src/task/model-role";

describe("resolveSubagentRole", () => {
	it("resolves grafana agent to grafana model role", () => {
		expect(resolveSubagentRole("grafana")).toBe("grafana");
	});

	it("maps reviewer alias to code-reviewer role", () => {
		expect(resolveSubagentRole("reviewer")).toBe("code-reviewer");
	});

	it("falls back to implement for unknown subagents", () => {
		expect(resolveSubagentRole("totally-unknown-agent")).toBe("implement");
	});
});

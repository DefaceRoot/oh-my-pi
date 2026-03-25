import { describe, expect, test } from "bun:test";
import { getAgent } from "./discovery";
import type { AgentDefinition } from "./types";

function makeAgent(name: string): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} prompt`,
		source: "bundled",
	};
}

describe("getAgent", () => {
	test("falls back to historical aliases when exact lookup misses", () => {
		const agents = [makeAgent("implement"), makeAgent("debug")];

		expect(getAgent(agents, "task")?.name).toBe("implement");
	});

	test("prefers exact name matches over aliases", () => {
		const agents = [makeAgent("task"), makeAgent("implement")];

		expect(getAgent(agents, "task")?.name).toBe("task");
	});
});

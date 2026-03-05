import { beforeEach, describe, expect, it } from "bun:test";
import { clearBundledAgentsCache, loadBundledAgents } from "./agents";

describe("bundled-agent-names", () => {
	beforeEach(() => {
		clearBundledAgentsCache();
	});

	it('does not include legacy name "task"', () => {
		const agents = loadBundledAgents();
		const names = agents.map(a => a.name);
		expect(names).not.toContain("task");
	});

	it('includes canonical name "implement"', () => {
		const agents = loadBundledAgents();
		const names = agents.map(a => a.name);
		expect(names).toContain("implement");
	});
});

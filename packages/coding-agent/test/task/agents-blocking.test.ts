import { describe, expect, it } from "bun:test";
import { clearBundledAgentsCache, getBundledAgent } from "../../src/task/agents";

describe("bundled agent frontmatter parsing", () => {
	it("marks reviewer as blocking", () => {
		clearBundledAgentsCache();
		const reviewer = getBundledAgent("reviewer");
		expect(reviewer).toBeDefined();
		expect(reviewer?.blocking).toBe(true);
	});

	it("bundles planning support specialists", () => {
		clearBundledAgentsCache();
		const librarian = getBundledAgent("librarian");
		const oracle = getBundledAgent("oracle");
		expect(librarian).toBeDefined();
		expect(oracle).toBeDefined();
	});

	it("lets the plan agent spawn research and verification specialists", () => {
		clearBundledAgentsCache();
		const plan = getBundledAgent("plan");
		expect(plan).toBeDefined();
		expect(plan?.spawns).toEqual(["explore", "librarian", "oracle"]);
	});
});

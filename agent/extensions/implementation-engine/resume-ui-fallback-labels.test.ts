import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

function extractFallbackSelectorBlock(source: string): string {
	const start = source.indexOf("const fallbackOptions = fallbackSessions.map((session, index) => {");
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("const choice = await ctx.ui.select(", start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("resume fallback selector labels", () => {
	test("uses the shared role label map so Ask and Plan do not collapse to Unknown", async () => {
		const source = await Bun.file(implementationEnginePath).text();
		const block = extractFallbackSelectorBlock(source);

		expect(block).toMatch(/RESUME_AGENT_MODE_STYLES\[session\.agentMode\]\.label/);
		expect(block).not.toMatch(/session\.agentMode === "orchestrator"[\s\S]*"Unknown"/);
	});
});

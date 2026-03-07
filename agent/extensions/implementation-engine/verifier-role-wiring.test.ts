import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const modelRegistryPath = path.join(
	repoRoot,
	"agent/patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/config/model-registry.ts",
);
const taskIndexPath = path.join(
	repoRoot,
	"agent/patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/task/index.ts",
);
const verifierAgentPath = path.join(repoRoot, "agent/agents/verifier.md");

describe("verifier model role wiring", () => {
	test("registers verifier in model role registry type and metadata", async () => {
		const content = await Bun.file(modelRegistryPath).text();

		expect(content).toMatch(/export type ModelRole = [^;]*"verifier"[^;]*;/s);
		expect(content).toMatch(/verifier:\s*\{[^}]*name:\s*"Verifier"[^}]*\}/s);
		expect(content).toMatch(/MODEL_ROLE_IDS:\s*ModelRole\[]\s*=\s*\[[^\]]*"verifier"/s);
	});

	test("recognizes verifier as a first-class subagent role", async () => {
		const content = await Bun.file(taskIndexPath).text();

		expect(content).toMatch(/const SUBAGENT_MODEL_ROLES = new Set\(\[[\s\S]*"verifier"[\s\S]*\]\);/);
		expect(content).toMatch(/function resolveSubagentRole\(agentName: string\): string \{\s*return SUBAGENT_MODEL_ROLES\.has\(agentName\) \? agentName : "implement";\s*\}/s);
	});
});

describe("verifier agent definition", () => {
	test("defines required frontmatter and structured output contract", async () => {
		const content = await Bun.file(verifierAgentPath).text();

		expect(content).toMatch(/^---\n[\s\S]*\n---\n/);
		expect(content).toMatch(/^name:\s*verifier$/m);
		expect(content).toMatch(/^tools:\s*read,\s*grep,\s*find,\s*bash,\s*lsp,\s*submit_result$/m);
		expect(content).toMatch(/verdict:[\s\S]*type:\s*string/s);
		expect(content).toMatch(/summary:[\s\S]*type:\s*string/s);
		expect(content).toMatch(/issues:[\s\S]*elements:[\s\S]*type:\s*string/s);
		expect(content).toMatch(/\"go\"\s*\|\s*\"no_go\"/);
	});
});

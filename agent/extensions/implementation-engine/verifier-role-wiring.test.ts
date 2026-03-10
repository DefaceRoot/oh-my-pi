import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const modelRegistryPath = path.join(repoRoot, "packages/coding-agent/src/config/model-registry.ts");
const modelRolePath = path.join(repoRoot, "packages/coding-agent/src/task/model-role.ts");
const verifierAgentPath = path.join(repoRoot, "agent/agents/verifier.md");

describe("verifier model role wiring", () => {
	test("registers verifier in model role registry type and metadata", async () => {
		const content = await Bun.file(modelRegistryPath).text();

		expect(content).toMatch(/export type ModelRole\s*=\s*[\s\S]*"verifier"[\s\S]*;/s);
		expect(content).toMatch(/verifier:\s*\{[^}]*name:\s*"Verifier"[^}]*\}/s);
		expect(content).toMatch(/MODEL_ROLE_IDS:\s*ModelRole\[]\s*=\s*\[[^\]]*"verifier"/s);
	});

	test("recognizes verifier as a first-class subagent role", async () => {
		const content = await Bun.file(modelRolePath).text();

		expect(content).toMatch(/const SUBAGENT_MODEL_ROLES = new Set<ModelRole>\(\[[\s\S]*"verifier"[\s\S]*\]\);/);
		expect(content).toMatch(/const SUBAGENT_MODEL_ROLE_ALIASES:\s*Readonly<Record<string,\s*ModelRole>>\s*=\s*\{[\s\S]*reviewer:\s*"code-reviewer"[\s\S]*\};/);
		expect(content).toMatch(/export function resolveSubagentRole\(agentName: string\): ModelRole \{[\s\S]*SUBAGENT_MODEL_ROLE_ALIASES\[agentName\][\s\S]*SUBAGENT_MODEL_ROLES\.has\(agentName as ModelRole\)\s*\?\s*\(agentName as ModelRole\)\s*:\s*"implement";[\s\S]*\}/s);
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
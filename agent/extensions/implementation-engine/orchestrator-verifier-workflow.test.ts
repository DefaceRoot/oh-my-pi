import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");

const readPromptSource = async (): Promise<string> => Bun.file(implementationEnginePath).text();

const extractBlock = (source: string, start: string, end: string): string => {
	const startIndex = source.indexOf(start);
	expect(startIndex).toBeGreaterThan(-1);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
};

const extractOrchestratorPromptBlock = (source: string): string =>
	extractBlock(
		source,
		"## ORCHESTRATOR MODE — READ BEFORE EVERY RESPONSE",
		"Strict response format:",
	);

const extractMandatoryExecutionContractBlock = (source: string): string =>
	extractBlock(
		source,
		"## Mandatory Execution Contract",
		"24. If any phase remains blocked after remediation, STOP and provide a failure summary with next actions.",
	);

describe("orchestrator verifier workflow prompts", () => {
	test("planned mode includes phase-end verifier trigger", async () => {
		const content = await readPromptSource();
		const orchestratorBlock = extractOrchestratorPromptBlock(content);
		const plannedModeBlock = extractBlock(
			orchestratorBlock,
			"PLANNED MODE (phases from a plan):",
			"AD HOC MODE (no plan, direct requests):",
		);

		expect(plannedModeBlock).toMatch(/After each phase\\?'s implementation task batch completes, spawn parallel verifiers/);
		expect(plannedModeBlock).not.toMatch(/After each phase\\?'s task\(s\) complete, spawn:\s*task\(agent="verifier"/);
	});

	test("ad hoc mode includes phase-end verifier fan-out trigger", async () => {
		const content = await readPromptSource();
		const orchestratorBlock = extractOrchestratorPromptBlock(content);
		const adHocModeBlock = extractBlock(
			orchestratorBlock,
			"AD HOC MODE (no plan, direct requests):",
			"WITH a plan file:",
		);

		expect(adHocModeBlock).toMatch(/At each phase end, after that phase's implementation task batch completes, spawn parallel verifiers/);
		expect(adHocModeBlock).not.toMatch(/After each spawned batch completes, spawn parallel verifiers/);
	});

	test("model fallback wording uses implement role explicitly", async () => {
		const content = await readPromptSource();
		const executionContractBlock = extractMandatoryExecutionContractBlock(content);

		expect(executionContractBlock).toMatch(/fallback:\s*implement role only when no active model is available/);
		expect(executionContractBlock).not.toMatch(/fallback:\s*Subagent role only when no active model is available/);
	});

	test("remediation loop has bounded retries", async () => {
		const content = await readPromptSource();
		const orchestratorBlock = extractOrchestratorPromptBlock(content);
		const plannedModeBlock = extractBlock(
			orchestratorBlock,
			"PLANNED MODE (phases from a plan):",
			"AD HOC MODE (no plan, direct requests):",
		);

		expect(plannedModeBlock).toMatch(/Max 2 remediation loops per phase/);
		expect(plannedModeBlock).toMatch(/If still no_go -> STOP and report to user/);
	});

	test("verifier output contract is specified", async () => {
		const content = await readPromptSource();
		const orchestratorBlock = extractOrchestratorPromptBlock(content);

		expect(orchestratorBlock).toMatch(/go:\s*\{\s*verdict:\s*\\?"go\\?",\s*summary:\s*\\?"1-2 sentence confirmation\\?"\s*\}/);
		expect(orchestratorBlock).toMatch(/no_go:\s*\{\s*verdict:\s*\\?"no_go\\?",\s*issues:\s*\[\\?"itemized failures\\?"\],\s*summary:\s*\\?"what failed and why\\?"\s*\}/);
	});

	test("verifier checks lint + tests + criteria", async () => {
		const content = await readPromptSource();
		const orchestratorBlock = extractOrchestratorPromptBlock(content);

		expect(orchestratorBlock).toMatch(/\(1\) lint passed on modified files, \(2\) tests exist and pass, \(3\) success criteria met/);
	});
});

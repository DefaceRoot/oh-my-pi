import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const implementationEnginePath = path.join(repoRoot, "agent/extensions/implementation-engine/index.ts");
const implementAgentPath = path.join(repoRoot, "agent/agents/implement.md");
const mergeAgentPath = path.join(repoRoot, "agent/agents/merge.md");
const workerProtocolPath = path.join(repoRoot, "agent/rules/worker-protocol.md");
const orchestratorModePath = path.join(repoRoot, "agent/rules/orchestrator-mode.md");
const dispatchSkillPath = path.join(repoRoot, "agent/skills/dispatching-parallel-agents/SKILL.md");
const taskToolPromptPath = path.join(repoRoot, "packages/coding-agent/src/prompts/tools/task.md");
const taskTypesPath = path.join(repoRoot, "packages/coding-agent/src/task/types.ts");
const configPath = path.join(repoRoot, "agent/config.yml");

const readFile = async (filePath: string): Promise<string> => Bun.file(filePath).text();

function extractToolCallBlock(source: string): string {
	const start = source.indexOf('pi.on("tool_call", async (event, ctx) => {');
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf('pi.on("tool_result", async (event, ctx) => {', start + 1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe("implementation quality-loop delegation", () => {
	test("implementation worker blocks isolated quality-loop handoffs", async () => {
		const source = await readFile(implementationEnginePath);
		const toolCallBlock = extractToolCallBlock(source);

		expect(toolCallBlock).toMatch(/activeImplementationWorkerGate[\s\S]*taskInput\.isolated\s*===\s*true/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"lint"/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"code-reviewer"/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"commit"/);
		expect(toolCallBlock).toMatch(/quality-loop subagents must reuse the current workspace/i);
	});

	test("orchestrator task routing blocks direct quality-loop agents and conditional commit", async () => {
		const source = await readFile(implementationEnginePath);
		const toolCallBlock = extractToolCallBlock(source);

		expect(toolCallBlock).toMatch(/isOrchestratorParentTaskCall\s*=\s*enforceOrchestratorGuards\s*&&\s*activeAgentIsParentTurn/);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"lint"\s*\|\|\s*taskAgent\s*===\s*"code-reviewer"/);
		expect(toolCallBlock).toMatch(/parent cannot delegate lint or code-reviewer directly/i);
		expect(toolCallBlock).toMatch(/taskAgent\s*===\s*"commit"[\s\S]*captureGitStatusSnapshot\(snapshotCwd\)/);
		expect(toolCallBlock).toMatch(/commit delegation is reserved for direct git-only handoff when no implementation-owned file set is pending/i);
	});

	test("worker gate derives lint requirement from owned files for submit and task-result checks", async () => {
		const source = await readFile(implementationEnginePath);
		const toolCallBlock = extractToolCallBlock(source);

		expect(source).toMatch(/const getImplementationWorkerGateOptions = \(changedFiles: Iterable<string>\) => \([\s\S]*isImplementationWorkerLintRequired\(changedFiles\)/);
		expect(toolCallBlock).toMatch(/captureImplementationWorkerOwnedFiles\(\)[\s\S]*getImplementationWorkerSubmitDecision\([\s\S]*getImplementationWorkerGateOptions\(ownedFiles\)/);
		expect(source).toMatch(/computeFilesDelta\([\s\S]*implementationWorkerBaselineSnapshot[\s\S]*postTaskSnapshot[\s\S]*recordImplementationWorkerGateOutcome\([\s\S]*getImplementationWorkerGateOptions\(workerOwnedFiles\)/);
	});

	test("implementation agent prompt requires dedicated lint, review, and commit agents", async () => {
		const content = await readFile(implementAgentPath);

		expect(content).toContain("Use the Task tool only as delegation transport");
		expect(content).toContain("dedicated `lint`, `code-reviewer`, and `commit` agents");
		expect(content).toContain("Never substitute `implement` or `explore` for these quality gates");
		expect(content).toMatch(/never set `isolated: true` for these quality-loop delegations/i);
	});

	test("worker protocol mirrors quality-loop and conflict escalation requirements", async () => {
		const content = await readFile(workerProtocolPath);

		expect(content).toContain("Use the Task tool only as delegation transport");
		expect(content).toContain("dedicated `lint`, `code-reviewer`, and `commit` agents");
		expect(content).toContain("Never set `isolated: true` for these quality-loop delegations");
		expect(content).toContain("When using `isolated: true` for parallel implementation delegations");
		expect(content).toContain("spawn a `merge` agent with conflicting branch names");
	});

	test("orchestrator and merge guidance document isolated conflict handling", async () => {
		const orchestratorRule = await readFile(orchestratorModePath);
		const mergeAgent = await readFile(mergeAgentPath);

		expect(orchestratorRule).toContain("`merge` only for isolated-integration conflicts");
		expect(orchestratorRule).toContain("If an isolated batch reports integration conflicts");
		expect(orchestratorRule).toContain("## Isolated Dispatch Guidance");
		expect(mergeAgent).toContain("spawns: explore");
		expect(mergeAgent).toContain("### Isolation-conflict mode");
		expect(mergeAgent).toContain("human_review_required=true");
	});

	test("task prompt, schema, and dispatch skill document isolated usage", async () => {
		const taskPrompt = await readFile(taskToolPromptPath);
		const taskTypes = await readFile(taskTypesPath);
		const dispatchSkill = await readFile(dispatchSkillPath);

		expect(taskPrompt).toContain("`isolated`: optional boolean");
		expect(taskPrompt).toContain("<task_isolation>");
		expect(taskPrompt).toContain("spawn a `merge` agent with conflicting branch names");
		expect(taskTypes).toContain("Use for parallel implementation slices touching different subsystems as defense-in-depth");
		expect(dispatchSkill).toContain("## Task Isolation");
		expect(dispatchSkill).toContain("Never use isolation for quality-loop delegations (`lint`, `code-reviewer`, `commit`)");
	});


	test("orchestrator guidance and prompt injection require `(P)`-driven progressive parallelism", async () => {
		const orchestratorRule = await readFile(orchestratorModePath);
		const dispatchSkill = await readFile(dispatchSkillPath);
		const implementationEngine = await readFile(implementationEnginePath);

		expect(orchestratorRule).toContain("sibling units explicitly marked `(P)` with `Parallel safety` proof");
		expect(orchestratorRule).toContain("Start with 2-3 concurrent implementation subagents for the first clean batch");
		expect(orchestratorRule).toContain("Do not invent extra planned parallel batches beyond the explicit `(P)` set");
		expect(dispatchSkill).toContain("## Planned Work and `(P)` Markers");
		expect(dispatchSkill).toContain("Treat them as strong evidence");
		expect(dispatchSkill).toContain("Start with 2-3 agents in the first batch");
		expect(implementationEngine).toContain("For planned work, parallel fan-out is driven by sibling units explicitly marked `(P)`");
		expect(implementationEngine).toContain("Treat `(P)` as strong evidence, not blind trust");
		expect(implementationEngine).toContain("Start planned parallel execution with 2-3 Task-tool subagents");
	});
	test("agent config disables worktree-policy extension", async () => {
		const config = await readFile(configPath);
		expect(config).toMatch(/disabledExtensions:\s*[\r\n]+\s*- extension-module:worktree-policy/);
	});
});

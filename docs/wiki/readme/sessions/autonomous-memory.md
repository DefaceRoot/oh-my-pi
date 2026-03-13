# Autonomous Memory

This document provides a detailed overview of the Autonomous Memory system, which extracts and consolidates knowledge from past sessions to inject into the system prompt at startup . This system operates in the background, ensuring it does not interfere with active sessions . Memory is isolated per project and stored under `~/.omp/agent/memories/` .

## Overview

The Autonomous Memory system is designed to manage and leverage learned context from previous interactions . It employs a two-phase pipeline to process session history and generate reusable knowledge .

### Key Features
*   **Autonomous Extraction and Consolidation**: The system automatically extracts durable knowledge from session history and consolidates it into reusable skills and guidance .
*   **Project Isolation**: Memories are isolated per project (working directory) to prevent cross-project contamination .
*   **System Prompt Injection**: A compact summary of learned context is automatically injected into the system prompt at session startup .
*   **Background Processing**: The memory pipeline runs in the background and does not block the active session .
*   **Configurable Settings**: Various aspects of the memory system, such as concurrency limits, lease timeouts, token budgets, and rollout age constraints, are configurable .

## Architecture

The memory system operates in two main phases:

### Stage 1: Knowledge Extraction
This phase extracts durable knowledge from session history . It processes individual session rollouts to generate summaries and raw memories .

### Phase 2: Knowledge Consolidation
This phase consolidates the extracted knowledge into reusable skills and guidance . It takes raw memories and rollout summaries as input to produce a consolidated memory markdown, a memory summary, and a list of skills .

The `runConsolidationModel` function in `packages/coding-agent/src/memories/index.ts` is responsible for this consolidation . It uses a language model to process the input and generate structured output, including `memory_md`, `memory_summary`, and `skills` .

```typescript
async function runConsolidationModel(options: { memoryRoot: string; model: Model; apiKey: string }): Promise<{
	memoryMd: string;
	memorySummary: string;
	skills: Array<{
		name: string;
		content: string;
		scripts: ConsolidationSkillFileSchema[];
		templates: ConsolidationSkillFileSchema[];
		examples: ConsolidationSkillFileSchema[];
	}>;
}> {
	const { memoryRoot, model, apiKey } = options;
	const rawMemories = await Bun.file(path.join(memoryRoot, "raw_memories.md")).text();
	const rolloutSummaries = await readRolloutSummaries(memoryRoot);
	const input = renderPromptTemplate(consolidationTemplate, {
		raw_memories: truncateByApproxTokens(rawMemories, 20_000),
		rollout_summaries: truncateByApproxTokens(rolloutSummaries, 12_000),
	});

	const response = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
		},
		{ apiKey, maxTokens: 8192, reasoning: Effort.Medium },
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "phase2 model error");
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n")
		.trim();
	const parsed = parseJsonObject(text);
	if (!parsed) throw new Error("phase2 JSON parse failure");
	const schemaOutput = parseConsolidationOutputSchema(parsed);
	if (!schemaOutput) throw new Error("phase2 JSON schema validation failure");
	const memoryMd = redactSecrets(schemaOutput.memory_md).trim();
	const memorySummary = redactSecrets(schemaOutput.memory_summary).trim();
	const skills = schemaOutput.skills
		.map(item => {
			const name = sanitizeSkillName(item.name.trim());
			const content = redactSecrets(item.content ?? "").trim();
			if (!name || !content) return null;
			return {
				name,
				content,
				scripts: sanitizeConsolidationSkillFiles(item.scripts, "scripts"),
				templates: sanitizeConsolidationSkillFiles(item.templates, "templates"),
				examples: sanitizeConsolidationSkillFiles(item.examples, "examples"),
			};
		})
		.filter(
			(
				item,
			): item is {
				name: string;
				content: string;
				scripts: ConsolidationSkillFileSchema[];
				templates: ConsolidationSkillFileSchema[];
				examples: ConsolidationSkillFileSchema[];
			} => item !== null,
		);
	if (!memoryMd || !memorySummary) {
		throw new Error("phase2 returned empty consolidated memory");
	}
	return { memoryMd, memorySummary, skills };
}
```


## Storage

Memory data is stored under `~/.omp/agent/memories/` . This includes `MEMORY.md` for the consolidated memory, `memory_summary.md` for the summary injected into the system prompt, and a `skills` directory containing individual skill markdown files  . A SQLite database is used for the job queue for distributed memory processing .

## Configuration

Autonomous Memory behavior is controlled by settings under the `memories` namespace . These settings are defined in `packages/coding-agent/src/config/settings-schema.ts` .

| Setting | Type | Default | Description |
| :---------------------------- | :------- | :------ | :----------------------------------------------------------- |
| `memories.enabled` | boolean | `false` | Enable autonomous memory extraction and consolidation  |
| `memories.maxRolloutsPerStartup` | number | `64` | Maximum number of rollouts to process per startup  |
| `memories.maxRolloutAgeDays` | number | `30` | Maximum age in days for rollouts to be considered for memory  |
| `memories.minRolloutIdleHours` | number | `12` | Minimum idle hours for a rollout to be considered for memory  |
| `memories.threadScanLimit` | number | `300` | Limit on the number of threads to scan for memory extraction  |
| `memories.maxRawMemoriesForGlobal` | number | `200` | Maximum number of raw memories to consider for global consolidation  |
| `memories.stage1Concurrency` | number | `8` | Concurrency limit for Stage 1 memory processing  |
| `memories.stage1LeaseSeconds` | number | `120` | Lease duration in seconds for Stage 1 tasks  |
| `memories.stage1RetryDelaySeconds` | number | `120` | Retry delay in seconds for failed Stage 1 tasks  |
| `memories.phase2LeaseSeconds` | number | `180` | Lease duration in seconds for Phase 2 tasks  |
| `memories.phase2RetryDelaySeconds` | number | `180` | Retry delay in seconds for failed Phase 2 tasks  |
| `memories.phase2HeartbeatSeconds` | number | `30` | Heartbeat interval in seconds for Phase 2 tasks  |
| `memories.rolloutPayloadPercent` | number | `0.7` | Percentage of rollout payload to include in memory processing  |
| `memories.fallbackTokenLimit` | number | `16000` | Fallback token limit for memory processing  |
| `memories.summaryInjectionTokenLimit` | number | `5000` | Token limit for the memory summary injected into the system prompt  |

## Usage

The Autonomous Memory system can be managed via the `/memory` slash command .

### Slash Commands

*   `/memory view`: Shows the current memory injection payload . This is handled by the `handleMemoryCommand` function in `packages/coding-agent/src/modes/controllers/command-controller.ts` .
*   `/memory clear`: Deletes all memory data and artifacts . This is implemented by `clearMemoryData` in `packages/coding-agent/src/memories/index.ts`  and called by `handleMemoryCommand` .
*   `/memory reset`: Alias for `/memory clear` .
*   `/memory enqueue`: Forces consolidation at the next startup . This is implemented by `enqueueMemoryConsolidation` in `packages/coding-agent/src/memories/index.ts`  and called by `handleMemoryCommand` .
*   `/memory rebuild`: Alias for `/memory enqueue` .

### Memory Injection

At session start, a compact summary of learned context is injected into the system prompt <

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_4f25c873-188b-4ada-840c-460dd2d2e066


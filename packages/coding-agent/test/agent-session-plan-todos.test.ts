import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession plan todo prepopulation", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-plan-todos-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	async function createSessionWithPlan(
		planContent: string | undefined,
		planFilePath = ".omp/sessions/plans/reentry-plan/plan.md",
		persistedTodoPhases?: unknown[],
	): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		if (planContent !== undefined) {
			const resolvedPlanPath = path.resolve(tempDir.path(), planFilePath);
			await fs.mkdir(path.dirname(resolvedPlanPath), { recursive: true });
			await fs.writeFile(resolvedPlanPath, planContent, "utf8");
		}
		sessionManager.appendCustomEntry("implementation-engine/plan-new-metadata", {
			planFilePath,
			updatedAt: Date.now(),
		});
		if (persistedTodoPhases !== undefined) {
			sessionManager.appendMessage({
				role: "toolResult",
				toolName: "todo_write",
				content: [{ type: "text", text: "Persisted todo phases" }],
				details: { phases: persistedTodoPhases },
				isError: false,
			} as never);
		}
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	it("prepopulates todo phases from the linked plan when parsing succeeds", async () => {
		session = await createSessionWithPlan(
			[
				"# Example Plan",
				"",
				"## Phased Implementation Plan",
				"",
				"### Phase 1 — Bootstrap",
				"**Goal:** Prepare plan parsing.",
				"",
				"#### Unit 1.1: Parse headings",
				"**Depends on:** None",
				"",
				"#### 1.2 — Wire session bootstrap (P)",
				"**Depends on:** Unit 1.1",
				"",
				"### Phase 2 — Validation",
				"**Goal:** Keep manual fallback available.",
			].join("\n"),
		);

		expect(session.getTodoPhases()).toEqual([
			{
				id: "phase-1",
				name: "Phase 1 — Bootstrap",
				tasks: [
					{
						id: "task-1",
						content: "Unit 1.1: Parse headings",
						status: "in_progress",
						notes: "Depends on: None",
					},
					{
						id: "task-2",
						content: "1.2: Wire session bootstrap (P)",
						status: "pending",
						notes: "Depends on: Unit 1.1",
					},
				],
			},
			{
				id: "phase-2",
				name: "Phase 2 — Validation",
				tasks: [
					{
						id: "task-3",
						content: "Keep manual fallback available.",
						status: "pending",
						notes: undefined,
					},
				],
			},
		]);
	});

	it("keeps manual bootstrap required when plan parsing is incomplete", async () => {
		session = await createSessionWithPlan(
			[
				"# Example Plan",
				"",
				"## Phased Implementation Plan",
				"",
				"### Phase 1 — Bootstrap",
				"**Goal:** Prepare plan parsing.",
				"",
				"#### Notes",
				"Document constraints.",
				"",
				"#### Risks",
				"Capture fallback behavior.",
				"",
				"#### Unit 1.1: Parse headings",
				"**Depends on:** None",
			].join("\n"),
		);

		expect(session.getTodoPhases()).toEqual([]);
	});

	it("does not repopulate todos when persisted todo state is explicitly empty", async () => {
		session = await createSessionWithPlan(
			[
				"# Example Plan",
				"",
				"## Phased Implementation Plan",
				"",
				"### Phase 1 — Bootstrap",
				"**Goal:** Prepare plan parsing.",
				"",
				"#### Unit 1.1: Parse headings",
				"**Depends on:** None",
			].join("\n"),
			".omp/sessions/plans/reentry-plan/plan.md",
			[],
		);

		expect(session.getTodoPhases()).toEqual([]);
	});

	it("falls back to manual initialization when plan path resolution fails", async () => {
		session = await createSessionWithPlan(undefined, "local://broken%zz/plan.md");

		expect(session.getTodoPhases()).toEqual([]);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir, getProjectAgentDir } from "@oh-my-pi/pi-utils";

describe("AgentSession compaction todo preservation", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let extensionRunner: ExtensionRunner;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-todo-");
		sessionManager = SessionManager.create(tempDir.path());
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);

		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		await tempDir.remove();
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
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
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner,
		});
	}

	function seedCompactableHistory(currentSession: AgentSession): void {
		const model = currentSession.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const timestamp = Date.now();
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "start work" }],
			attribution: "user" as const,
			timestamp,
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: timestamp + 1,
		};

		currentSession.agent.appendMessage(userMessage);
		sessionManager.appendMessage(userMessage);
		currentSession.agent.appendMessage(assistantMessage);
		sessionManager.appendMessage(assistantMessage);
	}

	it("restores cached todo state after compaction rewrites the branch", async () => {
		session = createSession();
		seedCompactableHistory(session);

		const phases: TodoPhase[] = [
			{
				id: "phase-1",
				name: "Execution",
				tasks: [{ id: "task-1", content: "Track preserved work", status: "in_progress" }],
			},
		];
		session.setTodoPhases(phases);

		await session.compact();

		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		expect(compactionEntry).toBeDefined();
		if (!compactionEntry || compactionEntry.type !== "compaction") {
			throw new Error("Expected compaction entry");
		}
		expect(compactionEntry.preserveData).toEqual(
			expect.objectContaining({
				todoWrite: {
					phases,
				},
			}),
		);

		await session.dispose();
		session = undefined;

		const restored = createSession();
		expect(restored.getTodoPhases()).toEqual(phases);
		await restored.dispose();
	});
});

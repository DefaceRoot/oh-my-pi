import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type {
	SubagentIndexSnapshot,
	SubagentViewGroup,
	SubagentViewRef,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

beforeAll(async () => {
	await initTheme(false);
});

/**
 * Hot-path absence tests for the active viewer navigation path.
 *
 * Guard against reintroducing synchronous filesystem discovery
 * on the viewer navigation hot path. When the SubagentIndex snapshot is
 * populated, navigateSubagentView and refreshActiveViewerTranscript must resolve
 * groups from the in-memory snapshot rather than calling collectSubagentViewRefs.
 *
 * Production gap: when the snapshot has empty refs AND empty groups,
 * `getSnapshotGroups()` falls through to the legacy `collectSubagentViewRefs()`.
 * This is expected to be fixed in Unit 2.5 wiring. The empty-snapshot edge case
 * is not tested here for that reason.
 */

function makeRef(id: string, overrides?: Partial<SubagentViewRef>): SubagentViewRef {
	return {
		id,
		rootId: id,
		agent: "explore",
		model: "claude-sonnet-4-20250514",
		description: `Task for ${id}`,
		sessionPath: `/tmp/sessions/${id}.jsonl`,
		lastUpdatedMs: Date.now(),
		tokens: 1200,
		status: "completed",
		...overrides,
	};
}

function makeGroup(rootId: string, refs: SubagentViewRef[]): SubagentViewGroup {
	return {
		rootId,
		refs,
		lastUpdatedMs: Math.max(...refs.map(r => r.lastUpdatedMs ?? 0)),
	};
}

function makeSnapshot(refs: SubagentViewRef[], groups: SubagentViewGroup[], version = 1): SubagentIndexSnapshot {
	return { version, updatedAt: Date.now(), refs, groups };
}

/**
 * Build a minimal InteractiveMode instance with a populated snapshot and
 * mock transcript loading so that navigateSubagentView completes without
 * real filesystem or terminal dependencies.
 */
function createModeWithSnapshot(refs: SubagentViewRef[], groups: SubagentViewGroup[]): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as any;
	mode.subagentSnapshot = makeSnapshot(refs, groups);
	mode.subagentViewActiveId = undefined;
	mode.subagentCycleIndex = -1;
	mode.subagentNestedCycleIndex = -1;
	mode.subagentNestedArrowMode = false;
	mode.subagentNavigatorComponent = undefined;
	mode.subagentNavigatorClose = undefined;
	mode.subagentNavigatorOverlay = undefined;
	mode.subagentNavigatorGroups = [];
	mode.subagentSessionViewer = undefined;
	mode.subagentSessionOverlay = undefined;
	mode.subagentCycleSignature = undefined;
	mode.subagentViewRequestToken = 0;
	mode.statusLine = { setHookStatus: vi.fn() };
	mode.ui = {
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
		terminal: { rows: 40, columns: 120 },
	};
	mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
	mode.showStatus = vi.fn();
	mode.showWarning = vi.fn();
	mode.loadMissingTokensForGroups = vi.fn(async () => undefined);

	// Mock transcript loading to avoid real filesystem reads (this is async, not a sync hot path issue)
	mode.loadSubagentTranscript = vi.fn(async (ref: SubagentViewRef) => ({
		source: ref.sessionPath ?? "/tmp/mock.jsonl",
		content: '{"type":"session_init","task":"mock task"}\n',
		sessionContext: { messages: [] },
		model: ref.model ?? "default",
		tokens: ref.tokens ?? 0,
		contextPreview: ref.description,
		skillsUsed: [],
	}));

	// Mock renderSubagentSession to avoid terminal rendering dependencies
	mode.renderSubagentSession = vi.fn(async () => undefined);

	return mode as InteractiveMode;
}

describe("viewer navigation hot path avoids sync FS when snapshot is populated", () => {
	let statSyncSpy: ReturnType<typeof vi.spyOn>;
	let scanSyncSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		statSyncSpy = vi.spyOn(nodeFs, "statSync").mockImplementation(() => {
			throw new Error("statSync called on hot path — sync FS must not be used when snapshot is populated");
		});
		scanSyncSpy = vi.spyOn(Bun.Glob.prototype, "scanSync" as any).mockImplementation(() => {
			throw new Error("scanSync called on hot path — sync FS must not be used when snapshot is populated");
		});
	});

	afterEach(() => {
		statSyncSpy.mockRestore();
		scanSyncSpy.mockRestore();
	});

	test("navigateSubagentView root direction reads groups from snapshot without sync FS", async () => {
		const ref1 = makeRef("0-Explore");
		const ref2 = makeRef("1-Research", { agent: "research" });
		const group1 = makeGroup("0-Explore", [ref1]);
		const group2 = makeGroup("1-Research", [ref2]);
		const mode = createModeWithSnapshot([ref1, ref2], [group1, group2]) as any;

		await mode.navigateSubagentView("root", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalledTimes(1);
		expect(mode.renderSubagentSession).toHaveBeenCalledTimes(1);
	});

	test("navigateSubagentView root backward cycles to last group from snapshot", async () => {
		const ref1 = makeRef("0-Explore");
		const ref2 = makeRef("1-Research", { agent: "research" });
		const group1 = makeGroup("0-Explore", [ref1]);
		const group2 = makeGroup("1-Research", [ref2]);
		const mode = createModeWithSnapshot([ref1, ref2], [group1, group2]) as any;

		await mode.navigateSubagentView("root", -1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.subagentViewActiveId).toBeDefined();
	});

	test("navigateSubagentView nested direction reads from snapshot without sync FS", async () => {
		const rootRef = makeRef("0-Worker", { agent: "implement" });
		const nestedRef = makeRef("0-Worker.0-Lint", {
			agent: "lint",
			rootId: "0-Worker",
			parentId: "0-Worker",
			depth: 1,
		});
		const group = makeGroup("0-Worker", [rootRef, nestedRef]);
		const mode = createModeWithSnapshot([rootRef, nestedRef], [group]) as any;

		// Set active view on root
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;

		await mode.navigateSubagentView("nested", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	// NOTE: empty snapshot falls through to collectSubagentViewRefs() — production gap.
	// The empty-groups path in getSnapshotGroups() does not short-circuit; it falls
	// through to legacy sync discovery. This will be fixed in Unit 2.5 wiring.

	test("refreshActiveViewerTranscript reads groups from snapshot without sync FS", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const mode = createModeWithSnapshot([ref], [group]) as any;

		// Set active viewer state (simulates viewer being open)
		mode.subagentViewActiveId = "0-Explore";
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;

		await mode.refreshActiveViewerTranscript();

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalled();
	});

	test("refreshActiveViewerTranscript exits when active ID vanishes from snapshot", async () => {
		const ref = makeRef("0-Explore");
		const group = makeGroup("0-Explore", [ref]);
		const mode = createModeWithSnapshot([ref], [group]) as any;

		// Set viewer active for a different ID that no longer exists in snapshot
		mode.subagentViewActiveId = "0-Vanished";
		mode.subagentCycleIndex = 0;

		await mode.refreshActiveViewerTranscript();

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
	});

	test("consecutive navigateSubagentView calls cycle through groups from snapshot", async () => {
		const ref1 = makeRef("0-A");
		const ref2 = makeRef("1-B", { agent: "research" });
		const ref3 = makeRef("2-C", { agent: "implement" });
		const groups = [makeGroup("0-A", [ref1]), makeGroup("1-B", [ref2]), makeGroup("2-C", [ref3])];
		const mode = createModeWithSnapshot([ref1, ref2, ref3], groups) as any;

		await mode.navigateSubagentView("root", 1);
		await mode.navigateSubagentView("root", 1);
		await mode.navigateSubagentView("root", 1);

		expect(statSyncSpy).not.toHaveBeenCalled();
		expect(scanSyncSpy).not.toHaveBeenCalled();
		expect(mode.loadSubagentTranscript).toHaveBeenCalledTimes(3);
	});
});

describe("InteractiveMode subagent token loading", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-token-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	test("loadTokensFromSessionPath uses tokens from the latest assistant request with usage", async () => {
		const sessionPath = path.join(tempDir, "cache-aware.jsonl");
		await writeFile(
			sessionPath,
			`${[
				JSON.stringify({
					type: "message",
					message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 } },
				}),
				JSON.stringify({ type: "compaction", summary: "trimmed" }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						usage: {
							inputTokens: 10,
							outputTokens: 8,
							cacheReadInputTokens: 4_000,
							cacheCreationInputTokens: 2_000,
						},
					},
				}),
				JSON.stringify({ type: "handoff", target: "child-session" }),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "no usage" }] },
				}),
			].join("\n")}\n`,
			"utf8",
		);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const tokens = await mode.loadTokensFromSessionPath(sessionPath);

		expect(tokens).toBe(6_018);
	});

	test("loadSubagentTranscript uses latest assistant usage instead of cumulative transcript totals", async () => {
		const sessionPath = path.join(tempDir, "session-usage.jsonl");
		await writeFile(sessionPath, '{"type":"session_init","task":"demo"}\n', "utf8");

		vi.spyOn(SessionManager, "open").mockResolvedValue({
			getEntries: () => [
				{ type: "session_init", task: "demo" },
				{ type: "model_change", model: "claude-sonnet-4-20250514" },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 7, cacheWrite: 3 } },
				},
				{ type: "compaction", summary: "trimmed" },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } },
				},
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "no usage" }] } },
			],
			buildSessionContext: () => ({
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				thinkingLevel: "high",
				models: {},
				injectedTtsrRules: [],
				mode: "none",
				modeData: undefined,
			}),
			getHeader: () => ({ id: "mock-subagent-session" }),
		} as any);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({ id: "cache-subagent", sessionPath } as SubagentViewRef);

		expect(transcript?.tokens).toBe(17);
	});

	test("buildSidebarTokenSection uses current context usage instead of historical session totals", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.session = {
			getContextUsage: () => ({ tokens: 1_200, contextWindow: 200_000, percent: 0.6 }),
		};
		mode.sessionManager = {
			getUsageStatistics: () => ({
				input: 900_000,
				output: 250_000,
				cacheRead: 400_000,
				cacheWrite: 120_000,
				cost: 2.345,
			}),
		};

		const tokens = mode.buildSidebarTokenSection();
		expect(tokens).toMatchObject({
			tokensUsed: 1_200,
			tokensTotal: 200_000,
			contextUsedPercent: 0.6,
			costUsd: 2.345,
		});
	});

	test("buildSidebarTokenSection leaves tokens unset when post-compaction context usage is unknown", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.session = {
			getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
		};
		mode.sessionManager = {
			getUsageStatistics: () => ({
				input: 900_000,
				output: 250_000,
				cacheRead: 400_000,
				cacheWrite: 120_000,
				cost: 2.345,
			}),
		};

		expect(mode.buildSidebarTokenSection()).toBeUndefined();
	});
	test("loadSubagentTranscript context preview skips prompt template headers", async () => {
		const sessionPath = path.join(tempDir, "session-template.jsonl");
		await writeFile(sessionPath, '{"type":"session_init","task":"demo"}\n', "utf8");

		const templatedTask = [
			"═══════════Background═══════════",
			"<context>",
			"## Goal",
			"Shared context",
			"</context>",
			"",
			"═══════════Task═══════════",
			"Your assignment is below. Your work begins now.",
			"<goal>",
			"## Target",
			"- Investigate navigator title fallback",
			"</goal>",
		].join("\n");

		vi.spyOn(SessionManager, "open").mockResolvedValue({
			getEntries: () => [
				{ type: "session_init", task: templatedTask },
				{ type: "model_change", model: "claude-sonnet-4-20250514" },
			],
			buildSessionContext: () => ({
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				thinkingLevel: "high",
				models: {},
				injectedTtsrRules: [],
				mode: "none",
				modeData: undefined,
			}),
			getHeader: () => ({ id: "mock-subagent-session" }),
		} as any);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({
			id: "templated-subagent",
			sessionPath,
		} as SubagentViewRef);

		expect(transcript?.contextPreview).toBe("Investigate navigator title fallback");
		expect(transcript?.contextPreview).not.toContain("Background");
	});

	test("loadSubagentTranscript extracts skills from tool calls that read skill URLs", async () => {
		const sessionPath = path.join(tempDir, "session-skill-read.jsonl");
		await writeFile(sessionPath, '{"type":"session_init","task":"demo"}\n', "utf8");

		vi.spyOn(SessionManager, "open").mockResolvedValue({
			getEntries: () => [
				{ type: "session_init", task: "demo" },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tool-1",
								name: "read",
								arguments: { path: "skill://validate-implementation-plan/references/artifact-output.md" },
							},
						],
					},
				},
			],
			buildSessionContext: () => ({
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				thinkingLevel: "high",
				models: {},
				injectedTtsrRules: [],
				mode: "none",
				modeData: undefined,
			}),
			getHeader: () => ({ id: "mock-subagent-session" }),
		} as any);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({ id: "skill-reader", sessionPath } as SubagentViewRef);

		expect(transcript?.skillsUsed).toEqual(["validate-implementation-plan"]);
	});

	test("loadSubagentTranscript ignores skills listed only in the session prompt", async () => {
		const sessionPath = path.join(tempDir, "session-prompt-skills.jsonl");
		await writeFile(sessionPath, '{"type":"session_init","task":"demo"}\n', "utf8");

		const systemPrompt = [
			"# Skills",
			"Specialized knowledge packs loaded for this session.",
			"",
			"You **MUST** use the following skills, to save you time, when working in their domain:",
			"## validate-implementation-plan",
			"Validate implementation plans before coding by checking requirement traceability, assumption risk, and execution readiness.",
			"## systematic-debugging",
			"Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes",
			"",
			"# Rules",
		].join("\n");

		vi.spyOn(SessionManager, "open").mockResolvedValue({
			getEntries: () => [{ type: "session_init", task: "demo", systemPrompt }],
			buildSessionContext: () => ({
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				thinkingLevel: "high",
				models: {},
				injectedTtsrRules: [],
				mode: "none",
				modeData: undefined,
			}),
		} as any);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({ id: "prompt-skills", sessionPath } as SubagentViewRef);

		expect(transcript?.skillsUsed).toBeUndefined();
	});

	test("loadSubagentTranscript fallback parsing keeps explicit skill usage and latest usage tokens", async () => {
		const sessionPath = path.join(tempDir, "session-fallback-skill-read.jsonl");
		const systemPrompt = [
			"# Skills",
			"Specialized knowledge packs loaded for this session.",
			"",
			"You **MUST** use the following skills, to save you time, when working in their domain:",
			"## systematic-debugging",
			"Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes",
			"## validate-implementation-plan",
			"Validate implementation plans before coding by checking requirement traceability, assumption risk, and execution readiness.",
			"",
			"# Rules",
		].join("\n");
		await writeFile(
			sessionPath,
			`${[
				JSON.stringify({ type: "session_init", task: "demo", systemPrompt }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 },
						content: [
							{
								type: "toolCall",
								id: "tool-1",
								name: "read",
								arguments: { path: "skill://systematic-debugging" },
							},
						],
					},
				}),
				JSON.stringify({ type: "compaction", summary: "trimmed" }),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } },
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "no usage metadata" }] },
				}),
			].join("\n")}\n`,
			"utf8",
		);

		vi.spyOn(SessionManager, "open").mockRejectedValue(new Error("boom"));

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({
			id: "fallback-skill-reader",
			sessionPath,
		} as SubagentViewRef);

		expect(transcript?.skillsUsed).toEqual(["systematic-debugging"]);
		expect(transcript?.tokens).toBe(17);
	});

	test("loadSubagentTranscript loads session metadata and parent context file content", async () => {
		const sessionPath = path.join(tempDir, "session-rich.jsonl");
		const contextPath = path.join(tempDir, "context.md");
		await writeFile(sessionPath, '{"type":"session_init","task":"demo"}\n', "utf8");
		await writeFile(contextPath, "Parent session context\n- constraint A\n- constraint B\n", "utf8");

		vi.spyOn(SessionManager, "open").mockResolvedValue({
			getHeader: () => ({ id: "omp-session-1497" }),
			getEntries: () => [
				{
					type: "session_init",
					task: "Investigate the delegated worker",
					systemPrompt: "system prompt",
					tools: ["read", "grep", "submit_result"],
					contextFile: contextPath,
					mcpServers: ["augment", "grafana"],
					mcpAllowlist: ["augment", "grafana"],
				},
				{ type: "model_change", model: "gpt-5.4" },
			],
			buildSessionContext: () => ({
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				thinkingLevel: "high",
				models: {},
				injectedTtsrRules: [],
				mode: "none",
				modeData: undefined,
			}),
		} as any);

		const mode = Object.create(InteractiveMode.prototype) as any;
		const transcript = await mode.loadSubagentTranscript({ id: "rich-subagent", sessionPath } as SubagentViewRef);

		expect(transcript?.sessionId).toBe("omp-session-1497");
		expect(transcript?.assignment).toContain("Investigate the delegated worker");
		expect(transcript?.parentContext).toContain("constraint A");
		expect(transcript?.contextFilePath).toBe(contextPath);
		expect(transcript?.toolNames).toEqual(["read", "grep", "submit_result"]);
		expect(transcript?.mcpServers).toEqual(["augment", "grafana"]);
	});

	test("renderSubagentTranscriptLines includes parent context and assignment before transcript messages", () => {
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.uiHelpers = {
			renderSessionContextToLines: vi.fn(() => ["assistant: finished verification"]),
		};

		const lines = mode.renderSubagentTranscriptLines(
			{
				source: "/tmp/subagent.jsonl",
				content: "",
				sessionContext: {
					messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				},
				parentContext: "Parent constraints\n- never use inline prompts",
				assignment: "Verify the nested worker flow",
				delegationHistory: ["↳ (23) code-reviewer | Review the verifier patch"],
			},
			100,
		);

		expect(lines.join("\n")).toContain("Parent Session Context");
		expect(lines.join("\n")).toContain("never use inline prompts");
		expect(lines.join("\n")).toContain("Assignment");
		expect(lines.join("\n")).toContain("Verify the nested worker flow");
		expect(lines.join("\n")).toContain("Delegations");
		expect(lines.join("\n")).toContain("code-reviewer");
		expect(lines.join("\n")).toContain("assistant: finished verification");
	});

	test("renderSubagentSession forwards elapsed and session metadata into the viewer content", async () => {
		const setContent = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;
		mode.subagentNestedArrowMode = false;
		mode.subagentSessionViewer = { setContent };
		mode.statusLine = { setHookStatus: vi.fn() };
		mode.ui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
		mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
		mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

		const selected = makeRef("22-VerifyPhase07", {
			agent: "plan-verifier",
			description: "Verify phase 7",
			status: "running",
			elapsedMs: 65_000,
			outcome: { status: "fail", label: "review", summary: "Blocking findings remain" },
		});
		const groups = [makeGroup(selected.id, [selected])];

		await mode.renderSubagentSession(
			selected,
			{
				source: "/tmp/22-VerifyPhase07.jsonl",
				content: "",
				model: "gpt-5.4",
				tokens: 20_052,
				sessionId: "1497dbcec67ecb20",
				toolNames: ["read", "grep", "submit_result"],
				mcpServers: ["augment", "grafana"],
				mcpAllowlist: ["augment"],
				parentContext: "Never use inline prompts",
				assignment: "Verify phase 7 nested worker",
				delegationHistory: ["↳ (23) code-reviewer | Review the verifier patch"],
				skillsUsed: [],
			},
			groups,
		);

		expect(setContent).toHaveBeenCalledTimes(1);
		const payload = setContent.mock.calls[0]?.[0];
		const headerText = plain(payload.headerLines.join("\n"));
		expect(payload.metadata).toMatchObject({
			subagentId: "22-VerifyPhase07",
			sessionId: "1497dbcec67ecb20",
			elapsedMs: 65_000,
			outcome: { status: "fail", label: "review", summary: "Blocking findings remain" },
			toolNames: ["read", "grep", "submit_result"],
			mcpServers: ["augment", "grafana"],
			mcpAllowlist: ["augment"],
			canStop: true,
		});
		expect(headerText).toContain("Task 1/1");
		expect(headerText).toContain("Nested 0/0 descendants");
		expect(headerText).not.toContain("Nested nested");
		expect(headerText).toContain("Source /tmp/22-VerifyPhase07.jsonl");
	});

	test("renderSubagentSession prefers transcript tokens over snapshot totals", async () => {
		const setContent = vi.fn();
		const statusLine = { setHookStatus: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = -1;
		mode.subagentNestedArrowMode = false;
		mode.subagentSessionViewer = { setContent };
		mode.statusLine = statusLine;
		mode.ui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
		mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
		mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

		const selected = makeRef("44-Live", {
			tokens: 120_000,
			status: "running",
			description: "Live token view",
		});
		const groups = [makeGroup(selected.id, [selected])];

		await mode.renderSubagentSession(
			selected,
			{
				source: "/tmp/44-Live.jsonl",
				content: "",
				model: "gpt-5.4",
				tokens: 17,
				skillsUsed: [],
			},
			groups,
		);

		const payload = setContent.mock.calls[0]?.[0];
		const statusText = plain(String(statusLine.setHookStatus.mock.calls.at(-1)?.[1] ?? ""));
		expect(payload.metadata?.tokens).toBe(17);
		expect(statusText).toContain("tokens:17");
		expect(statusText).not.toContain("120,000");
	});

	test("renderSubagentSession falls back to transcript identity when the snapshot ref is missing agent metadata", async () => {
		const setContent = vi.fn();
		const statusLine = { setHookStatus: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = 0;
		mode.subagentNestedArrowMode = false;
		mode.subagentSessionViewer = { setContent };
		mode.statusLine = statusLine;
		mode.ui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
		mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
		mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

		const rootRef = makeRef("0-TokenRollup", {
			agent: "implement",
			description: "Implement canonical token rollup",
			status: "running",
		});
		const selected = makeRef("0-TokenRollup.1-ReviewTotals", {
			agent: undefined,
			rootId: "0-TokenRollup",
			parentId: "0-TokenRollup",
			depth: 1,
			description: "Review token totals",
			status: "completed",
		});
		const groups = [makeGroup("0-TokenRollup", [rootRef, selected])];

		await mode.renderSubagentSession(
			selected,
			{
				source: "/tmp/review-totals.jsonl",
				content: "",
				agentName: "code-reviewer",
				role: "code-reviewer",
				model: "openai-codex/gpt-5.2-codex",
				tokens: 4049,
				skillsUsed: [],
			},
			groups,
		);

		expect(setContent).toHaveBeenCalledTimes(1);
		const payload = setContent.mock.calls[0]?.[0];
		const hierarchyText = plain((payload.hierarchyLines ?? []).join("\n"));
		const statusText = plain(String(statusLine.setHookStatus.mock.calls.at(-1)?.[1] ?? ""));
		expect(payload.metadata).toMatchObject({
			agentName: "code-reviewer",
			role: "code-reviewer",
			subagentId: "0-TokenRollup.1-ReviewTotals",
		});
		expect(hierarchyText).toContain("↳ (1) code-reviewer | Review token totals");
		expect(statusText).toContain("agent:1/1 code-reviewer");
	});

	test("renderSubagentSession uses neutral placeholders when agent metadata is missing", async () => {
		const setContent = vi.fn();
		const statusLine = { setHookStatus: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as any;
		mode.subagentCycleIndex = 0;
		mode.subagentNestedCycleIndex = 0;
		mode.subagentNestedArrowMode = false;
		mode.subagentSessionViewer = { setContent };
		mode.statusLine = statusLine;
		mode.ui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
		mode.keybindings = { getDisplayString: vi.fn(() => "Ctrl+X") };
		mode.inputController = { cycleAgentMode: vi.fn(async () => undefined) };

		const rootRef = makeRef("0-LegacyRoot", {
			agent: undefined,
			description: "Legacy root assignment",
			status: "running",
		});
		const selected = makeRef("0-LegacyRoot.0-LegacyChild", {
			agent: undefined,
			rootId: "0-LegacyRoot",
			parentId: "0-LegacyRoot",
			depth: 1,
			description: "Legacy nested assignment",
		});
		const groups = [makeGroup("0-LegacyRoot", [rootRef, selected])];

		await mode.renderSubagentSession(
			selected,
			{
				source: "/tmp/legacy.jsonl",
				content: "",
				model: "gpt-5.4",
				tokens: 1337,
				skillsUsed: [],
			},
			groups,
		);

		expect(setContent).toHaveBeenCalledTimes(1);
		const payload = setContent.mock.calls[0]?.[0];
		const hierarchyText = plain((payload.hierarchyLines ?? []).join("\n"));
		const statusText = plain(String(statusLine.setHookStatus.mock.calls.at(-1)?.[1] ?? ""));
		expect(payload.metadata).toMatchObject({ agentName: "—", subagentId: "0-LegacyRoot.0-LegacyChild" });
		expect(hierarchyText).toContain("(0) — | Legacy root assignment");
		expect(hierarchyText).toContain("↳ (0) — | Legacy nested assignment");
		expect(statusText).toContain("task 1/1");
		expect(statusText).toContain("agent:1/1 —");
		expect(statusText).not.toContain("agent:1/1 task");
	});
});

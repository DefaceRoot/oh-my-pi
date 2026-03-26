/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */
import path from "node:path";
import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ImageContent, Model, ToolChoice } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import Ajv, { type ValidateFunction } from "ajv";
import type { SkillConfig } from "../config/roles-config";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import { type PromptTemplate, renderPromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { Skill } from "../extensibility/skills";
import type { MCPManager } from "../mcp/manager";
import submitReminderTemplate from "../prompts/system/subagent-submit-reminder.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import type { ContextFileEntry } from "../tools";
import { jtdToJsonSchema } from "../tools/jtd-to-json-schema";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import { getTotalUsageTokens } from "../utils/usage-tokens";
import { deriveSubagentOutcomeFromReviewData, type SubagentOutcome } from "./subagent-outcome";
import {
	registerSubagentRuntime,
	resumeSubagentRuntime,
	type SubagentRuntimeLookup,
	unregisterSubagentRuntime,
} from "./subagent-runtime-registry";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { validateSuccessToolRequirements } from "./success-evidence";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ReviewFinding,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function getReportFindingKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : null;
	const filePath = typeof record.file_path === "string" ? record.file_path : null;
	const lineStart = typeof record.line_start === "number" ? record.line_start : null;
	const lineEnd = typeof record.line_end === "number" ? record.line_end : null;
	const priority = typeof record.priority === "string" ? record.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	runtimeRole?: string;
	task: string;
	assignment?: string;
	description?: string;
	index: number;
	id: string;
	modelOverride?: string | string[];
	thinkingLevel?: ThinkingLevel;
	outputSchema?: unknown;
	images?: ImageContent[];
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	resumePrompt?: string;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	/** Path to parent conversation context file */
	contextFile?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	mcpManager?: MCPManager;
	/** Allowed MCP server names for subagent to load (when parent manager doesn't have them) */
	mcpAllowlist?: readonly string[];
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/** V2 skill configuration for this agent from roles.yml */
	skillConfig?: SkillConfig;
	/**
	 * When set, open this session file to restore full conversation history before resuming.
	 * The entry is removed from cancelledSubagents and the session continues from the prior context.
	 */
	resumeFromSessionFile?: string;
}

const DEFAULT_SUBAGENT_RESUME_PROMPT = "Continue where you left off.";
const SUBAGENT_RESUME_ABORT_REASON = "Resume requested";

/** Metadata stored for a subagent session that can be resumed later. */
export interface ResumableSubagentMetadata {
	/** Subagent runtime id. */
	id: string;
	/** Path to the persisted session file. */
	sessionFile: string;
	/** OMP session id at time of storage. */
	sessionId: string | undefined;
	/** Original executor options, minus transient runtime-only fields. */
	options: Omit<ExecutorOptions, "signal" | "resumePrompt">;
	/** Timestamp (ms) when this resumable session was recorded. */
	storedAt: number;
	/** Human-readable abort reason, if available. */
	abortReason: string | undefined;
}

const resumableSubagentsById = new Map<string, ResumableSubagentMetadata>();
const resumableSubagentIdsBySessionId = new Map<string, string>();
const resumableSubagentIdsBySessionPath = new Map<string, string>();

export const cancelledSubagents = new Map<string, ResumableSubagentMetadata>();

function resolveResumableSubagentId(lookup: SubagentRuntimeLookup): string | undefined {
	if (lookup.id && resumableSubagentsById.has(lookup.id)) {
		return lookup.id;
	}
	if (lookup.sessionId) {
		const id = resumableSubagentIdsBySessionId.get(lookup.sessionId);
		if (id) return id;
	}
	if (lookup.sessionPath) {
		const id = resumableSubagentIdsBySessionPath.get(lookup.sessionPath);
		if (id) return id;
	}
	return undefined;
}

function rememberResumableSubagent(metadata: ResumableSubagentMetadata): void {
	deleteResumableSubagent(metadata.id);
	resumableSubagentsById.set(metadata.id, metadata);
	if (metadata.sessionId) {
		resumableSubagentIdsBySessionId.set(metadata.sessionId, metadata.id);
	}
	resumableSubagentIdsBySessionPath.set(metadata.sessionFile, metadata.id);
}

function deleteResumableSubagent(id: string): void {
	const existing = resumableSubagentsById.get(id);
	if (!existing) return;
	resumableSubagentsById.delete(id);
	if (existing.sessionId) {
		resumableSubagentIdsBySessionId.delete(existing.sessionId);
	}
	resumableSubagentIdsBySessionPath.delete(existing.sessionFile);
}

export function getResumableSubagentMetadata(lookup: SubagentRuntimeLookup): ResumableSubagentMetadata | undefined {
	const resumableId = resolveResumableSubagentId(lookup);
	return resumableId ? resumableSubagentsById.get(resumableId) : undefined;
}

export function clearResumableSubagentRegistry(): void {
	resumableSubagentsById.clear();
	resumableSubagentIdsBySessionId.clear();
	resumableSubagentIdsBySessionPath.clear();
}

function buildSubagentResumePrompt(continueMessage?: string): string {
	const trimmed = continueMessage?.trim();
	return trimmed || DEFAULT_SUBAGENT_RESUME_PROMPT;
}

async function launchResumedSubagent(metadata: ResumableSubagentMetadata, continueMessage?: string): Promise<boolean> {
	deleteResumableSubagent(metadata.id);
	const resumeOptions: ExecutorOptions = {
		...metadata.options,
		sessionFile: metadata.sessionFile,
		resumePrompt: buildSubagentResumePrompt(continueMessage),
	};
	void runSubprocess(resumeOptions).catch(err => {
		rememberResumableSubagent(metadata);
		logger.error("Failed to restart resumable subagent", {
			id: metadata.id,
			error: err instanceof Error ? err.message : String(err),
		});
	});
	return true;
}

export async function resumeSubagent(lookup: SubagentRuntimeLookup, continueMessage?: string): Promise<boolean> {
	if (await resumeSubagentRuntime(lookup, continueMessage)) {
		return true;
	}
	const metadata = getResumableSubagentMetadata(lookup);
	if (!metadata) return false;
	return await launchResumedSubagent(metadata, continueMessage);
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function normalizeOutputSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}

function buildOutputValidator(schema: unknown): { validate?: ValidateFunction; error?: string } {
	const { normalized, error } = normalizeOutputSchema(schema);
	if (error) return { error };
	if (normalized === undefined) return {};
	const jsonSchema = jtdToJsonSchema(normalized);
	try {
		return { validate: ajv.compile(jsonSchema as any) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function normalizeCompleteData(data: unknown, reportFindings?: ReviewFinding[]): unknown {
	let normalized = parseStringifiedJson(data ?? null);
	if (
		Array.isArray(reportFindings) &&
		reportFindings.length > 0 &&
		normalized &&
		typeof normalized === "object" &&
		!Array.isArray(normalized)
	) {
		const record = normalized as Record<string, unknown>;
		if (!("findings" in record)) {
			normalized = { ...record, findings: reportFindings };
		}
	}
	return normalized;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validate, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validate && !validate(candidate)) return null;
	return { data: candidate };
}

function resolveAbortSignalReasonValue(signal: AbortSignal | undefined, fallback: string): string {
	const reason = signal?.reason;
	if (reason instanceof Error) {
		const message = reason.message.trim();
		if (message.length > 0) return message;
	} else if (typeof reason === "string") {
		const message = reason.trim();
		if (message.length > 0) return message;
	}
	return fallback;
}

export interface SubmitResultItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	outcome?: SubagentOutcome;
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	submitResultItems?: SubmitResultItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaSubmitResult: boolean;
	hasSubmitResult: boolean;
}

export const SUBAGENT_WARNING_NULL_SUBMIT_RESULT = "SYSTEM WARNING: Subagent called submit_result with null data.";
export const SUBAGENT_WARNING_MISSING_SUBMIT_RESULT =
	"SYSTEM WARNING: Subagent exited without calling submit_result tool after 3 reminders.";

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { submitResultItems, reportFindings, doneAborted, signalAborted, outputSchema } = args;
	let abortedViaSubmitResult = false;
	const hasSubmitResult = Array.isArray(submitResultItems) && submitResultItems.length > 0;

	if (hasSubmitResult) {
		const lastSubmitResult = submitResultItems[submitResultItems.length - 1];
		if (lastSubmitResult?.status === "aborted") {
			abortedViaSubmitResult = true;
			exitCode = 0;
			stderr = lastSubmitResult.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastSubmitResult.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastSubmitResult.error || "Unknown error"}"}`;
			}
		} else {
			const submitData = lastSubmitResult?.data;
			if (submitData === null || submitData === undefined) {
				rawOutput = rawOutput
					? `${SUBAGENT_WARNING_NULL_SUBMIT_RESULT}\n\n${rawOutput}`
					: SUBAGENT_WARNING_NULL_SUBMIT_RESULT;
			} else {
				const completeData = normalizeCompleteData(submitData, reportFindings);
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize submit_result data: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeOutputSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const completeData = normalizeCompleteData(fallback.data, reportFindings);
			try {
				rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
			}
			exitCode = 0;
			stderr = "";
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			rawOutput = rawOutput
				? `${SUBAGENT_WARNING_MISSING_SUBMIT_RESULT}\n\n${rawOutput}`
				: SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaSubmitResult, hasSubmitResult };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

function resolveSubmitResultOutcome(item: SubmitResultItem | undefined): SubagentOutcome | undefined {
	return item?.outcome ?? deriveSubagentOutcomeFromReviewData(item?.data);
}

function createSubagentSettings(baseSettings: Settings): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	return Settings.isolated({ ...snapshot, "async.enabled": false, "compaction.autoContinue": false });
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
		images,
	} = options;
	const startTime = Date.now();
	let lastActivityMs = startTime;

	// Initialize progress
	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: options.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		startedAt: startTime,
		lastUpdatedMs: startTime,
		modelOverride,
	};
	const syncProgressModel = (activeModel: { provider: string; id: string } | null | undefined): void => {
		progress.provider = activeModel?.provider;
		progress.model = activeModel?.id;
	};
	const executedToolNames = new Set<string>();

	// Check if already aborted
	if (signal?.aborted) {
		const preStartAbortReason = resolveAbortSignalReasonValue(signal, "Cancelled before start");
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: preStartAbortReason,
			truncated: false,
			durationMs: 0,
			tokens: 0,
			startedAt: startTime,
			lastUpdatedMs: startTime,
			modelOverride,
			error: preStartAbortReason,
			aborted: true,
			abortReason: preStartAbortReason,
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	const subagentSettings = createSubagentSettings(settings);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	const pythonToolMode = settings.get("python.toolMode") ?? "both";
	if (toolNames?.includes("exec")) {
		const expanded = toolNames.filter(name => name !== "exec");
		if (pythonToolMode === "bash-only") {
			expanded.push("bash");
		} else if (pythonToolMode === "ipy-only") {
			expanded.push("python");
		} else {
			expanded.push("python", "bash");
		}
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const initialPrompt = options.resumePrompt?.trim() || task;
	deleteResumableSubagent(id);
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("python");

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let stderr = "";
	let resolved = false;
	type AbortReason = "signal" | "terminate";
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let explicitAbortReasonText: string | undefined;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let unsubscribe: (() => void) | null = null;
	let submitResultCalled = false;
	const MAX_ABORTED_CONTINUE_ATTEMPTS = 3;
	const MAX_SUBMIT_RESULT_ERROR_ATTEMPTS = 12;
	const SUBMIT_RESULT_ONLY_PROMPT_TIMEOUT_MS = 90_000;
	const CONTINUE_AFTER_COMPACTION_PROMPT = "Continue if you have next steps.";
	let submitResultOnlyMode = false;
	let submitResultErrorAttempts = 0;
	let submitResultErrorLoopDetected = false;
	let submitResultPromptTimedOut = false;
	let lastSubmitResultErrorText = "";

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;
	const accountedAssistantUsageMessages = new WeakSet<object>();

	const requestAbort = (reason: AbortReason, reasonText?: string) => {
		if (reasonText?.trim()) {
			explicitAbortReasonText = reasonText.trim();
		}
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort("signal");
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true, signal: listenerSignal });
	}

	const resolveSignalAbortReason = (): string => {
		if (explicitAbortReasonText) {
			return explicitAbortReasonText;
		}
		return resolveAbortSignalReasonValue(signal, "Cancelled by caller");
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		progress.lastUpdatedMs = lastActivityMs;
		onProgress?.({ ...progress });
		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				progress: { ...progress },
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const getToolResultText = (result: unknown): string => {
		if (!result || typeof result !== "object" || !("content" in result)) return "";
		const content = (result as { content?: unknown }).content;
		if (!Array.isArray(content)) return "";
		const textBlocks: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			textBlocks.push(record.text);
		}
		return textBlocks.join("\n");
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = lines.slice(-8).reverse();
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		updateRecentOutputLines();
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;

		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				event,
			});
		}

		const now = Date.now();
		lastActivityMs = now;
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				break;

			case "tool_execution_start": {
				executedToolNames.add(event.toolName);
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;

				if (event.toolName === "submit_result") {
					if (event.isError) {
						lastSubmitResultErrorText = getToolResultText(event.result);
						if (submitResultOnlyMode) {
							submitResultErrorAttempts++;
							if (
								submitResultErrorAttempts >= MAX_SUBMIT_RESULT_ERROR_ATTEMPTS &&
								!submitResultErrorLoopDetected
							) {
								submitResultErrorLoopDetected = true;
								requestAbort("terminate");
							}
						}
					} else {
						submitResultCalled = true;
						submitResultErrorAttempts = 0;
						lastSubmitResultErrorText = "";
					}
				}

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							progress.extractedToolData = progress.extractedToolData || {};
							const existing = progress.extractedToolData[event.toolName] || [];
							const findingKey = event.toolName === "report_finding" ? getReportFindingKey(data) : null;
							if (findingKey) {
								const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
								if (existingIndex >= 0) {
									existing[existingIndex] = data;
								} else {
									existing.push(data);
								}
							} else {
								existing.push(data);
							}
							progress.extractedToolData[event.toolName] = existing;
							if (event.toolName === "submit_result") {
								progress.outcome = resolveSubmitResultOutcome(data as SubmitResultItem);
							}
						}
					}

					// Check if handler wants to terminate the session
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						requestAbort("terminate");
					}
				}
				flushProgress = true;
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								outputChunks.push(block.text);
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					const messageUsageTokens = getTotalUsageTokens(messageUsage) ?? 0;
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const assistantMessageKey =
							event.message && typeof event.message === "object" ? event.message : undefined;
						const shouldAccumulateUsage =
							assistantMessageKey === undefined || !accountedAssistantUsageMessages.has(assistantMessageKey);

						if (assistantMessageKey && shouldAccumulateUsage) {
							accountedAssistantUsageMessages.add(assistantMessageKey);
						}

						if (shouldAccumulateUsage) {
							const usageRecord = messageUsage as Record<string, unknown>;
							const costRecord = (messageUsage as { cost?: Record<string, unknown> }).cost;
							hasUsage = true;
							accumulatedUsage.input +=
								firstNumberField(usageRecord, ["input", "input_tokens", "inputTokens"]) ?? 0;
							accumulatedUsage.output +=
								firstNumberField(usageRecord, ["output", "output_tokens", "outputTokens"]) ?? 0;
							accumulatedUsage.cacheRead +=
								firstNumberField(usageRecord, [
									"cacheRead",
									"cache_read",
									"cacheReadTokens",
									"cache_read_tokens",
									"cacheReadInputTokens",
									"cache_read_input_tokens",
								]) ?? 0;
							accumulatedUsage.cacheWrite +=
								firstNumberField(usageRecord, [
									"cacheWrite",
									"cache_write",
									"cacheWriteTokens",
									"cache_write_tokens",
									"cacheCreationInputTokens",
									"cache_creation_input_tokens",
									"cacheWriteInputTokens",
									"cache_write_input_tokens",
								]) ?? 0;
							accumulatedUsage.totalTokens += messageUsageTokens;
							if (costRecord) {
								accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
								accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
								accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
								accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
								accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							}
						}
						// Keep live token displays pinned to latest assistant request usage.
						progress.tokens = messageUsageTokens;
					}
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	let resumeRequested = false;
	let resolveStoredMetadata: (metadata: ResumableSubagentMetadata | null) => void = () => {};
	const storedMetadataReady = new Promise<ResumableSubagentMetadata | null>(resolve => {
		resolveStoredMetadata = resolve;
	});

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				exitCode = 1;
				throw new ToolAbortError();
			}
		};

		try {
			checkAbort();
			const authStorage = options.authStorage ?? (await discoverAuthStorage());
			checkAbort();
			const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
			await modelRegistry.refresh();
			checkAbort();

			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
			} = resolveModelOverride(modelPatterns, modelRegistry, settings);
			const effectiveThinkingLevel = explicitThinkingLevel
				? resolvedThinkingLevel
				: (thinkingLevel ?? resolvedThinkingLevel);

			// When resuming a cancelled subagent, restore history from the prior session file.
			// Remove from the store before starting to prevent concurrent double-resume.
			if (options.resumeFromSessionFile) {
				cancelledSubagents.delete(id);
			}
			const sessionManager = options.resumeFromSessionFile
				? await SessionManager.open(options.resumeFromSessionFile)
				: sessionFile
					? await SessionManager.open(sessionFile)
					: SessionManager.inMemory(worktree ?? cwd);

			const inheritedMcpTools = options.mcpManager?.getTools() ?? [];
			const enableMCP = !options.mcpManager;

			const { normalized: normalizedOutputSchema } = normalizeOutputSchema(outputSchema);

			const { session } = await createAgentSession({
				cwd: worktree ?? cwd,
				authStorage,
				modelRegistry,
				settings: subagentSettings,
				model,
				role: options.runtimeRole ?? agent.name,
				thinkingLevel: effectiveThinkingLevel,
				toolNames,
				outputSchema,
				requireSubmitResultTool: true,
				contextFiles: options.contextFiles,
				// Pass caller-supplied skills directly; loadSkillsWithConfig in createAgentSession will
				// filter this inventory when skillConfig is set. In the normal flow the parent session holds
				// the full discovered skill set, so the filter has the complete inventory to work from.
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				systemPrompt: defaultPrompt =>
					renderPromptTemplate(subagentSystemPromptTemplate, {
						base: defaultPrompt,
						agent: agent.systemPrompt,
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						contextFile: options.contextFile,
					}),
				sessionManager,
				hasUI: false,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				parentTaskPrefix: id,
				enableLsp: lspEnabled,
				skipPythonPreflight,
				enableMCP,
				eventBus: options.eventBus,
				mcpAllowlist: options.mcpAllowlist,
				mcpManager: options.mcpManager,
				customTools: inheritedMcpTools.length > 0 ? inheritedMcpTools : undefined,
				skillConfig: options.skillConfig,
			});

			activeSession = session;
			syncProgressModel(session.model);
			progress.sessionId = session.sessionId;
			progress.thinkingLevel = effectiveThinkingLevel;
			progress.tokenCapacity = session.model?.contextWindow ?? session.model?.maxTokens ?? 0;
			scheduleProgress(true);

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo_write"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await session.setActiveToolsByName(filteredSubagentTools);
			}
			const activeToolNames = session.getActiveToolNames();
			const mcpServers = Array.from(
				new Set(
					(options.mcpManager as { getConnectedServers?: () => string[] } | undefined)?.getConnectedServers?.() ??
						[],
				),
			).sort((left, right) => left.localeCompare(right));
			const mcpAllowlist = [...(options.mcpAllowlist ?? [])].sort((left, right) => left.localeCompare(right));
			progress.toolNames = activeToolNames;
			progress.mcpServers = mcpServers.length > 0 ? mcpServers : undefined;
			progress.mcpAllowlist = mcpAllowlist.length > 0 ? mcpAllowlist : undefined;
			registerSubagentRuntime({
				id,
				sessionId: session.sessionId,
				sessionPath: sessionFile ?? undefined,
				stop: async reason => {
					requestAbort("signal", reason);
					return true;
				},
				resume: async continueMessage => {
					if (resumeRequested) return false;
					resumeRequested = true;
					requestAbort("signal", SUBAGENT_RESUME_ABORT_REASON);
					const storedMetadata = await storedMetadataReady;
					if (!storedMetadata) {
						resumeRequested = false;
						return false;
					}
					return await launchResumedSubagent(storedMetadata, continueMessage);
				},
			});

			const sessionInitExtra = { agentName: agent.name };
			session.sessionManager.appendSessionInit({
				...sessionInitExtra,
				systemPrompt: session.agent.state.systemPrompt,
				task: initialPrompt,
				tools: activeToolNames,
				contextFile: options.contextFile,
				sessionId: session.sessionId,
				mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
				mcpAllowlist: mcpAllowlist.length > 0 ? mcpAllowlist : undefined,
				outputSchema,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void session.abort();
				},
				{ once: true, signal: sessionAbortController.signal },
			);

			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						sendUserMessage: (content, options) => {
							session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => [],
						setModel: async model => {
							const key = await session.modelRegistry.getApiKey(model);
							if (!key) return false;
							await session.setModel(model);
							syncProgressModel(session.model);
							lastActivityMs = Date.now();
							scheduleProgress(true);
							return true;
						},
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort(),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: async instructionsOrOptions => {
							const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
							const options =
								instructionsOrOptions && typeof instructionsOrOptions === "object"
									? instructionsOrOptions
									: undefined;
							await session.compact(instructions, options);
						},
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await extensionRunner.emit({ type: "session_start" });
			}

			const MAX_SUBMIT_RESULT_RETRIES = 3;
			unsubscribe = session.subscribe(event => {
				if (isAgentEvent(event)) {
					try {
						processEvent(event);
					} catch (err) {
						logger.error("Subagent event processing failed", {
							error: err instanceof Error ? err.message : String(err),
						});
						requestAbort("terminate");
					}
				}
			});

			await session.prompt(initialPrompt, { expandPromptTemplates: false, images, attribution: "agent" });
			await session.waitForIdle();

			let abortedContinueCount = 0;
			while (!submitResultCalled && !abortSignal.aborted) {
				const lastAssistant = session.getLastAssistantMessage();
				if (lastAssistant?.stopReason !== "aborted") break;
				abortedContinueCount++;
				if (abortedContinueCount > MAX_ABORTED_CONTINUE_ATTEMPTS) break;
				await session.prompt(CONTINUE_AFTER_COMPACTION_PROMPT, {
					synthetic: true,
					expandPromptTemplates: false,
					skipCompactionCheck: true,
				});
				await session.waitForIdle();
			}

			const reminderToolChoice = buildNamedToolChoice("submit_result", session.model);

			const initialAssistant = session.getLastAssistantMessage();
			const shouldForceSubmitResultReminder = initialAssistant?.stopReason !== "error";
			let retryCount = 0;
			let previousTools: string[] | null = null;
			try {
				while (
					shouldForceSubmitResultReminder &&
					!submitResultCalled &&
					retryCount < MAX_SUBMIT_RESULT_RETRIES &&
					!abortSignal.aborted
				) {
					retryCount++;
					if (!previousTools) {
						previousTools = session.getActiveToolNames();
						await session.setActiveToolsByName(["submit_result"]);
					}
					const reminderBase = renderPromptTemplate(submitReminderTemplate, {
						retryCount,
						maxRetries: MAX_SUBMIT_RESULT_RETRIES,
					});
					const reminder = [
						reminderBase,
						"",
						"<submit-result-contract>",
						"- On success, call submit_result with: { result: { data: <value matching the output schema> } }",
						'- On failure, call submit_result with: { result: { error: "reason" } }',
						"- result MUST contain exactly one of data or error (never both)",
						"- data MUST match the required output schema exactly",
						"- Primitive, array, or null data is valid when the output schema allows it; do not wrap it in an object unless the schema requires that",
						"- Do NOT invent placeholder values; submit the actual result only",
						"- If the output schema is an object with required fields, include them all in result.data before submitting",
						"</submit-result-contract>",
					].join("\n");

					const timeoutId = setTimeout(() => {
						submitResultPromptTimedOut = true;
						requestAbort("terminate");
					}, SUBMIT_RESULT_ONLY_PROMPT_TIMEOUT_MS);
					submitResultOnlyMode = true;
					submitResultErrorAttempts = 0;
					try {
						await session.prompt(reminder, {
							attribution: "agent",
							...(reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
						});
						await session.waitForIdle();
					} finally {
						submitResultOnlyMode = false;
						clearTimeout(timeoutId);
					}
					if (submitResultPromptTimedOut || submitResultErrorLoopDetected) {
						break;
					}
				}
			} finally {
				if (previousTools) {
					await session.setActiveToolsByName(previousTools);
				}
			}
			if (!submitResultCalled && !abortSignal.aborted && shouldForceSubmitResultReminder) {
				aborted = true;
				exitCode = 1;
				abortReasonText ??= SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
				error ??= SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
			}

			const lastAssistant = session.getLastAssistantMessage();
			if (lastAssistant) {
				if (lastAssistant.stopReason === "aborted" && !submitResultCalled) {
					aborted = abortReason === "signal" || abortReason === undefined;
					if (aborted) {
						abortReasonText ??= resolveSignalAbortReason();
					}
					exitCode = 1;
				} else if (lastAssistant.stopReason === "error") {
					exitCode = 1;
					error ??= lastAssistant.errorMessage || "Subagent failed";
				}
			}
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
			unregisterSubagentRuntime(id);
			let storedMetadata: ResumableSubagentMetadata | null = null;
			if ((aborted || exitCode !== 0) && sessionFile) {
				const { signal: _sig, resumePrompt: _resumePrompt, ...storedOptions } = options;
				storedMetadata = {
					id,
					sessionFile,
					sessionId: progress.sessionId,
					options: storedOptions,
					storedAt: Date.now(),
					abortReason: aborted ? abortReasonText : undefined,
				};
				cancelledSubagents.set(id, storedMetadata);
				rememberResumableSubagent(storedMetadata);
			}
			resolveStoredMetadata(storedMetadata);
		}

		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	resolved = true;
	listenerController.abort();

	if (progressTimeoutId) {
		clearTimeout(progressTimeoutId);
		progressTimeoutId = null;
	}

	let exitCode = done.exitCode;
	if (done.error) {
		stderr = done.error;
	}

	// Use final output if available, otherwise accumulated output
	let rawOutput = finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("");
	if (submitResultErrorLoopDetected || submitResultPromptTimedOut) {
		const loopReasons: string[] = [];
		if (submitResultErrorLoopDetected) {
			loopReasons.push(`submit_result returned errors ${submitResultErrorAttempts} times in submit-only mode`);
		}
		if (submitResultPromptTimedOut) {
			loopReasons.push(
				`submit-only reminder prompt exceeded ${Math.round(SUBMIT_RESULT_ONLY_PROMPT_TIMEOUT_MS / 1000)}s timeout`,
			);
		}
		if (lastSubmitResultErrorText) {
			const firstErrorLine = lastSubmitResultErrorText.split("\n").find(line => line.trim().length > 0);
			if (firstErrorLine) {
				loopReasons.push(`last error: ${firstErrorLine}`);
			}
		}
		const warning = `SYSTEM WARNING: Subagent terminated to prevent an infinite submit_result loop (${loopReasons.join("; ")}).`;
		rawOutput = rawOutput ? `${warning}\n\n${rawOutput}` : warning;
		if (!stderr) stderr = warning;
		if (exitCode === 0) exitCode = 1;
	}

	const submitResultItems = progress.extractedToolData?.submit_result as SubmitResultItem[] | undefined;
	const reportFindings = progress.extractedToolData?.report_finding as ReviewFinding[] | undefined;
	const finalized = finalizeSubprocessOutput({
		rawOutput,
		exitCode,
		stderr,
		doneAborted: Boolean(done.aborted),
		signalAborted: Boolean(signal?.aborted),
		submitResultItems,
		reportFindings,
		outputSchema,
	});
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	const lastSubmitResult = submitResultItems?.[submitResultItems.length - 1];
	const submitResultAbortReason =
		lastSubmitResult?.status === "aborted" ? lastSubmitResult.error || "Subagent aborted task" : undefined;
	const outcome = resolveSubmitResultOutcome(lastSubmitResult);
	const { abortedViaSubmitResult, hasSubmitResult } = finalized;
	const successEvidenceFailure =
		exitCode === 0 && !abortedViaSubmitResult ? validateSuccessToolRequirements(agent, executedToolNames) : null;
	if (successEvidenceFailure) {
		const warning = `SYSTEM WARNING: ${successEvidenceFailure}`;
		rawOutput = rawOutput ? `${warning}\n\n${rawOutput}` : warning;
		stderr = warning;
		exitCode = 1;
	}
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (options.artifactsDir) {
		outputPath = path.join(options.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const wasAborted = abortedViaSubmitResult || (!hasSubmitResult && (done.aborted || signal?.aborted || false));
	const finalAbortReason = wasAborted
		? abortedViaSubmitResult
			? submitResultAbortReason
			: (done.abortReason ?? (signal?.aborted ? resolveSignalAbortReason() : "Subagent aborted task"))
		: undefined;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	progress.abortReason = finalAbortReason;
	progress.outcome = outcome;
	scheduleProgress(true);

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: options.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		hasSubmitResult,
		startedAt: progress.startedAt,
		lastUpdatedMs: progress.lastUpdatedMs,
		provider: progress.provider,
		model: progress.model,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		sessionId: progress.sessionId,
		thinkingLevel: progress.thinkingLevel,
		tokenCapacity: progress.tokenCapacity,
		toolNames: progress.toolNames,
		mcpServers: progress.mcpServers,
		mcpAllowlist: progress.mcpAllowlist,
		outcome,
		usage: hasUsage ? accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		outputMeta,
	};
}

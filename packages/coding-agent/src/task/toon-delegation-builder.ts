import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { ToolSession } from "..";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { resolveToCwd } from "../tools/path-utils";
import { collectDelegationContext } from "./delegation-context";

export type InputProfileMode = "minimal" | "standard" | "detailed";

export interface DelegationEnvelope {
	id: string;
	created_at: string;
	parent_envelope_id?: string;
}

export interface DelegationInputPolicy {
	mode: InputProfileMode;
}

export interface DelegationGitContext {
	branch: string;
	commit: string;
	base_branch?: string;
}

export interface DelegationWorktreeContext {
	path: string;
}

export interface DelegationContext {
	repo_root: string;
	workflow_mode?: string;
	plan_path?: string;
	plan_workspace_dir?: string;
	plan_excerpt?: string;
	git?: DelegationGitContext;
	worktree?: DelegationWorktreeContext;
	untrusted_context?: unknown;
}

export interface DelegationRoles {
	delegator: string;
	delegate: string;
}

export interface DelegationProgress {
	completed_tasks?: Array<Record<string, unknown>>;
	upstream_tasks?: Array<Record<string, unknown>>;
	lessons_learned?: string[];
}

export interface DelegationTask {
	id: string;
	title: string;
	description: string;
	constraints: string[];
	acceptance_criteria: string[];
	summary?: string;
	intent?: string;
	blockers?: string[];
}

export type RetryContext = Record<string, unknown>;
export type OutputContract = Record<string, unknown>;

export interface DelegationMetadata {
	contract_version: string;
	envelope: DelegationEnvelope;
	input_policy: DelegationInputPolicy;
	context: DelegationContext;
	roles: DelegationRoles;
	progress?: DelegationProgress;
	task: DelegationTask;
	retry_context?: RetryContext;
	output_contract?: OutputContract;
}

export interface BuildToonDelegationOptions {
	profile?: InputProfileMode;
	parentEnvelopeId?: string;
	progress?: DelegationProgress;
	retryContext?: RetryContext;
	outputContract?: OutputContract;
}

export interface BuildToonDelegationInput {
	session: ToolSession;
	delegate: string;
	task: DelegationTask;
	options?: BuildToonDelegationOptions;
}

export interface DelegationQualityReport {
	warnings: string[];
	errors: string[];
}

export interface ToonDelegationResult {
	toon: string;
	metadata: DelegationMetadata;
	quality_report?: DelegationQualityReport;
	validation_passed: boolean;
}

type PlainObject = Record<string, unknown>;
type Primitive = string | number | boolean | null;

type RuntimeGitMetadata = {
	repo_root?: string;
	branch?: string;
	commit?: string;
	base_branch?: string;
};

type InheritedDelegationContext = {
	repository_cwd?: string;
	parent_runtime_role?: string;
	workflow_mode?: string;
	worktree_path?: string;
	repo_root?: string;
	branch_name?: string;
	base_branch?: string;
	parent_envelope_id?: string;
	envelope_id?: string;
	plan_reference?: string;
	plan_file_path?: string;
	plan_workspace_dir?: string;
	commander_intent?: string;
};

const DELEGATION_CONTEXT_BLOCK_RE = /<delegation_context>\s*([\s\S]*?)<\/delegation_context>/gi;

function parseInheritedDelegationValue(rawValue: string): string | undefined {
	if (!rawValue.trim()) return undefined;
	try {
		const parsed = JSON.parse(rawValue);
		return typeof parsed === "string" ? normalizeText(parsed) : undefined;
	} catch {
		return normalizeText(rawValue);
	}
}

function parseLegacyXmlDelegationContext(text: string | undefined): Partial<InheritedDelegationContext> {
	if (!text) return {};

	let block: string | undefined;
	for (const match of text.matchAll(DELEGATION_CONTEXT_BLOCK_RE)) {
		block = match[1];
	}
	if (!block) return {};

	const context: Partial<InheritedDelegationContext> = {};
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const separatorIndex = line.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		const value = parseInheritedDelegationValue(line.slice(separatorIndex + 1).trim());
		if (!value) continue;
		switch (key) {
			case "repository_cwd":
				context.repository_cwd = value;
				break;
			case "parent_runtime_role":
				context.parent_runtime_role = value;
				break;
			case "workflow_mode":
				context.workflow_mode = value;
				break;
			case "worktree_path":
				context.worktree_path = value;
				break;
			case "repo_root":
				context.repo_root = value;
				break;
			case "branch_name":
				context.branch_name = value;
				break;
			case "base_branch":
				context.base_branch = value;
				break;
			case "parent_envelope_id":
				context.parent_envelope_id = value;
				break;
			case "envelope_id":
				context.envelope_id = value;
				break;
			case "plan_reference":
				context.plan_reference = value;
				break;
			case "plan_file_path":
				context.plan_file_path = value;
				break;
			case "plan_workspace_dir":
				context.plan_workspace_dir = value;
				break;
			case "commander_intent":
				context.commander_intent = value;
				break;
		}
	}

	return context;
}

// ─── TOON block parser for multi-hop inheritance ─────────────────────────────

function extractLastToonDelegationBlock(text: string): string | undefined {
	let lastIdx = -1;
	const re = /^delegation:\s*$/gm;
	for (const match of text.matchAll(re)) {
		lastIdx = match.index ?? -1;
	}
	if (lastIdx < 0) return undefined;

	const afterStart = text.slice(lastIdx);
	const lines = afterStart.split("\n");
	const blockLines: string[] = [lines[0] ?? "delegation:"];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// A non-blank line without leading whitespace ends the block
		if (line.length > 0 && !/^\s/.test(line)) break;
		blockLines.push(line);
	}

	return blockLines.join("\n").trim();
}

function parseToonBlockFields(toonBlock: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = toonBlock.split("\n");
	const stack: Array<{ indent: number; key: string }> = [];

	for (const rawLine of lines) {
		if (!rawLine.trim()) continue;
		const indentSize = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();

		if (line === "delegation:") {
			stack.length = 0;
			continue;
		}

		// Skip array/tabular headers and list items
		if (/\[\d*\]/.test(line.split(":")[0] ?? "")) continue;
		if (line.startsWith("-")) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx <= 0) continue;

		// Pop stack entries at same or higher indent level
		while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indentSize) {
			stack.pop();
		}

		const key = line.slice(0, colonIdx).trim();
		const rawValue = line.slice(colonIdx + 1).trim();
		const currentPath = stack.length > 0 ? `${stack.map(s => s.key).join(".")}.${key}` : key;

		if (rawValue) {
			try {
				const parsed = JSON.parse(rawValue);
				if (typeof parsed === "string") result[currentPath] = parsed;
				else if (typeof parsed === "number" || typeof parsed === "boolean") result[currentPath] = String(parsed);
			} catch {
				result[currentPath] = rawValue;
			}
		} else {
			stack.push({ indent: indentSize, key });
		}
	}

	return result;
}

function parseToonInheritedContext(text: string | undefined): Partial<InheritedDelegationContext> {
	if (!text) return {};

	const block = extractLastToonDelegationBlock(text);
	if (!block) return {};

	const fields = parseToonBlockFields(block);
	const ctx: Partial<InheritedDelegationContext> = {};

	const envelopeId = fields["envelope.id"];
	if (envelopeId) ctx.envelope_id = envelopeId;
	const repoRoot = fields["context.repo_root"];
	if (repoRoot) ctx.repo_root = repoRoot;
	const workflowMode = fields["context.workflow_mode"];
	if (workflowMode) ctx.workflow_mode = workflowMode;
	const planPath = fields["context.plan_path"];
	if (planPath) ctx.plan_file_path = planPath;
	const planWorkspaceDir = fields["context.plan_workspace_dir"];
	if (planWorkspaceDir) ctx.plan_workspace_dir = planWorkspaceDir;
	const branch = fields["context.git.branch"];
	if (branch) ctx.branch_name = branch;
	const baseBranch = fields["context.git.base_branch"];
	if (baseBranch) ctx.base_branch = baseBranch;
	const worktreePath = fields["context.worktree.path"];
	if (worktreePath) ctx.worktree_path = worktreePath;
	const delegatorRole = fields["roles.delegator"];
	if (delegatorRole) ctx.parent_runtime_role = delegatorRole;

	return ctx;
}

function parseInheritedDelegationContext(text: string | undefined): InheritedDelegationContext {
	const legacy = parseLegacyXmlDelegationContext(text);
	const toon = parseToonInheritedContext(text);
	// TOON takes precedence over legacy XML for fields present in both
	const merged: InheritedDelegationContext = { ...legacy };
	for (const [k, v] of Object.entries(toon)) {
		if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
	}
	return merged;
}

const CONTRACT_VERSION = "omp-delegation/v1";

const DEFAULT_PROFILE_BY_DELEGATE: Record<string, InputProfileMode> = {
	lint: "minimal",
	"code-reviewer": "minimal",
	commit: "minimal",
	explore: "standard",
	research: "standard",
	"plan-verifier": "standard",
	merge: "standard",
	implement: "detailed",
	debug: "detailed",
	task: "detailed",
	designer: "detailed",
};

const ROOT_FIELD_ORDER = [
	"contract_version",
	"envelope",
	"input_policy",
	"context",
	"roles",
	"progress",
	"task",
	"retry_context",
	"output_contract",
];

const ENVELOPE_FIELD_ORDER = ["id", "parent_envelope_id", "created_at"];
const INPUT_POLICY_FIELD_ORDER = ["mode"];
const CONTEXT_FIELD_ORDER = [
	"plan_path",
	"plan_workspace_dir",
	"plan_excerpt",
	"repo_root",
	"workflow_mode",
	"git",
	"worktree",
	"untrusted_context",
];
const GIT_FIELD_ORDER = ["branch", "base_branch", "commit"];
const WORKTREE_FIELD_ORDER = ["path"];
const ROLES_FIELD_ORDER = ["delegator", "delegate"];
const PROGRESS_FIELD_ORDER = ["completed_tasks", "upstream_tasks", "lessons_learned"];
const PROGRESS_ITEM_FIELD_ORDER = ["id", "summary", "status", "artifacts"];
const TASK_FIELD_ORDER = [
	"id",
	"title",
	"description",
	"summary",
	"intent",
	"blockers",
	"constraints",
	"acceptance_criteria",
];

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeText(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeTextList(values: readonly string[] | undefined): string[] | undefined {
	if (!values || values.length === 0) return undefined;
	const normalized = values.map(value => normalizeText(value)).filter((value): value is string => value !== undefined);
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeTask(task: DelegationTask): DelegationTask {
	const constraints = normalizeTextList(task.constraints) ?? [];
	const acceptanceCriteria = normalizeTextList(task.acceptance_criteria) ?? [];
	const normalizedTask: DelegationTask = {
		id: normalizeText(task.id) ?? task.id.trim(),
		title: normalizeText(task.title) ?? task.title.trim(),
		description: normalizeText(task.description) ?? task.description.trim(),
		constraints,
		acceptance_criteria: acceptanceCriteria,
	};
	const summary = normalizeText(task.summary);
	if (summary) normalizedTask.summary = summary;
	const intent = normalizeText(task.intent);
	if (intent) normalizedTask.intent = intent;
	const blockers = normalizeTextList(task.blockers);
	if (blockers) normalizedTask.blockers = blockers;
	return normalizedTask;
}

function normalizeProgress(progress: DelegationProgress | undefined): DelegationProgress | undefined {
	if (!progress) return undefined;
	const completedTasks = normalizeRecordArray(progress.completed_tasks);
	const upstreamTasks = normalizeRecordArray(progress.upstream_tasks);
	const lessonsLearned = normalizeTextList(progress.lessons_learned);
	if (!completedTasks && !upstreamTasks && !lessonsLearned) return undefined;
	const normalizedProgress: DelegationProgress = {};
	if (completedTasks) normalizedProgress.completed_tasks = completedTasks;
	if (upstreamTasks) normalizedProgress.upstream_tasks = upstreamTasks;
	if (lessonsLearned) normalizedProgress.lessons_learned = lessonsLearned;
	return normalizedProgress;
}

function normalizeRecordArray(
	items: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
	if (!items || items.length === 0) return undefined;
	return items.map(item => ({ ...item }));
}

interface PlanEnrichment {
	planExcerpt?: string;
	completedTasks?: Array<Record<string, unknown>>;
	upstreamTasks?: Array<Record<string, unknown>>;
	lessonsLearned?: string[];
	intent?: string;
}

const MARKDOWN_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/;
const MARKDOWN_FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const MARKDOWN_LIST_ITEM_RE = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;

function normalizeMarkdownHeadingTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[:;]+$/u, "");
}

function parseMarkdownHeading(line: string): { level: number; title: string } | undefined {
	const match = line.match(MARKDOWN_HEADING_RE);
	if (!match) return undefined;
	return { level: match[1].length, title: match[2].trim() };
}

function isMarkdownFenceLine(line: string): boolean {
	return MARKDOWN_FENCE_RE.test(line);
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim().length === 0) start += 1;
	while (end > start && lines[end - 1]?.trim().length === 0) end -= 1;
	return lines.slice(start, end);
}

function collectMarkdownSectionBody(lines: string[], headingTitle: string): string[] | undefined {
	const normalizedTitle = normalizeMarkdownHeadingTitle(headingTitle);
	let inFence = false;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (isMarkdownFenceLine(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const heading = parseMarkdownHeading(line);
		if (!heading || normalizeMarkdownHeadingTitle(heading.title) !== normalizedTitle) continue;

		const body: string[] = [];
		let sectionFence = false;
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const sectionLine = lines[cursor] ?? "";
			if (isMarkdownFenceLine(sectionLine)) {
				sectionFence = !sectionFence;
				body.push(sectionLine);
				continue;
			}
			if (!sectionFence) {
				const nextHeading = parseMarkdownHeading(sectionLine);
				if (nextHeading && nextHeading.level <= heading.level) break;
			}
			body.push(sectionLine);
		}

		const trimmed = trimBlankLines(body);
		if (trimmed.length > 0) return trimmed;
	}

	return undefined;
}

function collectSectionText(content: string, headingTitle: string): string | undefined {
	const body = collectMarkdownSectionBody(content.replace(/\r\n?/g, "\n").split("\n"), headingTitle);
	if (!body) return undefined;
	const text = body.join("\n").trim();
	return text.length > 0 ? text : undefined;
}

function collectLeadText(content: string, headingTitle: string): string | undefined {
	const body = collectMarkdownSectionBody(content.replace(/\r\n?/g, "\n").split("\n"), headingTitle);
	if (!body) return undefined;

	const lines: string[] = [];
	let mode: "initial" | "paragraph" | "bullet" = "initial";
	let inFence = false;

	for (const rawLine of body) {
		if (isMarkdownFenceLine(rawLine)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const trimmed = rawLine.trim();
		if (!trimmed) {
			if (mode !== "initial") break;
			continue;
		}

		if (parseMarkdownHeading(rawLine)) break;

		const bulletMatch = trimmed.match(MARKDOWN_LIST_ITEM_RE);
		if (mode === "initial") {
			mode = bulletMatch ? "bullet" : "paragraph";
			const contentLine = (bulletMatch?.[1] ?? trimmed).trim();
			if (contentLine) lines.push(contentLine);
			continue;
		}

		if (mode === "bullet") {
			if (bulletMatch) break;
			lines.push(trimmed);
			continue;
		}

		if (bulletMatch) break;
		lines.push(trimmed);
	}

	const text = lines.join(" ").replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : undefined;
}

function collectListItems(content: string, headingTitle: string): string[][] | undefined {
	const body = collectMarkdownSectionBody(content.replace(/\r\n?/g, "\n").split("\n"), headingTitle);
	if (!body) return undefined;

	const items: string[][] = [];
	let current: string[] | undefined;
	let inFence = false;

	for (const rawLine of body) {
		if (isMarkdownFenceLine(rawLine)) {
			inFence = !inFence;
			if (current) current.push(rawLine.trim());
			continue;
		}
		if (inFence) {
			if (current) current.push(rawLine.trim());
			continue;
		}

		const trimmed = rawLine.trim();
		if (!trimmed) {
			if (current) current.push("");
			continue;
		}

		if (parseMarkdownHeading(rawLine)) {
			break;
		}

		const bulletMatch = trimmed.match(MARKDOWN_LIST_ITEM_RE);
		if (bulletMatch) {
			if (current) items.push(current);
			current = [];
			const contentLine = bulletMatch[1].trim();
			if (contentLine) current.push(contentLine);
			continue;
		}

		if (current) current.push(trimmed);
	}

	if (current) items.push(current);
	return items.length > 0 ? items : undefined;
}

function parsePlanFieldValue(rawValue: string): string | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) return undefined;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		const unquoted = trimmed.slice(1, -1).trim();
		return unquoted.length > 0 ? unquoted : undefined;
	}
	return trimmed;
}

function parsePlanKeyValueLines(lines: string[]): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const separatorIndex = line.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim().toLowerCase();
		const value = parsePlanFieldValue(line.slice(separatorIndex + 1).trim());
		if (!value) continue;
		fields[key] = value;
	}
	return fields;
}

function extractUpstreamTasks(content: string): Array<Record<string, unknown>> | undefined {
	const items = collectListItems(content, "Dependencies");
	if (!items) return undefined;

	const upstreamTasks: Array<Record<string, unknown>> = [];
	for (const itemLines of items) {
		const fields = parsePlanKeyValueLines(itemLines);
		const summary = normalizeText(fields.summary);
		if (!summary) continue;

		const upstreamTask: Record<string, unknown> = { summary };
		const id = normalizeText(fields.id);
		if (id) upstreamTask.id = id;
		upstreamTasks.push(upstreamTask);
	}

	return upstreamTasks.length > 0 ? upstreamTasks : undefined;
}

const PLAN_CHECKBOX_COMPLETE_RE = /^(?:[-*+])\s+\[x\]\s+(.+)$/i;

const PROGRESS_WINDOW: Record<"standard" | "detailed", number> = {
	standard: 5,
	detailed: 10,
};

function extractCompletedTasksFromPlan(content: string, window: number): Array<Record<string, unknown>> | undefined {
	const items: Array<Record<string, unknown>> = [];
	for (const rawLine of content.replace(/\r\n?/g, "\n").split("\n")) {
		const match = rawLine.trim().match(PLAN_CHECKBOX_COMPLETE_RE);
		const summary = match?.[1] ? normalizeText(match[1]) : undefined;
		if (summary) items.push({ summary, status: "completed" });
	}
	if (items.length === 0) return undefined;
	// Take the most recent N items
	return items.slice(-window);
}

function extractCompletedTasksFromTodos(
	session: ToolSession,
	window: number,
): Array<Record<string, unknown>> | undefined {
	const phases = session.getTodoPhases?.();
	if (!phases || phases.length === 0) return undefined;
	const completed: Array<Record<string, unknown>> = [];
	for (const phase of phases) {
		for (const item of phase.tasks) {
			if (item.status === "completed") {
				const summary = normalizeText(item.content);
				if (summary) completed.push({ summary, status: "completed" });
			}
		}
	}
	if (completed.length === 0) return undefined;
	return completed.slice(-window);
}

function extractLessonsLearned(content: string): string[] | undefined {
	const items = collectListItems(content, "Lessons Learned");
	if (!items) return undefined;

	const lessonsLearned = items
		.map(itemLines => normalizeText(itemLines.join(" ").replace(/\s+/g, " ")))
		.filter((value): value is string => value !== undefined)
		.slice(0, 5);

	return lessonsLearned.length > 0 ? lessonsLearned : undefined;
}

async function loadPlanEnrichment(
	planPath: string,
	session: ToolSession,
	profile: "standard" | "detailed",
): Promise<PlanEnrichment | undefined> {
	let resolvedPath: string;
	try {
		resolvedPath = planPath.startsWith("local://")
			? resolveLocalUrlToPath(planPath, {
					getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
					getSessionId: () => session.getSessionId?.() ?? null,
				})
			: path.normalize(resolveToCwd(planPath, session.cwd));
	} catch {
		return undefined;
	}

	let content: string;
	try {
		content = await Bun.file(resolvedPath).text();
	} catch {
		return undefined;
	}

	const normalizedContent = content.replace(/\r\n?/g, "\n");
	const window = PROGRESS_WINDOW[profile];
	const completedTasks = extractCompletedTasksFromPlan(normalizedContent, window);
	// These fields are detailed-only
	const planExcerpt = profile === "detailed" ? collectSectionText(normalizedContent, "Plan Excerpt") : undefined;
	const intent = profile === "detailed" ? collectLeadText(normalizedContent, "Goals") : undefined;
	const upstreamTasks = profile === "detailed" ? extractUpstreamTasks(normalizedContent) : undefined;
	const lessonsLearned = profile === "detailed" ? extractLessonsLearned(normalizedContent) : undefined;

	if (!completedTasks && !planExcerpt && !intent && !upstreamTasks && !lessonsLearned) return undefined;
	return {
		...(completedTasks ? { completedTasks } : {}),
		...(planExcerpt ? { planExcerpt } : {}),
		...(intent ? { intent } : {}),
		...(upstreamTasks ? { upstreamTasks } : {}),
		...(lessonsLearned ? { lessonsLearned } : {}),
	};
}

function normalizeDelegateName(delegate: string): string {
	return normalizeText(delegate)?.toLowerCase() ?? "";
}

function resolveInputProfileForDelegate(delegate: string, override?: InputProfileMode): InputProfileMode {
	if (override) return override;
	const normalizedDelegate = normalizeDelegateName(delegate);
	return DEFAULT_PROFILE_BY_DELEGATE[normalizedDelegate] ?? "detailed";
}

function generateEnvelopeId(task: DelegationTask): string {
	const payload = [
		task.id,
		task.title,
		task.description,
		JSON.stringify(task.constraints),
		JSON.stringify(task.acceptance_criteria),
	].join("");
	const hash = createHash("sha256").update(payload).digest("hex").slice(0, 12);
	return `del_${hash}`;
}

async function runGitCommand(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const child = Bun.spawn(["git", ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		if (exitCode !== 0) return undefined;
		const text = stdout.trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function normalizeGitCandidate(candidate: string | undefined): string | undefined {
	const normalized = normalizeText(candidate);
	return normalized ? path.resolve(normalized) : undefined;
}

async function resolveRuntimeGitMetadata(
	candidates: readonly (string | undefined)[],
): Promise<RuntimeGitMetadata | undefined> {
	const uniqueCandidates = Array.from(
		new Set(
			candidates.map(normalizeGitCandidate).filter((candidate): candidate is string => candidate !== undefined),
		),
	);

	for (const candidate of uniqueCandidates) {
		const repoRoot = await runGitCommand(candidate, ["rev-parse", "--show-toplevel"]);
		if (!repoRoot) continue;

		const [branch, commit] = await Promise.all([
			runGitCommand(repoRoot, ["branch", "--show-current"]),
			runGitCommand(repoRoot, ["rev-parse", "HEAD"]),
		]);
		if (!commit) continue;

		let baseBranch: string | undefined;
		if (branch) {
			baseBranch = await runGitCommand(repoRoot, [
				"for-each-ref",
				"--format=%(upstream:short)",
				`refs/heads/${branch}`,
			]);
		}

		return {
			repo_root: repoRoot,
			branch,
			commit,
			base_branch: baseBranch,
		};
	}

	return undefined;
}

function fieldOrderForPath(pathSegments: readonly string[]): readonly string[] | undefined {
	switch (pathSegments.join(".")) {
		case "":
			return ROOT_FIELD_ORDER;
		case "envelope":
			return ENVELOPE_FIELD_ORDER;
		case "input_policy":
			return INPUT_POLICY_FIELD_ORDER;
		case "context":
			return CONTEXT_FIELD_ORDER;
		case "context.git":
			return GIT_FIELD_ORDER;
		case "context.worktree":
			return WORKTREE_FIELD_ORDER;
		case "roles":
			return ROLES_FIELD_ORDER;
		case "progress":
			return PROGRESS_FIELD_ORDER;
		case "progress.completed_tasks":
		case "progress.upstream_tasks":
			return PROGRESS_ITEM_FIELD_ORDER;
		case "task":
			return TASK_FIELD_ORDER;
		default:
			return undefined;
	}
}

function orderedKeys(value: PlainObject, order: readonly string[] | undefined): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();

	if (order) {
		for (const key of order) {
			if (value[key] === undefined || seen.has(key)) continue;
			keys.push(key);
			seen.add(key);
		}
	}

	for (const key of Object.keys(value).sort()) {
		if (value[key] === undefined || seen.has(key)) continue;
		keys.push(key);
	}

	return keys;
}

function serializePrimitive(value: Primitive): string {
	return JSON.stringify(value);
}

function indent(level: number): string {
	return "  ".repeat(level);
}

function renderObjectFields(value: PlainObject, level: number, pathSegments: readonly string[]): string[] {
	const fields = orderedKeys(value, fieldOrderForPath(pathSegments));
	const lines: string[] = [];

	for (const key of fields) {
		const fieldValue = value[key];
		if (fieldValue === undefined) continue;
		lines.push(...renderField(key, fieldValue, level, [...pathSegments, key]));
	}

	return lines;
}

function renderField(key: string, value: unknown, level: number, pathSegments: readonly string[]): string[] {
	if (value === undefined) return [];
	if (isPrimitive(value)) {
		return [`${indent(level)}${key}: ${serializePrimitive(value)}`];
	}
	if (Array.isArray(value)) {
		return renderArrayField(key, value, level, pathSegments);
	}
	if (isPlainObject(value)) {
		return [`${indent(level)}${key}:`, ...renderObjectFields(value, level + 1, pathSegments)];
	}
	return [`${indent(level)}${key}: ${serializePrimitive(String(value))}`];
}

function renderArrayField(
	key: string,
	values: readonly unknown[],
	level: number,
	pathSegments: readonly string[],
): string[] {
	if (values.length === 0) {
		return [`${indent(level)}${key}[0]:`];
	}

	if (values.every(isPrimitive)) {
		return [`${indent(level)}${key}[${values.length}]: ${values.map(value => serializePrimitive(value)).join(",")}`];
	}

	if (values.every(isPlainObject)) {
		const objects = values as PlainObject[];
		const tabular = renderTabularArray(key, objects, level, pathSegments);
		if (tabular) return tabular;
	}

	return renderListArray(key, values, level, pathSegments);
}

function renderTabularArray(
	key: string,
	values: readonly PlainObject[],
	level: number,
	pathSegments: readonly string[],
): string[] | undefined {
	const firstKeys = Object.keys(values[0] ?? {});
	if (firstKeys.length === 0) return undefined;

	const keySet = new Set(firstKeys);
	for (const entry of values) {
		const entryKeys = Object.keys(entry);
		if (entryKeys.length !== keySet.size) return undefined;
		for (const entryKey of entryKeys) {
			if (!keySet.has(entryKey)) return undefined;
			if (!isPrimitive(entry[entryKey])) return undefined;
		}
	}

	const order = fieldOrderForPath(pathSegments);
	const orderedFields = order
		? [...order.filter(field => keySet.has(field)), ...firstKeys.filter(field => !order.includes(field)).sort()]
		: firstKeys.slice().sort();

	const rows = values.map(entry =>
		orderedFields.map(field => serializePrimitive(entry[field] as Primitive)).join(","),
	);
	return [
		`${indent(level)}${key}[${values.length}]{${orderedFields.join(",")}}:`,
		...rows.map(row => `${indent(level + 1)}${row}`),
	];
}

function renderListArray(
	key: string,
	values: readonly unknown[],
	level: number,
	pathSegments: readonly string[],
): string[] {
	const itemLevel = level + 1;
	const lines = [`${indent(level)}${key}[${values.length}]:`];

	for (const value of values) {
		if (isPrimitive(value)) {
			lines.push(`${indent(itemLevel)}- ${serializePrimitive(value)}`);
			continue;
		}

		if (isPlainObject(value)) {
			lines.push(...renderListObjectItem(value, itemLevel, pathSegments));
			continue;
		}

		lines.push(`${indent(itemLevel)}- ${serializePrimitive(String(value))}`);
	}

	return lines;
}

function renderListObjectItem(value: PlainObject, itemLevel: number, pathSegments: readonly string[]): string[] {
	const objectLines = renderObjectFields(value, itemLevel + 1, pathSegments);
	if (objectLines.length === 0) return [`${indent(itemLevel)}- {}`];

	const objectIndent = indent(itemLevel + 1);
	const firstLine = objectLines[0];
	objectLines[0] = `${indent(itemLevel)}- ${firstLine.slice(objectIndent.length)}`;
	return objectLines;
}

async function buildMetadata(input: BuildToonDelegationInput, task: DelegationTask): Promise<DelegationMetadata> {
	const inheritedContext = parseInheritedDelegationContext(input.session.getCompactContext?.());
	const runtimeRole = normalizeText(input.session.getRuntimeRole?.())?.toLowerCase();
	const normalizedProfile = resolveInputProfileForDelegate(input.delegate, input.options?.profile);

	// Resolve plan path: compact context first, then session state (late plan binding)
	let planPath = inheritedContext.plan_file_path ?? inheritedContext.plan_reference;
	if (!planPath) {
		const sessionCtx = collectDelegationContext(input.session);
		if (sessionCtx.planFilePath) planPath = sessionCtx.planFilePath;
	}

	const runtimeGit = await resolveRuntimeGitMetadata([
		inheritedContext.worktree_path,
		inheritedContext.repo_root,
		input.session.cwd,
	]);

	// Plan enrichment is loaded for standard and detailed profiles (not minimal)
	const planEnrichment =
		normalizedProfile !== "minimal" && planPath
			? await loadPlanEnrichment(planPath, input.session, normalizedProfile as "standard" | "detailed")
			: undefined;

	// Build progress: caller-provided overrides; plan and todos fill the gaps
	let progress = normalizeProgress(input.options?.progress);
	if (normalizedProfile !== "minimal") {
		const progressWindow = PROGRESS_WINDOW[normalizedProfile as "standard" | "detailed"] ?? 5;
		if (planEnrichment) {
			let mergedProgress = progress ? { ...progress } : undefined;
			let progressChanged = false;
			if (planEnrichment.completedTasks && mergedProgress?.completed_tasks === undefined) {
				mergedProgress ??= {};
				mergedProgress.completed_tasks = planEnrichment.completedTasks;
				progressChanged = true;
			}
			if (planEnrichment.upstreamTasks && mergedProgress?.upstream_tasks === undefined) {
				mergedProgress ??= {};
				mergedProgress.upstream_tasks = planEnrichment.upstreamTasks;
				progressChanged = true;
			}
			if (planEnrichment.lessonsLearned && mergedProgress?.lessons_learned === undefined) {
				mergedProgress ??= {};
				mergedProgress.lessons_learned = planEnrichment.lessonsLearned;
				progressChanged = true;
			}
			if (progressChanged) progress = mergedProgress;
		} else if (!progress?.completed_tasks) {
			// Non-plan workflow: populate completed_tasks from the session todo list
			const todoTasks = extractCompletedTasksFromTodos(input.session, progressWindow);
			if (todoTasks) {
				progress = progress ? { ...progress, completed_tasks: todoTasks } : { completed_tasks: todoTasks };
			}
		}
	}

	const branch = inheritedContext.branch_name ?? runtimeGit?.branch;
	const commit = runtimeGit?.commit;
	const baseBranch = inheritedContext.base_branch ?? runtimeGit?.base_branch;
	const git =
		branch && commit
			? {
					branch,
					commit,
					...(baseBranch ? { base_branch: baseBranch } : {}),
				}
			: undefined;

	const repoRoot = inheritedContext.repo_root ?? runtimeGit?.repo_root ?? path.resolve(input.session.cwd);
	// Ask/default modes are authoritative: prefer runtime role over inherited workflow_mode
	const workflowMode =
		runtimeRole === "ask" || runtimeRole === "default"
			? runtimeRole
			: (inheritedContext.workflow_mode ?? runtimeRole ?? "unknown");
	const delegator = runtimeRole ?? inheritedContext.parent_runtime_role ?? "unknown";
	const parentEnvelopeId =
		input.options?.parentEnvelopeId ?? inheritedContext.parent_envelope_id ?? inheritedContext.envelope_id;
	const derivedIntent =
		normalizedProfile === "detailed" ? (planEnrichment?.intent ?? inheritedContext.commander_intent) : undefined;
	const effectiveTask = derivedIntent && !task.intent ? { ...task, intent: derivedIntent } : task;

	return {
		contract_version: CONTRACT_VERSION,
		envelope: {
			id: generateEnvelopeId(task),
			created_at: new Date().toISOString(),
			...(parentEnvelopeId ? { parent_envelope_id: parentEnvelopeId } : {}),
		},
		input_policy: {
			mode: normalizedProfile,
		},
		context: {
			repo_root: repoRoot,
			workflow_mode: workflowMode,
			...(planPath ? { plan_path: planPath } : {}),
			...(inheritedContext.plan_workspace_dir ? { plan_workspace_dir: inheritedContext.plan_workspace_dir } : {}),
			...(planEnrichment?.planExcerpt ? { plan_excerpt: planEnrichment.planExcerpt } : {}),
			...(git ? { git } : {}),
			...(inheritedContext.worktree_path ? { worktree: { path: inheritedContext.worktree_path } } : {}),
		},
		roles: {
			delegator,
			delegate: normalizeDelegateName(input.delegate) || "unknown",
		},
		...(progress ? { progress } : {}),
		task: effectiveTask,
		...(input.options?.retryContext ? { retry_context: input.options.retryContext } : {}),
		...(input.options?.outputContract ? { output_contract: input.options.outputContract } : {}),
	};
}

function renderDelegationToon(metadata: DelegationMetadata): string {
	return ["delegation:", ...renderObjectFields(metadata as unknown as PlainObject, 1, [])].join("\n");
}

export function resolveInputProfile(delegate: string, override?: InputProfileMode): InputProfileMode {
	return resolveInputProfileForDelegate(delegate, override);
}

const TOKEN_BUDGET = 2000;

export function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

export async function validateDelegationQuality(
	metadata: DelegationMetadata,
	cwd?: string,
): Promise<DelegationQualityReport> {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (metadata.task.description.length < 20) {
		warnings.push("task.description is under 20 characters");
	}
	if (metadata.context.plan_path && !metadata.context.plan_excerpt && metadata.input_policy.mode === "detailed") {
		warnings.push("plan_path exists but plan_excerpt extraction failed [info]");
	}
	if (
		metadata.input_policy.mode !== "minimal" &&
		metadata.roles.delegate === "implement" &&
		!metadata.output_contract
	) {
		warnings.push("output_contract missing for implement delegate");
	}
	if (metadata.context.plan_path) {
		const planPath = metadata.context.plan_path;
		if (!planPath.startsWith("local://")) {
			const resolvedPath = path.isAbsolute(planPath) ? planPath : cwd ? path.join(cwd, planPath) : planPath;
			try {
				await fsPromises.access(resolvedPath);
			} catch {
				errors.push(`plan_path is set but file does not exist: ${planPath}`);
			}
		}
	}

	return { warnings, errors };
}

function validateToonRoundTrip(toon: string, metadata: DelegationMetadata): boolean {
	try {
		if (!toon.includes(`contract_version: "omp-delegation/v1"`)) return false;
		if (!toon.includes(`id: ${JSON.stringify(metadata.envelope.id)}`)) return false;
		if (!toon.includes(`title: ${JSON.stringify(metadata.task.title)}`)) return false;
		if (!toon.includes("description:")) return false;
		return true;
	} catch {
		return false;
	}
}

function applyTokenBudgetTrim(metadata: DelegationMetadata): {
	metadata: DelegationMetadata;
	toon: string;
	trimmed: boolean;
} {
	const initial = renderDelegationToon(metadata);
	if (estimateTokenCount(initial) <= TOKEN_BUDGET) {
		return { metadata, toon: initial, trimmed: false };
	}

	let current = metadata;

	// Step 1: Remove lessons_learned
	if (current.progress?.lessons_learned) {
		const nextProgress: DelegationProgress = { ...current.progress, lessons_learned: undefined };
		const hasOtherProgress = nextProgress.completed_tasks || nextProgress.upstream_tasks;
		current = { ...current, progress: hasOtherProgress ? nextProgress : undefined };
		const toon = renderDelegationToon(current);
		if (estimateTokenCount(toon) <= TOKEN_BUDGET) {
			return { metadata: current, toon, trimmed: true };
		}
	}

	// Step 2: Reduce completed_tasks window (oldest removed first)
	while ((current.progress?.completed_tasks?.length ?? 0) > 0) {
		const tasks = current.progress!.completed_tasks!;
		const reduced = tasks.slice(1);
		const nextProgress: DelegationProgress = {
			...current.progress!,
			completed_tasks: reduced.length > 0 ? reduced : undefined,
		};
		const hasOtherProgress =
			nextProgress.completed_tasks || nextProgress.upstream_tasks || nextProgress.lessons_learned;
		current = { ...current, progress: hasOtherProgress ? nextProgress : undefined };
		const toon = renderDelegationToon(current);
		if (estimateTokenCount(toon) <= TOKEN_BUDGET) {
			return { metadata: current, toon, trimmed: true };
		}
	}

	// Step 3: Remove plan_excerpt
	if (current.context.plan_excerpt) {
		current = { ...current, context: { ...current.context, plan_excerpt: undefined } };
		const toon = renderDelegationToon(current);
		if (estimateTokenCount(toon) <= TOKEN_BUDGET) {
			return { metadata: current, toon, trimmed: true };
		}
	}

	// Step 4: Truncate task.description to first 200 characters
	if (current.task.description.length > 200) {
		current = { ...current, task: { ...current.task, description: current.task.description.slice(0, 200) } };
	}
	const finalToon = renderDelegationToon(current);
	return { metadata: current, toon: finalToon, trimmed: true };
}

export async function buildToonDelegation(input: BuildToonDelegationInput): Promise<ToonDelegationResult> {
	const task = normalizeTask(input.task);
	const metadata = await buildMetadata(input, task);

	// Quality linter runs before TOON serialization
	const quality_report = await validateDelegationQuality(metadata, input.session.cwd);
	for (const w of quality_report.warnings) {
		console.warn(`[toon-delegation] warning: ${w}`);
	}
	for (const e of quality_report.errors) {
		console.error(`[toon-delegation] error: ${e}`);
	}

	// Render, apply token budget trim, re-render if needed
	const { metadata: finalMetadata, toon: finalToon, trimmed } = applyTokenBudgetTrim(metadata);
	if (trimmed) {
		console.warn(`[toon-delegation] envelope trimmed to fit ${TOKEN_BUDGET}-token budget`);
	}

	// Round-trip structural validation
	const validation_passed = validateToonRoundTrip(finalToon, finalMetadata);
	if (!validation_passed) {
		console.warn("[toon-delegation] TOON round-trip validation failed");
	}

	return {
		toon: finalToon,
		metadata: finalMetadata,
		quality_report,
		validation_passed,
	};
}

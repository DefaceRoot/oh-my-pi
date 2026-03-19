import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ToolSession } from "..";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { resolveToCwd } from "../tools/path-utils";

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

export interface ToonDelegationResult {
	toon: string;
	metadata: DelegationMetadata;
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

function parseInheritedDelegationContext(text: string | undefined): InheritedDelegationContext {
	if (!text) return {};

	let block: string | undefined;
	for (const match of text.matchAll(DELEGATION_CONTEXT_BLOCK_RE)) {
		block = match[1];
	}
	if (!block) return {};

	const context: InheritedDelegationContext = {};
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

const CONTRACT_VERSION = "omp-delegation/v1";

const DEFAULT_PROFILE_BY_DELEGATE: Record<string, InputProfileMode> = {
	lint: "minimal",
	"code-reviewer": "minimal",
	explore: "standard",
	research: "standard",
	"plan-verifier": "standard",
	implement: "detailed",
	debug: "detailed",
	task: "detailed",
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

function extractLessonsLearned(content: string): string[] | undefined {
	const items = collectListItems(content, "Lessons Learned");
	if (!items) return undefined;

	const lessonsLearned = items
		.map(itemLines => normalizeText(itemLines.join(" ").replace(/\s+/g, " ")))
		.filter((value): value is string => value !== undefined)
		.slice(0, 3);

	return lessonsLearned.length > 0 ? lessonsLearned : undefined;
}

async function loadPlanEnrichment(planPath: string, session: ToolSession): Promise<PlanEnrichment | undefined> {
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
	const planExcerpt = collectSectionText(normalizedContent, "Plan Excerpt");
	const intent = collectLeadText(normalizedContent, "Goals");
	const upstreamTasks = extractUpstreamTasks(normalizedContent);
	const lessonsLearned = extractLessonsLearned(normalizedContent);

	if (!planExcerpt && !intent && !upstreamTasks && !lessonsLearned) return undefined;
	return {
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
	const planPath = inheritedContext.plan_file_path ?? inheritedContext.plan_reference;
	const runtimeGit = await resolveRuntimeGitMetadata([
		inheritedContext.worktree_path,
		inheritedContext.repo_root,
		input.session.cwd,
	]);
	const planEnrichment =
		normalizedProfile === "detailed" && planPath ? await loadPlanEnrichment(planPath, input.session) : undefined;
	let progress = normalizeProgress(input.options?.progress);
	if (planEnrichment) {
		let mergedProgress = progress ? { ...progress } : undefined;
		let progressChanged = false;
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
		if (progressChanged) {
			progress = mergedProgress;
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
	const workflowMode = inheritedContext.workflow_mode ?? runtimeRole ?? "unknown";
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

export async function buildToonDelegation(input: BuildToonDelegationInput): Promise<ToonDelegationResult> {
	const task = normalizeTask(input.task);
	const metadata = await buildMetadata(input, task);
	return {
		toon: renderDelegationToon(metadata),
		metadata,
	};
}

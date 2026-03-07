/**
 * Parses `git status --porcelain` output into a Set of file paths.
 * Handles status codes like M, A, D, R, C, ??, and !!.
 */
export function parseGitStatusSnapshot(output: string): Set<string> {
	const files = new Set<string>();
	if (!output.trim()) return files;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;

		const pathPart = line.length > 3 ? line.slice(3).trim() : "";
		if (!pathPart) continue;

		if (pathPart.includes(" -> ")) {
			const [oldPath, newPath] = pathPart.split(" -> ").map(path => path.trim());
			if (oldPath) files.add(oldPath);
			if (newPath) files.add(newPath);
			continue;
		}

		files.add(pathPart);
	}

	return files;
}

/**
 * Returns files present in `after` but not in `before`.
 */
export function computeFilesDelta(before: Set<string>, after: Set<string>): Set<string> {
	const delta = new Set<string>();
	for (const file of after) {
		if (!before.has(file)) {
			delta.add(file);
		}
	}
	return delta;
}

export interface TaskUnitScopeHint {
	id: string;
	assignment: string;
	description?: string;
}

export interface ImplementationUnitScopeMetadata {
	unitId: string;
	declaredFileHints: string[];
	editedFiles: string[];
}

export interface ImplementationTaskScopeMetadata {
	agent: string;
	editedFiles: string[];
	units: ImplementationUnitScopeMetadata[];
	codeRabbit: {
		baseBranch?: string;
		worktreePath?: string;
		editedFiles: string[];
	};
}

const EDITED_FILE_SCOPE_BLOCK_RE =
	/\n?<edited_file_scope_metadata>[\s\S]*?<\/edited_file_scope_metadata>\n?/g;
const FILE_PATH_HINT_SOURCE_RE =
	/(?:`([^`\n]+)`)|((?:\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?)/g;

function normalizeTrackedPath(rawPath: string): string {
	const normalized = rawPath
		.trim()
		.replace(/^['"`([{]+/, "")
		.replace(/[)'"`\]},;:.]+$/, "")
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/");
	if (!normalized || normalized === ".") return "";
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function isPathHintCandidate(value: string): boolean {
	if (!value) return false;
	if (value === "-" || value === "--") return false;
	if (value.includes("*")) return false;
	if (value.startsWith("#")) return false;
	return value.includes("/") || /\.[A-Za-z0-9_-]+$/.test(value);
}

function toSortedPaths(files: Iterable<string>): string[] {
	return [...files].map(normalizeTrackedPath).filter(Boolean).sort();
}

function parseFileHintsFromText(text: string): Set<string> {
	const hints = new Set<string>();
	if (!text.trim()) return hints;

	for (const match of text.matchAll(FILE_PATH_HINT_SOURCE_RE)) {
		const rawToken = (match[1] ?? match[2] ?? "").trim();
		if (!rawToken) continue;

		const moveParts = rawToken.includes(" -> ")
			? rawToken.split(" -> ").map(part => part.trim())
			: [rawToken];

		for (const part of moveParts) {
			const candidate = normalizeTrackedPath(part);
			if (!isPathHintCandidate(candidate)) continue;
			hints.add(candidate);
		}
	}

	return hints;
}

function basename(filePath: string): string {
	const parts = filePath.split("/");
	return parts[parts.length - 1] ?? filePath;
}

function normalizedStem(filePath: string): string {
	const fileName = basename(filePath);
	const extIndex = fileName.lastIndexOf(".");
	const stem = extIndex > 0 ? fileName.slice(0, extIndex) : fileName;
	return stem.replace(/(?:[._-](?:generated|autogen|gen))+$/i, "");
}

function scoreFileHintMatch(filePath: string, hints: Set<string>): number {
	let bestScore = 0;
	const normalizedFileStem = normalizedStem(filePath);
	for (const hint of hints) {
		if (hint === filePath) {
			bestScore = Math.max(bestScore, 100);
			continue;
		}
		if (filePath.startsWith(`${hint}/`)) {
			bestScore = Math.max(bestScore, 80);
			continue;
		}
		if (hint.startsWith(`${filePath}/`)) {
			bestScore = Math.max(bestScore, 60);
			continue;
		}
		if (basename(hint) === basename(filePath)) {
			bestScore = Math.max(bestScore, 40);
			continue;
		}
		if (normalizedStem(hint) === normalizedFileStem) {
			bestScore = Math.max(bestScore, 35);
		}
	}
	return bestScore;
}

export function collectTaskUnitsFromTaskInput(input: unknown): TaskUnitScopeHint[] {
	const record = asRecord(input);
	if (!record) return [];
	const rawTasks = record.tasks;
	if (!Array.isArray(rawTasks)) return [];

	const units: TaskUnitScopeHint[] = [];
	for (const rawTask of rawTasks) {
		const task = asRecord(rawTask);
		if (!task) continue;
		const id = typeof task.id === "string" ? task.id.trim() : "";
		const assignment = typeof task.assignment === "string" ? task.assignment : "";
		if (!id || !assignment) continue;
		const description = typeof task.description === "string" ? task.description : undefined;
		units.push({ id, assignment, description });
	}

	return units;
}

export function collectTaskUnitsFromTaskResultDetails(details: unknown): TaskUnitScopeHint[] {
	const record = asRecord(details);
	if (!record) return [];
	const rawResults = record.results;
	if (!Array.isArray(rawResults)) return [];

	const units: TaskUnitScopeHint[] = [];
	for (let index = 0; index < rawResults.length; index += 1) {
		const result = asRecord(rawResults[index]);
		if (!result) continue;
		const id = typeof result.id === "string" ? result.id.trim() : "";
		const assignment = typeof result.task === "string" ? result.task : "";
		if (!id || !assignment) continue;
		const description = typeof result.description === "string" ? result.description : undefined;
		units.push({ id, assignment, description });
	}

	return units;
}

export function buildImplementationUnitFileScopes(
	units: TaskUnitScopeHint[],
	changedFiles: Set<string>,
): Map<string, Set<string>> {
	const scopeByUnit = new Map<string, Set<string>>();
	const normalizedChangedFiles = new Set(toSortedPaths(changedFiles));
	for (const unit of units) {
		scopeByUnit.set(unit.id, new Set<string>());
	}

	if (units.length === 0 || normalizedChangedFiles.size === 0) {
		return scopeByUnit;
	}

	if (units.length === 1) {
		const onlyUnitId = units[0]?.id;
		if (onlyUnitId) {
			scopeByUnit.set(onlyUnitId, new Set(normalizedChangedFiles));
		}
		return scopeByUnit;
	}

	const hintsByUnitId = new Map<string, Set<string>>();
	for (const unit of units) {
		hintsByUnitId.set(
			unit.id,
			parseFileHintsFromText(`${unit.assignment}\n${unit.description ?? ""}`),
		);
	}

	const unassignedFiles = new Set<string>();
	for (const file of normalizedChangedFiles) {
		let bestUnitId: string | undefined;
		let bestScore = 0;
		let tied = false;

		for (const unit of units) {
			const hints = hintsByUnitId.get(unit.id) ?? new Set<string>();
			const score = scoreFileHintMatch(file, hints);
			if (score > bestScore) {
				bestScore = score;
				bestUnitId = unit.id;
				tied = false;
			} else if (score > 0 && score === bestScore) {
				tied = true;
			}
		}

		if (!bestUnitId || tied || bestScore === 0) {
			unassignedFiles.add(file);
			continue;
		}

		scopeByUnit.get(bestUnitId)?.add(file);
	}

	if (unassignedFiles.size > 0) {
		const unitsWithAssignedFiles = units.filter(
			(unit) => (scopeByUnit.get(unit.id)?.size ?? 0) > 0,
		);
		if (unitsWithAssignedFiles.length === 1) {
			const unitId = unitsWithAssignedFiles[0]?.id;
			if (unitId) {
				const scope = scopeByUnit.get(unitId) ?? new Set<string>();
				for (const file of unassignedFiles) {
					scope.add(file);
				}
				scopeByUnit.set(unitId, scope);
			}
		}
	}

	return scopeByUnit;
}

export function createImplementationTaskScopeMetadata(args: {
	agent: string;
	units: TaskUnitScopeHint[];
	changedFiles: Set<string>;
	baseBranch?: string;
	worktreePath?: string;
}): ImplementationTaskScopeMetadata {
	const normalizedUnits = args.units.filter(
		(unit, index, source) => source.findIndex((candidate) => candidate.id === unit.id) === index,
	);
	const scopeByUnit = buildImplementationUnitFileScopes(normalizedUnits, args.changedFiles);
	const editedFiles = toSortedPaths(args.changedFiles);

	return {
		agent: args.agent,
		editedFiles,
		units: normalizedUnits.map((unit) => ({
			unitId: unit.id,
			declaredFileHints: toSortedPaths(
				parseFileHintsFromText(`${unit.assignment}\n${unit.description ?? ""}`),
			),
			editedFiles: toSortedPaths(scopeByUnit.get(unit.id) ?? new Set<string>()),
		})),
		codeRabbit: {
			baseBranch: args.baseBranch,
			worktreePath: args.worktreePath,
			editedFiles,
		},
	};
}

function buildEditedFileScopeBlock(unitId: string, files: Set<string>): string {
	const sortedFiles = toSortedPaths(files);
	return [
		"<edited_file_scope_metadata>",
		"## Edited File Scope (authoritative)",
		`- Implementation unit id: \`${unitId}\``,
		"- Restrict this task to the following files:",
		...sortedFiles.map((file) => `  - \`${file}\``),
		"- If additional files are needed, stop and report a blocker instead of widening scope.",
		"</edited_file_scope_metadata>",
	].join("\n");
}

export function applyScopedFileMetadataToTaskInput(args: {
	input: unknown;
	scopeByUnitId: Map<string, Set<string>>;
	fallbackScope?: Set<string>;
}): boolean {
	const inputRecord = asRecord(args.input);
	if (!inputRecord) return false;
	const rawTasks = inputRecord.tasks;
	if (!Array.isArray(rawTasks) || rawTasks.length === 0) return false;

	const normalizedFallbackScope = new Set(toSortedPaths(args.fallbackScope ?? new Set<string>()));
	const allowFallbackScope = rawTasks.length === 1 && normalizedFallbackScope.size > 0;
	let didMutate = false;

	for (const rawTask of rawTasks) {
		const task = asRecord(rawTask);
		if (!task) continue;
		const unitId = typeof task.id === "string" ? task.id.trim() : "";
		if (!unitId) continue;
		const assignment = typeof task.assignment === "string" ? task.assignment : "";
		const explicitScope = args.scopeByUnitId.get(unitId);
		const scope =
			explicitScope && explicitScope.size > 0
				? explicitScope
				: allowFallbackScope
					? normalizedFallbackScope
					: undefined;
		if (!scope || scope.size === 0) continue;

		const existingAssignment = assignment.replace(EDITED_FILE_SCOPE_BLOCK_RE, "").trimEnd();
		const withScope = [existingAssignment, buildEditedFileScopeBlock(unitId, scope)]
			.filter(Boolean)
			.join("\n\n");
		if (withScope !== assignment) {
			task.assignment = withScope;
			didMutate = true;
		}
	}

	return didMutate;
}

export const IMPLEMENTATION_WORKER_GATE_SEQUENCE = [
	"lint",
	"code-reviewer",
	"commit",
] as const;

type WorkerGateStageIndex = 0 | 1 | 2 | 3;

export type ImplementationWorkerGateAgent =
	(typeof IMPLEMENTATION_WORKER_GATE_SEQUENCE)[number];

const IMPLEMENTATION_WORKER_GATE_AGENT_SET = new Set<string>(
	IMPLEMENTATION_WORKER_GATE_SEQUENCE,
);
const IMPLEMENTATION_WORKER_ROLE_RE = /<role>\s*Implementation subagent\b/i;
const IMPLEMENTATION_WORKER_MARKER_RE =
	/Implementation subagent for delegated coding work/i;
const IMPLEMENTATION_WORKER_DELIVERY_LOOP_RE =
	/<delivery_loop>[\s\S]*?spawn a `lint` subagent[\s\S]*?code-reviewer[\s\S]*?commit/i;

export interface ImplementationWorkerGateStageStats {
	attempts: number;
	successes: number;
	failures: number;
	lastFailureReason?: string;
}

export interface ImplementationWorkerGateState {
	stageIndex: WorkerGateStageIndex;
	stages: Record<
		ImplementationWorkerGateAgent,
		ImplementationWorkerGateStageStats
	>;
}

export interface ImplementationWorkerGateOutcome {
	success: boolean;
	reason?: string;
}

export interface ImplementationWorkerSubmitDecision {
	allowed: boolean;
	reason?: string;
}

export function isImplementationWorkerPrompt(
	systemPrompt: string | undefined,
	prompt: string | undefined,
): boolean {
	const mergedPrompt = `${systemPrompt ?? ""}\n${prompt ?? ""}`;
	return (
		IMPLEMENTATION_WORKER_ROLE_RE.test(mergedPrompt) ||
		IMPLEMENTATION_WORKER_MARKER_RE.test(mergedPrompt) ||
		IMPLEMENTATION_WORKER_DELIVERY_LOOP_RE.test(mergedPrompt)
	);
}

export function isImplementationWorkerGateAgent(
	value: string | undefined,
): value is ImplementationWorkerGateAgent {
	return typeof value === "string" && IMPLEMENTATION_WORKER_GATE_AGENT_SET.has(value);
}

export function createImplementationWorkerGateState(): ImplementationWorkerGateState {
	return {
		stageIndex: 0,
		stages: {
			lint: { attempts: 0, successes: 0, failures: 0 },
			"code-reviewer": { attempts: 0, successes: 0, failures: 0 },
			commit: { attempts: 0, successes: 0, failures: 0 },
		},
	};
}

function evaluateNextStageIndex(
	previousStageIndex: WorkerGateStageIndex,
	agent: ImplementationWorkerGateAgent,
	outcome: ImplementationWorkerGateOutcome,
): WorkerGateStageIndex {
	if (outcome.success) {
		switch (agent) {
			case "lint":
				return 1;
			case "code-reviewer":
				return previousStageIndex >= 1 ? 2 : previousStageIndex;
			case "commit":
				return previousStageIndex >= 2 ? 3 : previousStageIndex;
			default:
				return previousStageIndex;
		}
	}

	switch (agent) {
		case "lint":
			return 0;
		case "code-reviewer":
			return Math.min(previousStageIndex, 1) as WorkerGateStageIndex;
		case "commit":
			return Math.min(previousStageIndex, 2) as WorkerGateStageIndex;
		default:
			return previousStageIndex;
	}
}

export function recordImplementationWorkerGateOutcome(
	state: ImplementationWorkerGateState,
	agent: ImplementationWorkerGateAgent,
	outcome: ImplementationWorkerGateOutcome,
): ImplementationWorkerGateState {
	const previousStage = state.stages[agent];
	const nextStage: ImplementationWorkerGateStageStats = {
		...previousStage,
		attempts: previousStage.attempts + 1,
		successes: previousStage.successes + (outcome.success ? 1 : 0),
		failures: previousStage.failures + (outcome.success ? 0 : 1),
		lastFailureReason: outcome.success ? undefined : outcome.reason,
	};

	return {
		stageIndex: evaluateNextStageIndex(state.stageIndex, agent, outcome),
		stages: {
			...state.stages,
			[agent]: nextStage,
		},
	};
}

export function getImplementationWorkerSubmitDecision(
	state: ImplementationWorkerGateState,
): ImplementationWorkerSubmitDecision {
	if (state.stageIndex === 3) {
		return { allowed: true };
	}

	const missingStep =
		state.stageIndex < 1
			? "a successful lint task"
			: state.stageIndex < 2
				? "a successful code-reviewer task after lint"
				: "a successful commit task after code-reviewer";

	const stageFailureReasons = [
		state.stages.lint.lastFailureReason,
		state.stages["code-reviewer"].lastFailureReason,
		state.stages.commit.lastFailureReason,
	].filter((value): value is string => Boolean(value && value.trim()));
	const latestFailureReason = stageFailureReasons.at(-1);

	return {
		allowed: false,
		reason: latestFailureReason
			? `Implementation workflow gate: submit_result blocked until ${missingStep}. Last failure: ${latestFailureReason}.`
			: `Implementation workflow gate: submit_result blocked until ${missingStep}.`,
	};
}

function evaluateStageSuccessFromSubmitData(
	agent: ImplementationWorkerGateAgent,
	data: unknown,
): ImplementationWorkerGateOutcome {
	const record = asRecord(data);
	if (!record) {
		return {
			success: false,
			reason: "submit_result data payload is missing or not an object",
		};
	}

	switch (agent) {
		case "lint":
			if (record.passed === true) return { success: true };
			return {
				success: false,
				reason: "lint output indicates checks did not pass",
			};
		case "code-reviewer":
			if (record.verdict === "go") return { success: true };
			return {
				success: false,
				reason: "code-reviewer output verdict is not go",
			};
		case "commit":
			if (record.success === true) return { success: true };
			return {
				success: false,
				reason: "commit output indicates commit/push did not succeed",
			};
		default:
			return {
				success: false,
				reason: "unknown worker gate stage",
			};
	}
}

export function evaluateImplementationWorkerGateTaskResult(
	input: {
		isError: boolean;
		details: unknown;
	},
	agent: ImplementationWorkerGateAgent,
): ImplementationWorkerGateOutcome {
	if (input.isError) {
		return {
			success: false,
			reason: "task tool returned an error result",
		};
	}

	const details = asRecord(input.details);
	if (!details) {
		return {
			success: false,
			reason: "task tool did not return structured details",
		};
	}

	const rawResults = details.results;
	if (!Array.isArray(rawResults) || rawResults.length === 0) {
		return {
			success: false,
			reason: "task tool details.results is missing or empty",
		};
	}

	for (let index = 0; index < rawResults.length; index += 1) {
		const result = asRecord(rawResults[index]);
		if (!result) {
			return {
				success: false,
				reason: `task result #${index + 1} is not an object`,
			};
		}

		if (typeof result.exitCode !== "number" || result.exitCode !== 0) {
			return {
				success: false,
				reason: `task result #${index + 1} exited non-zero`,
			};
		}

		if (result.aborted === true) {
			return {
				success: false,
				reason: `task result #${index + 1} was aborted`,
			};
		}

		if (typeof result.error === "string" && result.error.trim().length > 0) {
			return {
				success: false,
				reason: `task result #${index + 1} reported an error`,
			};
		}

		const extractedToolData = asRecord(result.extractedToolData);
		if (!extractedToolData) {
			return {
				success: false,
				reason: `task result #${index + 1} missing extractedToolData`,
			};
		}

		const submitResultEvents = extractedToolData.submit_result;
		if (!Array.isArray(submitResultEvents) || submitResultEvents.length === 0) {
			return {
				success: false,
				reason: `task result #${index + 1} missing structured submit_result payload`,
			};
		}

		const lastSubmitResult = asRecord(submitResultEvents[submitResultEvents.length - 1]);
		if (!lastSubmitResult || lastSubmitResult.status !== "success") {
			return {
				success: false,
				reason: `task result #${index + 1} submit_result did not finish with success status`,
			};
		}

		if (!("data" in lastSubmitResult)) {
			return {
				success: false,
				reason: `task result #${index + 1} submit_result success payload is missing data`,
			};
		}

		const stageOutcome = evaluateStageSuccessFromSubmitData(
			agent,
			lastSubmitResult.data,
		);
		if (!stageOutcome.success) {
			return {
				success: false,
				reason: `task result #${index + 1} ${stageOutcome.reason ?? "failed stage validation"}`
			};
		}
	}

	return { success: true };
}
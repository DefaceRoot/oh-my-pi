const SWARM_CONTEXT_PATTERN = /<swarm_context>[\s\S]*?<\/swarm_context>/gi;
const GOAL_BLOCK_PATTERN = /<goal>\s*([\s\S]*?)\s*<\/goal>/i;
const TEMPLATE_WRAPPER_PATTERN = /^<\/?(?:context|goal)>$/i;
const TEMPLATE_SENTENCE = "Your assignment is below. Your work begins now.";
const GENERIC_SECTION_HEADINGS = new Set([
	"background",
	"task",
	"goal",
	"target",
	"change",
	"edge case",
	"edge cases",
	"acceptance",
	"constraints",
	"non-goal",
	"non-goals",
]);

function stripSwarmContext(task: string): string {
	return task.replace(SWARM_CONTEXT_PATTERN, " ");
}

function extractGoalBlock(task: string): string | undefined {
	const match = GOAL_BLOCK_PATTERN.exec(task);
	return match?.[1];
}

function isDecorativeSeparator(line: string): boolean {
	const compact = line.replace(/\s+/g, "");
	if (/^[═━─=-]{6,}$/u.test(compact)) {
		return true;
	}
	return /^(?:[═━─=-]{3,}).*(?:[═━─=-]{3,})$/u.test(compact);
}

function isTemplateBoilerplate(line: string): boolean {
	if (!line) return true;
	if (line === TEMPLATE_SENTENCE) return true;
	if (TEMPLATE_WRAPPER_PATTERN.test(line)) return true;
	if (isDecorativeSeparator(line)) return true;
	return false;
}

function normalizeContextCandidate(line: string): string | undefined {
	if (isTemplateBoilerplate(line)) {
		return undefined;
	}

	let normalized = line.trim();
	normalized = normalized.replace(/^#{1,6}\s+/, "").trim();
	normalized = normalized.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
	if (!normalized) {
		return undefined;
	}

	if (GENERIC_SECTION_HEADINGS.has(normalized.toLowerCase())) {
		return undefined;
	}
	return normalized;
}

function clipPreview(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function meaningfulTaskLines(task: string): string[] {
	const stripped = stripSwarmContext(task);
	const goal = extractGoalBlock(stripped);
	const source = goal ?? stripped;
	return source
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
}

export function extractTaskContextPreview(task: string, maxChars = 160): string | undefined {
	if (!task) {
		return undefined;
	}
	for (const line of meaningfulTaskLines(task)) {
		const candidate = normalizeContextCandidate(line);
		if (candidate) {
			return clipPreview(candidate, maxChars);
		}
	}
	return undefined;
}

export function extractAssignmentPreview(task: string, maxLines = 8): string | undefined {
	if (!task) {
		return undefined;
	}
	const lines = meaningfulTaskLines(task)
		.map(line => line.trimEnd())
		.filter(line => !isTemplateBoilerplate(line))
		.slice(0, maxLines);
	if (lines.length === 0) {
		return undefined;
	}
	return lines.join("\n");
}

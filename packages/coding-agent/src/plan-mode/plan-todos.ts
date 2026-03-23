import { createTodoPhasesFromInput, type TodoBootstrapEntryData, type TodoPhaseInput } from "../tools/todo-write";

export interface PlanTodoParseResult {
	phases: TodoPhaseInput[];
	totalUnitHeadings: number;
	extractedUnitTasks: number;
	fallbackReason?: string;
}

interface PhaseSection {
	title: string;
	markdown: string;
}

const HEADING_RE = /^(#{1,6})\s*(.+?)\s*$/;
const PLAN_SECTION_RE = /^(#{1,6})\s*Phased\s+Implementation\s+Plan\b.*$/i;
const PHASE_HEADING_RE = /^(#{1,6})\s*(Phase\s+(\d+)\b.*)$/i;
const EXACT_LEVEL_FOUR_HEADING_RE = /^####\s+/;
const UNIT_HEADING_RE = /^(#{4,6})\s*(?:(Unit)\s+)?(\d+(?:\.\d+)*)\s*(?:[:\-\u2013\u2014])\s*(.+?)\s*$/i;
const UNIT_LABEL_RE = /^(?:(Unit)\s+)?(\d+(?:\.\d+)*)\s*(?:[:\-\u2013\u2014])\s*(.+?)\s*$/i;
const DEPENDS_ON_RE = /^\*\*Depends on:\*\*\s*(.+?)\s*$/i;
const GOAL_RE = /^\*\*Goal:\*\*\s*(.+?)\s*$/i;

function extractPlanPhases(planContent: string): PhaseSection[] {
	const lines = planContent.replace(/\r\n/g, "\n").split("\n");
	type PhaseHeading = {
		line: number;
		level: number;
		phaseNumber: number;
		title: string;
	};

	const headings: PhaseHeading[] = [];
	let planSectionStart: { line: number; level: number } | undefined;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!planSectionStart) {
			const planMatch = line.match(PLAN_SECTION_RE);
			if (planMatch) {
				planSectionStart = { line: index, level: (planMatch[1] ?? "").length };
			}
		}

		const phaseMatch = line.match(PHASE_HEADING_RE);
		if (!phaseMatch) continue;
		headings.push({
			line: index,
			level: (phaseMatch[1] ?? "").length,
			phaseNumber: Number.parseInt(phaseMatch[3] ?? "0", 10),
			title: (phaseMatch[2] ?? "").trim(),
		});
	}

	let selected = headings;
	let planSectionEnd = lines.length;
	if (planSectionStart) {
		planSectionEnd = lines.length;
		for (let index = planSectionStart.line + 1; index < lines.length; index += 1) {
			const headingMatch = lines[index]?.match(HEADING_RE);
			if (!headingMatch) continue;
			const level = (headingMatch[1] ?? "").length;
			if (level <= planSectionStart.level) {
				planSectionEnd = index;
				break;
			}
		}

		const directChildren = headings.filter(
			heading =>
				heading.line > planSectionStart.line &&
				heading.line < planSectionEnd &&
				heading.level === planSectionStart.level + 1,
		);
		selected =
			directChildren.length > 0
				? directChildren
				: headings.filter(heading => heading.line > planSectionStart.line && heading.line < planSectionEnd);
	}

	const deduped: PhaseHeading[] = [];
	const seen = new Set<number>();
	for (const heading of selected) {
		if (!Number.isFinite(heading.phaseNumber) || heading.phaseNumber <= 0) continue;
		if (seen.has(heading.phaseNumber)) continue;
		seen.add(heading.phaseNumber);
		deduped.push(heading);
	}

	deduped.sort((left, right) => left.line - right.line);
	return deduped.map((heading, index) => {
		const nextLine = index < deduped.length - 1 ? deduped[index + 1].line : planSectionEnd;
		return {
			title: heading.title,
			markdown: lines.slice(heading.line, nextLine).join("\n").trim(),
		};
	});
}

function normalizeTaskContent(rawHeading: string): string {
	const match = rawHeading.match(UNIT_LABEL_RE);
	if (!match) return rawHeading.trim();
	const unitPrefix = match[1] ? `Unit ${match[2]}` : (match[2] ?? "");
	const title = (match[3] ?? "").trim();
	return `${unitPrefix}: ${title}`.trim();
}

function extractDependencyNotes(lines: string[]): string | undefined {
	for (const line of lines) {
		const match = line.trim().match(DEPENDS_ON_RE);
		if (match?.[1]) {
			return `Depends on: ${match[1].trim()}`;
		}
	}
	return undefined;
}

function extractPhaseGoal(lines: string[], phaseTitle: string): string {
	for (const line of lines) {
		const match = line.trim().match(GOAL_RE);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return phaseTitle;
}

export function parsePlanToTodoPhases(planContent: string): PlanTodoParseResult {
	const phases = extractPlanPhases(planContent);
	if (phases.length === 0) {
		return {
			phases: [],
			totalUnitHeadings: 0,
			extractedUnitTasks: 0,
			fallbackReason: "Plan parser found no phase headings.",
		};
	}

	let totalUnitHeadings = 0;
	let extractedUnitTasks = 0;
	const parsedPhases: TodoPhaseInput[] = [];

	for (const phase of phases) {
		const phaseLines = phase.markdown.split("\n");
		const bodyLines = phaseLines.slice(1);
		const tasks: NonNullable<TodoPhaseInput["tasks"]> = [];
		const unitHeadingIndexes: number[] = [];

		for (let index = 0; index < bodyLines.length; index += 1) {
			const line = bodyLines[index] ?? "";
			if (EXACT_LEVEL_FOUR_HEADING_RE.test(line.trim())) {
				totalUnitHeadings += 1;
			}
			if (UNIT_HEADING_RE.test(line.trim())) {
				unitHeadingIndexes.push(index);
			}
		}

		for (let index = 0; index < unitHeadingIndexes.length; index += 1) {
			const start = unitHeadingIndexes[index];
			const end = index < unitHeadingIndexes.length - 1 ? unitHeadingIndexes[index + 1] : bodyLines.length;
			const headingLine = (bodyLines[start] ?? "").trim();
			const dependencyNotes = extractDependencyNotes(bodyLines.slice(start + 1, end));
			tasks.push({
				content: normalizeTaskContent(headingLine.replace(/^#{4,6}\s*/, "")),
				...(dependencyNotes ? { notes: dependencyNotes } : {}),
			});
			extractedUnitTasks += 1;
		}

		if (tasks.length === 0) {
			tasks.push({ content: extractPhaseGoal(bodyLines, phase.title) });
		}

		parsedPhases.push({
			name: phase.title,
			tasks,
		});
	}

	const fallbackReason =
		totalUnitHeadings > 0 && extractedUnitTasks < totalUnitHeadings / 2
			? `Plan parser extracted fewer than half of level-four headings as todo tasks (${extractedUnitTasks}/${totalUnitHeadings}).`
			: undefined;

	return {
		phases: parsedPhases,
		totalUnitHeadings,
		extractedUnitTasks,
		...(fallbackReason ? { fallbackReason } : {}),
	};
}

export function buildPlanTodoBootstrapData(
	planContent: string,
	planFilePath: string,
): TodoBootstrapEntryData | undefined {
	const result = parsePlanToTodoPhases(planContent);
	if (result.fallbackReason || result.phases.length === 0) {
		return undefined;
	}
	const phases = createTodoPhasesFromInput(result.phases);
	return {
		source: "plan",
		planFilePath,
		phases,
		totalUnitHeadings: result.totalUnitHeadings,
		extractedUnitTasks: result.extractedUnitTasks,
	};
}

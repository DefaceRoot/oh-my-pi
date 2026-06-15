import { getReadToolPath, type ProtectedToolContext } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import { normalizeLocalScheme } from "../tools/path-utils";

/** Canonical plan alias every session's `local://` root resolves. */
const LOCAL_PLAN_ALIAS = "local://PLAN.md";

const PLAN_FILE_SUFFIX = "/plan.md";
const PLANS_SEGMENT = ".plans";

function isReadSelector(readPath: string, start: number, end: number): boolean {
	const length = end - start;
	if (length === 3 && readPath.startsWith("raw", start)) return true;
	if (length === 9 && readPath.startsWith("conflicts", start)) return true;
	return isLineSelector(readPath, start, end);
}

function isLineSelector(readPath: string, start: number, end: number): boolean {
	let index = start;
	while (index < end) {
		const rangeStart = index;
		while (index < end && isDigit(readPath.charCodeAt(index))) index++;
		if (index === rangeStart) return false;

		if (index < end) {
			const code = readPath.charCodeAt(index);
			if (code === 45) {
				index++;
				while (index < end && isDigit(readPath.charCodeAt(index))) index++;
			} else if (code === 43) {
				index++;
				const countStart = index;
				while (index < end && isDigit(readPath.charCodeAt(index))) index++;
				if (index === countStart) return false;
			}
		}

		if (index === end) return true;
		if (readPath.charCodeAt(index) !== 44) return false;
		index++;
	}
	return false;
}

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function stripReadSelectors(readPath: string): string {
	let end = readPath.length;
	while (end > 0) {
		const colon = readPath.lastIndexOf(":", end - 1);
		if (colon === -1 || !isReadSelector(readPath, colon + 1, end)) break;
		end = colon;
	}
	return end === readPath.length ? readPath : readPath.slice(0, end);
}

function readTargetsRepoBackedPlan(readPath: string): boolean {
	const read = stripReadSelectors(normalizeLocalScheme(readPath));
	if (!read.endsWith(PLAN_FILE_SUFFIX)) return false;

	let searchFrom = 0;
	while (searchFrom < read.length) {
		const index = read.indexOf(PLANS_SEGMENT, searchFrom);
		if (index === -1) return false;

		const beforeIsBoundary = index === 0 || read.charCodeAt(index - 1) === 47;
		const afterIsBoundary = read.charCodeAt(index + PLANS_SEGMENT.length) === 47;
		if (beforeIsBoundary && afterIsBoundary) return true;

		searchFrom = index + 1;
	}
	return false;
}

/** True when `readPath` targets `planTarget`, ignoring `local:/` vs `local://`
 *  scheme spelling and any trailing read selector (`:1-50`, `:raw`, …). */
function readTargetsPlan(readPath: string, planTarget: string): boolean {
	const read = normalizeLocalScheme(readPath);
	const target = normalizeLocalScheme(planTarget);
	return read === target || read.startsWith(`${target}:`);
}

/**
 * Build a compaction protection matcher that keeps `read` results for the active
 * plan file intact through prune/shake — the plan analog of skill-read
 * protection. Matches both the canonical `local://PLAN.md` alias and the
 * session's current plan reference path (the agent-chosen `local://<slug>-plan.md`),
 * so the plan survives compaction whether the agent reads it by alias or by name.
 *
 * `getPlanReferencePath` is evaluated at match time so the plan path set on
 * approval is honored immediately.
 */
export function createPlanReadMatcher(getPlanReferencePath: () => string): (context: ProtectedToolContext) => boolean {
	return (context: ProtectedToolContext) => {
		const path = getReadToolPath(context);
		if (path === undefined) return false;
		return (
			readTargetsPlan(path, LOCAL_PLAN_ALIAS) ||
			readTargetsPlan(path, getPlanReferencePath()) ||
			readTargetsRepoBackedPlan(path)
		);
	};
}

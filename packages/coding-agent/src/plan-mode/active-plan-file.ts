import * as path from "node:path";
import { resolveLocalUrlToPath } from "../internal-urls";
import { resolveToCwd } from "../tools/path-utils";

export const PLAN_MODE_ACTIVE_PLAN_FILE_ENTRY_TYPE = "plan-mode/active-plan-file";

const LEADING_TOKEN_PUNCTUATION_REGEX = /^[`"'([{<@]+/;
const TRAILING_TOKEN_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MARKDOWN_EXTENSION = ".md";
const PLANS_ROOT_FRAGMENT = `${path.sep}.omp${path.sep}sessions${path.sep}plans${path.sep}`;
const VERIFIER_ARTIFACT_FRAGMENT = `${path.sep}artifacts${path.sep}plan-verifier${path.sep}`;

type SessionEntryLike = {
	type?: unknown;
	mode?: unknown;
	role?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: unknown;
	content?: unknown;
};

interface ResolvePlanModePathOptions {
	cwd: string;
	getArtifactsDir: () => string | null;
	getSessionId: () => string | null;
}

function readPlanFilePath(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const planFilePath = (data as { planFilePath?: unknown }).planFilePath;
	if (typeof planFilePath !== "string") return undefined;
	const trimmed = planFilePath.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizePlanPathToken(token: string): string | undefined {
	const cleaned = token
		.trim()
		.replace(LEADING_TOKEN_PUNCTUATION_REGEX, "")
		.replace(TRAILING_TOKEN_PUNCTUATION_REGEX, "")
		.trim();
	if (!cleaned || cleaned.includes("<") || cleaned.includes(">")) {
		return undefined;
	}
	return cleaned;
}

function resolvePlanPathCandidate(candidate: string, options: ResolvePlanModePathOptions): string {
	if (candidate.startsWith("local://")) {
		return resolveLocalUrlToPath(candidate, {
			getArtifactsDir: options.getArtifactsDir,
			getSessionId: options.getSessionId,
		});
	}
	return path.normalize(resolveToCwd(candidate, options.cwd));
}

function isWithinDirectory(resolvedPath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, resolvedPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isCanonicalPlannedSessionPlanFile(resolvedPath: string): boolean {
	const normalized = path.normalize(resolvedPath);
	if (!normalized.includes(PLANS_ROOT_FRAGMENT)) return false;
	if (normalized.includes(VERIFIER_ARTIFACT_FRAGMENT)) return false;
	if (path.basename(normalized) !== "plan.md") return false;
	return path.basename(path.dirname(normalized)) !== "plans";
}

export function getPlanModePlansRoot(resolvedActivePlanPath: string): string | undefined {
	if (!isCanonicalPlannedSessionPlanFile(resolvedActivePlanPath)) return undefined;
	return path.dirname(path.dirname(path.normalize(resolvedActivePlanPath)));
}

export function isPlanModeWritableMarkdownFile(
	resolvedTargetPath: string,
	resolvedActivePlanPath: string,
): boolean {
	const normalizedTarget = path.normalize(resolvedTargetPath);
	if (path.extname(normalizedTarget).toLowerCase() !== MARKDOWN_EXTENSION) return false;
	if (normalizedTarget.includes(VERIFIER_ARTIFACT_FRAGMENT)) return false;

	const plansRoot = getPlanModePlansRoot(resolvedActivePlanPath);
	if (!plansRoot) {
		return normalizedTarget === path.normalize(resolvedActivePlanPath);
	}

	return isWithinDirectory(normalizedTarget, plansRoot);
}

function toStoredPlanFilePath(candidate: string, resolvedPath: string, cwd: string): string {
	if (candidate.startsWith("local://")) {
		return candidate;
	}
	const relative = path.relative(cwd, resolvedPath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return path.normalize(relative);
	}
	return resolvedPath;
}

function normalizeStoredPlanFilePath(
	planFilePath: string,
	options?: ResolvePlanModePathOptions,
): string {
	const trimmed = planFilePath.trim();
	if (!options) return trimmed;
	try {
		const resolvedPath = resolvePlanPathCandidate(trimmed, options);
		if (!isCanonicalPlannedSessionPlanFile(resolvedPath)) return trimmed;
		return toStoredPlanFilePath(trimmed, resolvedPath, options.cwd);
	} catch {
		return trimmed;
	}
}

function readCanonicalPlanPathField(
	data: unknown,
	fieldName: "path" | "planFilePath",
	options: ResolvePlanModePathOptions,
): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = (data as Record<string, unknown>)[fieldName];
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const trimmed = value.trim();
	const resolvedPath = resolvePlanPathCandidate(trimmed, options);
	if (!isCanonicalPlannedSessionPlanFile(resolvedPath)) return undefined;
	return toStoredPlanFilePath(trimmed, resolvedPath, options.cwd);
}

function readCanonicalPlanPathFromContent(
	content: unknown,
	options: ResolvePlanModePathOptions,
): string | undefined {
	if (typeof content === "string") {
		return resolveExplicitPlanModePlanFilePath(content, options);
	}
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (!block || typeof block !== "object") continue;
		const blockType = (block as { type?: unknown }).type;
		if (blockType === "toolCall") {
			const pathFromArgs = readCanonicalPlanPathField(
				(block as { arguments?: unknown }).arguments,
				"path",
				options,
			);
			if (pathFromArgs) return pathFromArgs;
		}
		if (blockType === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text !== "string") continue;
			const planPathFromText = resolveExplicitPlanModePlanFilePath(text, options);
			if (planPathFromText) return planPathFromText;
		}
	}
	return undefined;
}

function readCanonicalPlanPathFromEntry(
	entry: SessionEntryLike,
	options: ResolvePlanModePathOptions,
): string | undefined {
	const explicitDataPath = readCanonicalPlanPathField(entry.data, "planFilePath", options);
	if (explicitDataPath) return explicitDataPath;
	if (entry.type === "message") {
		const message = entry.message;
		if (!message || typeof message !== "object") return undefined;
		return readCanonicalPlanPathFromContent(
			(message as { content?: unknown }).content,
			options,
		);
	}
	if (entry.type === "custom_message") {
		return readCanonicalPlanPathFromContent(entry.content, options);
	}
	return undefined;
}

export function getLatestPlanModeActivePlanFilePath(
	entries: ReadonlyArray<SessionEntryLike>,
	options?: ResolvePlanModePathOptions,
): string | undefined {
	let overridePlanFilePath: string | undefined;
	let activePlanFilePath: string | undefined;
	let inferredPlanFilePath: string | undefined;
	let sawPlanModelSegment = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		if (
			entry.type === "custom" &&
			entry.customType === PLAN_MODE_ACTIVE_PLAN_FILE_ENTRY_TYPE &&
			overridePlanFilePath === undefined
		) {
			const planFilePath = readPlanFilePath(entry.data);
			if (planFilePath) {
				overridePlanFilePath = normalizeStoredPlanFilePath(planFilePath, options);
			}
			continue;
		}
		if (entry.type !== "mode_change") {
			if (options && inferredPlanFilePath === undefined) {
				const inferredPath = readCanonicalPlanPathFromEntry(entry, options);
				if (inferredPath) {
					inferredPlanFilePath = inferredPath;
				}
			}
			if (entry.type === "model_change") {
				const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : undefined;
				if (role === "plan") {
					sawPlanModelSegment = true;
				} else if (sawPlanModelSegment) {
					return overridePlanFilePath ?? activePlanFilePath ?? inferredPlanFilePath;
				}
			}
			continue;
		}
		if (entry.mode !== "plan") {
			return overridePlanFilePath ?? activePlanFilePath ?? inferredPlanFilePath;
		}
		if (activePlanFilePath === undefined) {
			const planFilePath = readPlanFilePath(entry.data);
			if (planFilePath) {
				activePlanFilePath = normalizeStoredPlanFilePath(planFilePath, options);
			}
		}
	}
	return overridePlanFilePath ?? activePlanFilePath ?? inferredPlanFilePath;
}

export function resolveExplicitPlanModePlanFilePath(
	text: string,
	options: ResolvePlanModePathOptions,
): string | undefined {
	const distinctCandidates = new Set<string>();
	for (const rawToken of text.split(/\s+/)) {
		const candidate = sanitizePlanPathToken(rawToken);
		if (!candidate || !candidate.toLowerCase().endsWith("plan.md")) continue;
		const resolvedCandidate = resolvePlanPathCandidate(candidate, options);
		if (!isCanonicalPlannedSessionPlanFile(resolvedCandidate)) continue;
		distinctCandidates.add(toStoredPlanFilePath(candidate, resolvedCandidate, options.cwd));
		if (distinctCandidates.size > 1) {
			return undefined;
		}
	}
	const [resolvedPlanFilePath] = distinctCandidates;
	return resolvedPlanFilePath;
}

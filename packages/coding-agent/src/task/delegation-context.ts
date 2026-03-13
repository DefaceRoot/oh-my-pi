import path from "node:path";
import type { ToolSession } from "..";
import { resolveLocalUrlToPath } from "../internal-urls";
import { getLatestPlanModeActivePlanFilePath } from "../plan-mode/active-plan-file";
import { resolveToCwd } from "../tools/path-utils";

const DELEGATION_CONTEXT_BLOCK_RE = /<delegation_context>\s*([\s\S]*?)<\/delegation_context>/gi;
const IMPLEMENTATION_ENGINE_STATE_ENTRY_TYPE = "implementation-engine/state";
const IMPLEMENTATION_ENGINE_PLAN_ENTRY_TYPE = "implementation-engine/plan-new-metadata";

type SessionEntryLike = {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

interface DelegationMetadata {
	repositoryCwd: string;
	parentRuntimeRole?: string;
	workflowMode?: string;
	worktreePath?: string;
	repoRoot?: string;
	branchName?: string;
	baseBranch?: string;
	planReference?: string;
	planFilePath?: string;
	planWorkspaceDir?: string;
}

interface PersistedWorktreeStateLike {
	baseBranch: string;
	branchName: string;
	worktreePath: string;
	repoRoot?: string;
	planFilePath?: string;
	planWorkspaceDir?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRuntimeRole(role: string | undefined): string | undefined {
	const normalized = role?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseDelegationValue(rawValue: string): string | undefined {
	if (!rawValue.trim()) return undefined;
	try {
		const parsed = JSON.parse(rawValue);
		return typeof parsed === "string" ? normalizeString(parsed) : undefined;
	} catch {
		return normalizeString(rawValue);
	}
}

function parseDelegationContext(text: string | undefined): Partial<DelegationMetadata> {
	if (!text) return {};
	let block: string | undefined;
	for (const match of text.matchAll(DELEGATION_CONTEXT_BLOCK_RE)) {
		block = match[1];
	}
	if (!block) return {};

	const metadata: Partial<DelegationMetadata> = {};
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const separatorIndex = line.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		const value = parseDelegationValue(line.slice(separatorIndex + 1).trim());
		if (!value) continue;
		switch (key) {
			case "repository_cwd":
				metadata.repositoryCwd = value;
				break;
			case "parent_runtime_role":
				metadata.parentRuntimeRole = value;
				break;
			case "workflow_mode":
				metadata.workflowMode = value;
				break;
			case "worktree_path":
				metadata.worktreePath = value;
				break;
			case "repo_root":
				metadata.repoRoot = value;
				break;
			case "branch_name":
				metadata.branchName = value;
				break;
			case "base_branch":
				metadata.baseBranch = value;
				break;
			case "plan_reference":
				metadata.planReference = value;
				break;
			case "plan_file_path":
				metadata.planFilePath = value;
				break;
			case "plan_workspace_dir":
				metadata.planWorkspaceDir = value;
				break;
		}
	}
	return metadata;
}

function resolveSessionPath(rawPath: string, session: ToolSession): string {
	if (rawPath.startsWith("local://")) {
		return path.normalize(
			resolveLocalUrlToPath(rawPath, {
				getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
				getSessionId: () => session.getSessionId?.() ?? null,
			}),
		);
	}
	return path.normalize(resolveToCwd(rawPath, session.cwd));
}

function resolveOptionalSessionPath(rawPath: string | undefined, session: ToolSession): string | undefined {
	const candidate = normalizeString(rawPath);
	if (!candidate) return undefined;
	try {
		return resolveSessionPath(candidate, session);
	} catch {
		return candidate;
	}
}

function readPersistedWorktreeState(entries: ReadonlyArray<SessionEntryLike>): PersistedWorktreeStateLike | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== IMPLEMENTATION_ENGINE_STATE_ENTRY_TYPE) continue;
		const data = asRecord(entry.data);
		if (!data) continue;
		const baseBranch = normalizeString(data.baseBranch);
		const branchName = normalizeString(data.branchName);
		const worktreePath = normalizeString(data.worktreePath);
		if (!baseBranch || !branchName || !worktreePath) continue;
		return {
			baseBranch,
			branchName,
			worktreePath,
			repoRoot: normalizeString(data.repoRoot),
			planFilePath: normalizeString(data.planFilePath),
			planWorkspaceDir: normalizeString(data.planWorkspaceDir),
		};
	}
	return undefined;
}

function readPersistedPlanReference(entries: ReadonlyArray<SessionEntryLike>): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== IMPLEMENTATION_ENGINE_PLAN_ENTRY_TYPE) continue;
		const data = asRecord(entry.data);
		const planFilePath = normalizeString(data?.planFilePath);
		if (planFilePath) return planFilePath;
	}
	return undefined;
}

function determineWorkflowMode(args: {
	planModeEnabled: boolean;
	worktreePath?: string;
	planFilePath?: string;
	inheritedWorkflowMode?: string;
}): string | undefined {
	if (args.planModeEnabled) return "plan_mode";
	if (args.worktreePath) return "implementation_worktree";
	if (args.planFilePath) return args.inheritedWorkflowMode ?? "plan_linked";
	return args.inheritedWorkflowMode;
}

function maybeGetActivePlanReference(
	session: ToolSession,
	entries: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
	if (entries.length === 0) return undefined;
	return getLatestPlanModeActivePlanFilePath(entries, {
		cwd: session.cwd,
		getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
		getSessionId: () => session.getSessionId?.() ?? null,
	});
}

export function buildDelegationContext(session: ToolSession): string | undefined {
	const inherited = parseDelegationContext(session.getCompactContext?.());
	const entries = session.getSessionEntries?.() ?? [];
	const worktreeState = readPersistedWorktreeState(entries);
	const planModeState = session.getPlanModeState?.();
	const planReference =
		normalizeString(planModeState?.planFilePath) ??
		worktreeState?.planFilePath ??
		readPersistedPlanReference(entries) ??
		maybeGetActivePlanReference(session, entries) ??
		inherited.planReference ??
		inherited.planFilePath;
	const planFilePath = resolveOptionalSessionPath(planReference, session) ?? inherited.planFilePath;
	const planWorkspaceDir =
		resolveOptionalSessionPath(worktreeState?.planWorkspaceDir, session) ??
		(planFilePath ? path.dirname(planFilePath) : inherited.planWorkspaceDir);
	const metadata: DelegationMetadata = {
		repositoryCwd: session.cwd,
		parentRuntimeRole: normalizeRuntimeRole(session.getRuntimeRole?.()) ?? inherited.parentRuntimeRole,
		workflowMode: determineWorkflowMode({
			planModeEnabled: planModeState?.enabled === true,
			worktreePath: worktreeState?.worktreePath ?? inherited.worktreePath,
			planFilePath,
			inheritedWorkflowMode: inherited.workflowMode,
		}),
		worktreePath: resolveOptionalSessionPath(worktreeState?.worktreePath, session) ?? inherited.worktreePath,
		repoRoot: resolveOptionalSessionPath(worktreeState?.repoRoot, session) ?? inherited.repoRoot,
		branchName: worktreeState?.branchName ?? inherited.branchName,
		baseBranch: worktreeState?.baseBranch ?? inherited.baseBranch,
		planReference: planReference ?? inherited.planReference,
		planFilePath,
		planWorkspaceDir,
	};

	const hasUsefulMetadata = Boolean(
		metadata.parentRuntimeRole ||
		metadata.workflowMode ||
		metadata.worktreePath ||
		metadata.repoRoot ||
		metadata.branchName ||
		metadata.baseBranch ||
		metadata.planReference ||
		metadata.planFilePath ||
		metadata.planWorkspaceDir,
	);
	if (!hasUsefulMetadata) return undefined;

	const lines = [
		"<delegation_context>",
		`repository_cwd: ${JSON.stringify(metadata.repositoryCwd)}`,
	];
	if (metadata.parentRuntimeRole) {
		lines.push(`parent_runtime_role: ${JSON.stringify(metadata.parentRuntimeRole)}`);
	}
	if (metadata.workflowMode) {
		lines.push(`workflow_mode: ${JSON.stringify(metadata.workflowMode)}`);
	}
	if (metadata.worktreePath) {
		lines.push(`worktree_path: ${JSON.stringify(metadata.worktreePath)}`);
	}
	if (metadata.repoRoot) {
		lines.push(`repo_root: ${JSON.stringify(metadata.repoRoot)}`);
	}
	if (metadata.branchName) {
		lines.push(`branch_name: ${JSON.stringify(metadata.branchName)}`);
	}
	if (metadata.baseBranch) {
		lines.push(`base_branch: ${JSON.stringify(metadata.baseBranch)}`);
	}
	if (metadata.planReference) {
		lines.push(`plan_reference: ${JSON.stringify(metadata.planReference)}`);
	}
	if (metadata.planFilePath) {
		lines.push(`plan_file_path: ${JSON.stringify(metadata.planFilePath)}`);
	}
	if (metadata.planWorkspaceDir) {
		lines.push(`plan_workspace_dir: ${JSON.stringify(metadata.planWorkspaceDir)}`);
	}
	lines.push("</delegation_context>");
	return lines.join("\n");
}

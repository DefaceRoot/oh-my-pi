import { resolveLocalUrlToPath } from "../internal-urls";
import { isPlanModeWritableMarkdownFile } from "../plan-mode/active-plan-file";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const LOCAL_URL_PREFIX = "local://";
const PLAN_MODE_WRITE_SCOPE_ERROR =
	"Plan mode: only markdown files under the active plans root may be modified, and plan-verifier artifacts remain blocked.";

export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	if (targetPath.startsWith(LOCAL_URL_PREFIX)) {
		return resolveLocalUrlToPath(targetPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
	}

	return resolveToCwd(targetPath, session.cwd);
}

export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	const resolvedTarget = resolvePlanPath(session, targetPath);
	const resolvedPlan = resolvePlanPath(session, state.planFilePath);

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (!isPlanModeWritableMarkdownFile(resolvedTarget, resolvedPlan)) {
		throw new ToolError(`${PLAN_MODE_WRITE_SCOPE_ERROR} Attempted path: ${targetPath}`);
	}
}

import * as fs from "node:fs";
import * as path from "node:path";

export type SessionType = "feature" | "fix" | "refactor" | "chore" | "docs";

export interface SessionWorkspace {
	path: string;
	type: SessionType;
	slug: string;
	created: boolean;
}

function resolveDate(date?: string): string {
	if (!date) return new Date().toISOString().split("T")[0];
	const trimmed = date.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

	const parsed = new Date(trimmed);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed.toISOString().split("T")[0];
	}

	return new Date().toISOString().split("T")[0];
}

/**
 * Slugifies a title: lowercase, replace non-alphanum with hyphens, trim hyphens.
 */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");

	return slug || "session";
}

/**
 * Resolves and optionally creates a session workspace directory.
 * @param repoRoot - absolute path to repo root
 * @param type - session type (feature, fix, refactor, chore, docs)
 * @param title - human-readable session title (will be slugified)
 * @param date - optional date override (defaults to today)
 */
export function resolveSessionWorkspace(
	repoRoot: string,
	type: SessionType,
	title: string,
	date?: string,
): SessionWorkspace {
	if (!path.isAbsolute(repoRoot)) {
		throw new Error(`repoRoot must be an absolute path: ${repoRoot}`);
	}

	const day = resolveDate(date);
	const normalizedSlug = `${day}-${slugify(title)}`;
	const workspacePath = path.join(repoRoot, ".omp", "sessions", type, normalizedSlug);

	return {
		path: workspacePath,
		type,
		slug: normalizedSlug,
		created: false,
	};
}

/**
 * Ensures the session workspace directory exists on disk.
 */
export async function ensureSessionWorkspace(workspace: SessionWorkspace): Promise<void> {
	const exists = fs.existsSync(workspace.path);
	if (exists) {
		workspace.created = false;
		return;
	}

	await fs.promises.mkdir(workspace.path, { recursive: true });
	workspace.created = true;
}

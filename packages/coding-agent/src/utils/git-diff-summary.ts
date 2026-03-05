import { $ } from "bun";

export interface ModifiedFileSummary {
	path: string;
	status: "M" | "A" | "D" | "R" | "?";
}

const MAX_MODIFIED_FILES = 50;

function normalizeStatus(status: string): ModifiedFileSummary["status"] | undefined {
	if (status.startsWith("R")) return "R";
	if (status.startsWith("M")) return "M";
	if (status.startsWith("A")) return "A";
	if (status.startsWith("D")) return "D";
	return undefined;
}

function parseDiffNameStatus(output: string): ModifiedFileSummary[] {
	const entries: ModifiedFileSummary[] = [];
	for (const line of output.split("\n")) {
		const cleanLine = line.replace(/\r$/, "");
		if (!cleanLine) continue;
		const columns = cleanLine.split("\t");
		if (columns.length < 2) continue;
		const status = normalizeStatus(columns[0] ?? "");
		if (!status) continue;
		const path = status === "R" ? (columns[2] ?? columns[1] ?? "") : (columns[1] ?? "");
		if (!path) continue;
		entries.push({ path, status });
		if (entries.length >= MAX_MODIFIED_FILES) break;
	}
	return entries;
}

function parseUntracked(output: string): ModifiedFileSummary[] {
	const entries: ModifiedFileSummary[] = [];
	for (const line of output.split("\n")) {
		const path = line.replace(/\r$/, "");
		if (!path) continue;
		entries.push({ path, status: "?" });
		if (entries.length >= MAX_MODIFIED_FILES) break;
	}
	return entries;
}

function mergeSummaries(tracked: ModifiedFileSummary[], untracked: ModifiedFileSummary[]): ModifiedFileSummary[] {
	const deduped = new Map<string, ModifiedFileSummary["status"]>();
	for (const entry of tracked) {
		deduped.set(entry.path, entry.status);
		if (deduped.size >= MAX_MODIFIED_FILES) {
			return Array.from(deduped, ([path, status]) => ({ path, status }));
		}
	}
	for (const entry of untracked) {
		if (!deduped.has(entry.path)) {
			deduped.set(entry.path, entry.status);
		}
		if (deduped.size >= MAX_MODIFIED_FILES) break;
	}
	return Array.from(deduped, ([path, status]) => ({ path, status }));
}

// Returns a list of modified files relative to cwd.
// Uses git diff --name-status HEAD (includes staged + unstaged vs last commit).
// Also includes untracked files via git ls-files --others --exclude-standard.
export async function getModifiedFiles(cwd: string): Promise<ModifiedFileSummary[]> {
	try {
		const diffResult = await $`git diff --name-status HEAD`.cwd(cwd).quiet().nothrow();
		if (diffResult.exitCode !== 0) return [];

		const untrackedResult = await $`git ls-files --others --exclude-standard`.cwd(cwd).quiet().nothrow();
		if (untrackedResult.exitCode !== 0) return [];

		const tracked = parseDiffNameStatus(diffResult.text());
		const untracked = parseUntracked(untrackedResult.text());
		return mergeSummaries(tracked, untracked);
	} catch {
		return [];
	}
}

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

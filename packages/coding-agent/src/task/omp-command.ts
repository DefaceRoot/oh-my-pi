import process from "node:process";
import { existsSync } from "node:fs";

import { $env } from "@oh-my-pi/pi-utils";
import { FORK_DIRECT_ENTRY } from "../cli/update-cli";

interface OmpCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "omp.cmd" : "omp";
const DEFAULT_SHELL = process.platform === "win32";

export const SESSION_ARTIFACT_DIR_TEMPLATES = {
	planned: ".omp/sessions/plans/<plan>/<nested_dir_for_all_subagents>",
	nonPlanned: ".omp/sessions/<session>/<nested_dir_for_all_subagents>",
} as const;

export function resolveOmpCommand(): OmpCommand {
	const envCmd = $env.PI_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	// Fork-direct path: prefer fork entry when available (even if launched from global binary)
	if (existsSync(FORK_DIRECT_ENTRY)) {
		return { cmd: process.execPath, args: [FORK_DIRECT_ENTRY], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}

export function buildOmpResumeArgs(sessionFile: string | undefined): string[] {
	return sessionFile ? ["--resume", sessionFile] : [];
}

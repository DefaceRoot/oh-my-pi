/**
 * live-log-watcher extension
 *
 * Detects bash tool calls that redirect output to a log file (tee, >, 2>&1 | tee)
 * and writes ~/.omp/agent/live-log-state.json while the command is running.
 * agents_view polls this file to show a live-stream indicator and popup viewer.
 *
 * OMP runs one tool at a time (sequential), so a simple write-on-call /
 * delete-on-result contract is sufficient — no call-ID correlation needed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const STATE_FILE = `${os.homedir()}/.omp/agent/live-log-state.json`;

/**
 * Extracts the log file path from a bash command, if one is present.
 *
 * Matches:
 *   tee /tmp/deploy.log
 *   tee -a /tmp/deploy.log
 *   2>&1 | tee /tmp/deploy-run7.log
 *   cmd > file.log
 *   cmd >> file.log
 *   cmd > file.txt
 *   cmd > file.out
 */
function extractLogPath(command: string): string | null {
	// tee [optional flags] <path> — highest confidence signal
	const teeMatch = command.match(/\btee(?:\s+-\w+)*\s+([^\s;|&<>]+)/);
	if (teeMatch) return teeMatch[1].trim();

	// Redirect to a file with a log-like extension
	const redirectMatch = command.match(
		/(?:2>&1\s*)?[&2]?>{1,2}\s*([^\s;|&<>]+\.(?:log|txt|out))/,
	);
	if (redirectMatch) return redirectMatch[1].trim();

	return null;
}

function getSessionId(ctx: ExtensionContext | undefined): string {
	const sm = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
		?.sessionManager;
	if (sm && typeof sm.getSessionId === "function") {
		const id = sm.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : "";
	}
	return "";
}

function writeState(state: object): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(state), { encoding: "utf8", flag: "w" });
	} catch {
		// Best-effort — agents_view simply won't show the indicator.
	}
}

function clearState(): void {
	try {
		fs.unlinkSync(STATE_FILE);
	} catch {
		// Already gone — nothing to do.
	}
}

export default function liveLogWatcher(pi: ExtensionAPI) {
	pi.logger.debug("live-log-watcher: loaded");

	// Whether the most-recently-started bash command has an active log target.
	let watchingLog = false;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command =
			typeof (event.input as Record<string, unknown>)?.command === "string"
				? ((event.input as Record<string, unknown>).command as string)
				: "";

		const logPath = extractLogPath(command);
		if (!logPath) return;

		watchingLog = true;
		const sessionId = getSessionId(ctx);

		pi.logger.debug(`live-log-watcher: streaming ${logPath}`);

		writeState({
			session_id: sessionId,
			log_path: logPath,
			command,
			started_at: Date.now() / 1000,
			active: true,
		});
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash") return;
		if (!watchingLog) return;

		watchingLog = false;
		clearState();
		pi.logger.debug("live-log-watcher: cleared state");
	});
}

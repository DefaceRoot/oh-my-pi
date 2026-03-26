/**
 * Sudo password detection for bash tool.
 *
 * When an agent runs `sudo` without PTY mode, sudo may open /dev/tty
 * (the controlling terminal shared with the TUI process) to prompt for a
 * password. It calls tcsetattr() which temporarily enables echo mode,
 * causing mouse-tracking SGR sequences to appear as literal text in the
 * editor. This module detects when sudo will need a password so the caller
 * can upgrade to PTY mode before that happens.
 */

import { executeBash } from "../exec/bash-executor";

/**
 * Returns true when the command is a sudo invocation that _might_ need an
 * interactive password prompt, i.e. it does not already carry -n or -S.
 */
export function isSudoCandidate(command: string): boolean {
	const trimmed = command.trimStart();
	// Must begin with the `sudo` keyword
	if (!/^sudo\b/u.test(trimmed)) return false;
	const afterSudo = trimmed.slice(4);
	// Already non-interactive: won't open /dev/tty
	if (/(?:^|\s)-[A-Za-z]*n/u.test(afterSudo)) return false;
	// Reading password from stdin: won't open /dev/tty
	if (/(?:^|\s)-[A-Za-z]*S/u.test(afterSudo)) return false;
	return true;
}

/**
 * Returns true when `sudo -n -v` indicates that the current user's sudo
 * credentials are not cached (i.e. a password will be required at runtime).
 *
 * Uses `-n` so the probe itself never opens /dev/tty. The result is a
 * conservative best-effort: per-command NOPASSWD rules are not checked
 * (that would require parsing the full sudo command).
 *
 * Safe to call concurrently — each call is a fresh one-shot subprocess.
 */
export async function detectSudoNeedsPassword(cwd: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await executeBash("sudo -n -v", {
			cwd,
			timeout: 5_000,
			signal,
		});
		if (result.exitCode === 0) {
			// Credentials are cached or NOPASSWD is configured globally
			return false;
		}
		// Exit 1 typically means a password is required
		const output = result.output.toLowerCase();
		return output.includes("password is required") || output.includes("sorry, try again") || result.exitCode !== 0;
	} catch {
		// If the probe itself fails for any reason (sudo not available, etc.),
		// don't block normal execution — the agent will see the error naturally.
		return false;
	}
}

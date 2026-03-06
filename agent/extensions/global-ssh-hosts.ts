import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface SshHostEntry {
	host?: string;
	username?: string;
	port?: number | string;
	compat?: boolean | string;
	key?: string;
	keyPath?: string;
	description?: string;
}

interface SshConfigFile {
	hosts?: Record<string, SshHostEntry>;
}

type JsonReadResult =
	| { status: "missing" }
	| { status: "ok"; value: unknown }
	| { status: "invalid"; error: string };

const HOME_DIR = process.env.HOME || "/home/colin";
const GLOBAL_SSH_CONFIG = path.join(HOME_DIR, ".omp", "agent", "ssh.json");
const TARGET_FILENAMES = ["ssh.json", ".ssh.json"];

function readJsonFile(filePath: string): JsonReadResult {
	if (!fs.existsSync(filePath)) return { status: "missing" };
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return { status: "ok", value: JSON.parse(raw) };
	} catch (error) {
		return {
			status: "invalid",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function isSshConfig(value: unknown): value is SshConfigFile {
	if (!value || typeof value !== "object") return false;
	const maybeHosts = (value as { hosts?: unknown }).hosts;
	if (maybeHosts === undefined) return true;
	return typeof maybeHosts === "object" && maybeHosts !== null;
}

function normalizeHosts(value: unknown): Record<string, SshHostEntry> {
	if (!isSshConfig(value) || !value.hosts) return {};
	const hosts: Record<string, SshHostEntry> = {};
	for (const [name, entry] of Object.entries(value.hosts)) {
		if (!name.trim()) continue;
		if (!entry || typeof entry !== "object") continue;
		hosts[name] = entry;
	}
	return hosts;
}

function pickTargetConfigPath(cwd: string): string {
	for (const filename of TARGET_FILENAMES) {
		const candidate = path.join(cwd, filename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return path.join(cwd, ".ssh.json");
}

function mergeHosts(
	existingHosts: Record<string, SshHostEntry>,
	globalHosts: Record<string, SshHostEntry>,
): { merged: Record<string, SshHostEntry>; changed: boolean; conflicts: string[] } {
	const merged = { ...existingHosts };
	const conflicts: string[] = [];
	let changed = false;

	for (const [name, host] of Object.entries(globalHosts)) {
		if (!merged[name]) {
			merged[name] = host;
			changed = true;
			continue;
		}

		const existingSerialized = JSON.stringify(merged[name]);
		const globalSerialized = JSON.stringify(host);
		if (existingSerialized !== globalSerialized) {
			conflicts.push(name);
		}
	}

	return { merged, changed, conflicts };
}

function writeSshConfig(filePath: string, hosts: Record<string, SshHostEntry>): void {
	const output: SshConfigFile = { hosts };
	const serialized = `${JSON.stringify(output, null, 2)}\n`;
	fs.writeFileSync(filePath, serialized, "utf8");
}

export default function globalSshHosts(pi: ExtensionAPI) {
	const syncedCwds = new Set<string>();

	pi.on("session_switch", async () => {
		syncedCwds.clear();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (syncedCwds.has(ctx.cwd)) return;

		const globalRead = readJsonFile(GLOBAL_SSH_CONFIG);
		if (globalRead.status === "missing") {
			syncedCwds.add(ctx.cwd);
			return;
		}
		if (globalRead.status === "invalid") {
			pi.logger.warn("global-ssh-hosts: invalid global SSH config JSON", {
				path: GLOBAL_SSH_CONFIG,
				error: globalRead.error,
			});
			syncedCwds.add(ctx.cwd);
			return;
		}

		const globalHosts = normalizeHosts(globalRead.value);
		if (Object.keys(globalHosts).length === 0) {
			syncedCwds.add(ctx.cwd);
			return;
		}

		const targetPath = pickTargetConfigPath(ctx.cwd);
		const targetRead = readJsonFile(targetPath);
		if (targetRead.status === "invalid") {
			pi.logger.warn("global-ssh-hosts: invalid project SSH config JSON, skipping sync", {
				cwd: ctx.cwd,
				targetPath,
				error: targetRead.error,
			});
			syncedCwds.add(ctx.cwd);
			return;
		}

		const existingHosts = targetRead.status === "ok" ? normalizeHosts(targetRead.value) : {};
		const { merged, changed, conflicts } = mergeHosts(existingHosts, globalHosts);

		if (conflicts.length > 0) {
			pi.logger.warn("global-ssh-hosts: host name conflicts in project SSH config", {
				cwd: ctx.cwd,
				targetPath,
				conflicts,
			});
		}

		if (changed) {
			try {
				writeSshConfig(targetPath, merged);
				pi.logger.debug("global-ssh-hosts: synced global SSH hosts into project config", {
					cwd: ctx.cwd,
					targetPath,
					hostCount: Object.keys(globalHosts).length,
				});
			} catch (error) {
				pi.logger.error("global-ssh-hosts: failed to sync SSH config", {
					cwd: ctx.cwd,
					targetPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		syncedCwds.add(ctx.cwd);
	});
}

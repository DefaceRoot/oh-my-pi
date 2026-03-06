import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomCommandFactory } from "@oh-my-pi/pi-coding-agent";

const MIN_WIDTH = 20;
const MAX_WIDTH = 120;
const DEFAULT_MODE = "split" as const;
const DEFAULT_LEFT_WIDTH = 39;
const DEFAULT_RIGHT_WIDTH = 39;
const DEFAULT_OPEN = true;

const VALID_MODES = new Set(["explorer", "telemetry", "split"] as const);
const VALID_SIDES = new Set(["left", "right"] as const);

type SidebarMode = "explorer" | "telemetry" | "split";
type SidebarSide = "left" | "right";

interface SidebarSettings {
	mode: SidebarMode;
	left_width: number;
	right_width: number;
	default_open: boolean;
}

interface SettingsPayload {
	sidebar?: Partial<SidebarSettings>;
	[key: string]: unknown;
}

interface TmuxContext {
	available: boolean;
	windowId?: string;
	error?: string;
}

interface SidebarStatus {
	open: boolean;
	mode: SidebarMode;
	leftWidth: number;
	rightWidth: number;
	leftPanePresent: boolean;
	rightPanePresent: boolean;
	tmux: TmuxContext;
	settingsPath: string;
}

interface ExecResultLike {
	code: number;
	stdout: string;
	stderr: string;
}

const USAGE = [
	"Usage:",
	"  /sidebar status",
	"  /sidebar open",
	"  /sidebar close",
	"  /sidebar toggle",
	"  /sidebar mode <explorer|telemetry|split>",
	`  /sidebar width <left|right> <${MIN_WIDTH}-${MAX_WIDTH}>`,
].join("\n");

function resolveSettingsPath(): string {
	const home = os.homedir();
	const modernPath = path.join(home, ".omp", "settings.json");
	const legacyPath = path.join(home, ".omp", "agent", "settings.json");
	if (fsSync.existsSync(modernPath)) return modernPath;
	if (fsSync.existsSync(legacyPath)) return legacyPath;
	return modernPath;
}

function resolveSidebarManagerPath(): string | undefined {
	const candidates = [
		path.resolve(import.meta.dir, "../../scripts/tmux-sidebar-manager.sh"),
		path.join(os.homedir(), ".omp", "agent", "scripts", "tmux-sidebar-manager.sh"),
	];
	for (const candidate of candidates) {
		if (fsSync.existsSync(candidate)) return candidate;
	}
	return undefined;
}

function normalizeMode(value: unknown): SidebarMode | undefined {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (VALID_MODES.has(normalized as SidebarMode)) return normalized as SidebarMode;
	return undefined;
}

function normalizeWidth(value: unknown): number | undefined {
	const numeric = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isInteger(numeric)) return undefined;
	if (numeric < MIN_WIDTH || numeric > MAX_WIDTH) return undefined;
	return numeric;
}

function normalizeDefaultOpen(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "on" || normalized === "yes") return true;
		if (normalized === "false" || normalized === "off" || normalized === "no") return false;
	}
	return undefined;
}

function sanitizeSidebarSettings(raw: unknown): SidebarSettings {
	const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		mode: normalizeMode(source.mode) ?? DEFAULT_MODE,
		left_width: normalizeWidth(source.left_width) ?? DEFAULT_LEFT_WIDTH,
		right_width: normalizeWidth(source.right_width) ?? DEFAULT_RIGHT_WIDTH,
		default_open: normalizeDefaultOpen(source.default_open) ?? DEFAULT_OPEN,
	};
}

async function loadSettingsPayload(settingsPath: string): Promise<SettingsPayload> {
	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) return parsed as SettingsPayload;
	} catch {
		// Ignore parse/read failures and fall back to defaults.
	}
	return {};
}

async function saveSettingsPayload(settingsPath: string, payload: SettingsPayload): Promise<void> {
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	const tempPath = `${settingsPath}.tmp`;
	await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await fs.rename(tempPath, settingsPath);
}

async function loadSidebarSettings(settingsPath: string): Promise<{ payload: SettingsPayload; sidebar: SidebarSettings }> {
	const payload = await loadSettingsPayload(settingsPath);
	const sidebar = sanitizeSidebarSettings(payload.sidebar);
	return { payload, sidebar };
}

async function persistSidebarSettings(
	settingsPath: string,
	payload: SettingsPayload,
	nextSidebar: SidebarSettings,
): Promise<void> {
	payload.sidebar = {
		mode: nextSidebar.mode,
		left_width: nextSidebar.left_width,
		right_width: nextSidebar.right_width,
		default_open: nextSidebar.default_open,
	};
	await saveSettingsPayload(settingsPath, payload);
}

async function runExec(
	api: Parameters<CustomCommandFactory>[0],
	command: string,
	args: string[],
	timeout = 8_000,
): Promise<ExecResultLike> {
	const result = await api.exec(command, args, { timeout });
	return {
		code: Number.isInteger(result.code) ? result.code : 1,
		stdout: String(result.stdout ?? "").trim(),
		stderr: String(result.stderr ?? "").trim(),
	};
}

async function detectTmux(api: Parameters<CustomCommandFactory>[0]): Promise<TmuxContext> {
	const version = await runExec(api, "tmux", ["-V"], 2_000);
	if (version.code !== 0) {
		return { available: false, error: "tmux is not available" };
	}

	const windowResult = await runExec(api, "tmux", ["display-message", "-p", "#{window_id}"], 2_000);
	if (windowResult.code !== 0 || !windowResult.stdout) {
		return {
			available: true,
			error: "not currently inside a tmux client",
		};
	}

	return {
		available: true,
		windowId: windowResult.stdout,
	};
}

async function tmuxGetOption(
	api: Parameters<CustomCommandFactory>[0],
	option: string,
	scope: "global" | "window" = "global",
	windowId?: string,
): Promise<string> {
	const args =
		scope === "window" && windowId
			? ["show-options", "-w", "-t", windowId, "-v", option]
			: ["show-options", "-g", "-v", option];
	const result = await runExec(api, "tmux", args, 2_000);
	if (result.code !== 0) return "";
	return result.stdout;
}

async function tmuxSetOption(
	api: Parameters<CustomCommandFactory>[0],
	scope: "global" | "window",
	option: string,
	value: string,
	windowId?: string,
): Promise<void> {
	const args =
		scope === "window" && windowId
			? ["set-option", "-w", "-t", windowId, option, value]
			: ["set-option", "-g", option, value];
	const result = await runExec(api, "tmux", args, 4_000);
	if (result.code !== 0) {
		throw new Error(result.stderr || `tmux failed to set ${option}`);
	}
}

async function tmuxSidebarPresence(
	api: Parameters<CustomCommandFactory>[0],
	windowId: string,
): Promise<{ left: boolean; right: boolean }> {
	const result = await runExec(api, "tmux", ["list-panes", "-t", windowId, "-F", "#{@sidebar_role}"], 2_000);
	if (result.code !== 0) return { left: false, right: false };
	const roles = result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	return {
		left: roles.includes("1"),
		right: roles.includes("2"),
	};
}


function detailedStatus(status: SidebarStatus): string {
	const lines = [
		`Sidebar: ${status.open ? "open" : "closed"}`,
		`Mode: ${status.mode}`,
		`Widths: left ${status.leftWidth}, right ${status.rightWidth}`,
		`Panes: left ${status.leftPanePresent ? "present" : "missing"}, right ${status.rightPanePresent ? "present" : "missing"}`,
		`tmux: ${
			status.tmux.windowId
				? `active window ${status.tmux.windowId}`
				: status.tmux.error ?? "available"
		}`,
		`Settings: ${status.settingsPath}`,
	];
	return lines.join("\n");
}

async function applyTmuxDefaults(
	api: Parameters<CustomCommandFactory>[0],
	sidebar: SidebarSettings,
	windowId?: string,
): Promise<void> {
	await tmuxSetOption(api, "global", "@sidebar_layout", sidebar.mode);
	await tmuxSetOption(api, "global", "@sidebar_mode", sidebar.mode);
	await tmuxSetOption(api, "global", "@sidebar_left_width", String(sidebar.left_width));
	await tmuxSetOption(api, "global", "@sidebar_right_width", String(sidebar.right_width));
	await tmuxSetOption(api, "global", "@sidebar_default_open", sidebar.default_open ? "1" : "0");
	if (sidebar.left_width === sidebar.right_width) {
		await tmuxSetOption(api, "global", "@sidebar_width", String(sidebar.left_width));
	}
	if (windowId) {
		await tmuxSetOption(api, "window", "@sidebar_enabled", sidebar.default_open ? "1" : "0", windowId);
	}
}

async function refreshSidebarManager(
	api: Parameters<CustomCommandFactory>[0],
	windowId: string,
	action: "ensure" | "toggle" = "ensure",
): Promise<void> {
	const managerPath = resolveSidebarManagerPath();
	if (!managerPath) {
		throw new Error("Sidebar manager script is not installed");
	}
	const result = await runExec(api, "bash", [managerPath, action, windowId], 15_000);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Sidebar manager '${action}' failed`);
	}
}

async function resolveStatus(
	api: Parameters<CustomCommandFactory>[0],
	sidebar: SidebarSettings,
	tmux: TmuxContext,
	settingsPath: string,
): Promise<SidebarStatus> {
	let mode = sidebar.mode;
	let leftWidth = sidebar.left_width;
	let rightWidth = sidebar.right_width;
	let open = sidebar.default_open;
	let leftPanePresent = false;
	let rightPanePresent = false;

	if (tmux.windowId) {
		const modeOverride = normalizeMode(await tmuxGetOption(api, "@sidebar_layout"));
		const modeLegacy = normalizeMode(await tmuxGetOption(api, "@sidebar_mode"));
		mode = modeOverride ?? modeLegacy ?? mode;

		const leftOpt = normalizeWidth(await tmuxGetOption(api, "@sidebar_left_width"));
		const rightOpt = normalizeWidth(await tmuxGetOption(api, "@sidebar_right_width"));
		const sharedOpt = normalizeWidth(await tmuxGetOption(api, "@sidebar_width"));
		leftWidth = leftOpt ?? sharedOpt ?? leftWidth;
		rightWidth = rightOpt ?? sharedOpt ?? rightWidth;

		const windowEnabled = normalizeDefaultOpen(await tmuxGetOption(api, "@sidebar_enabled", "window", tmux.windowId));
		const defaultOpen = normalizeDefaultOpen(await tmuxGetOption(api, "@sidebar_default_open"));
		open = windowEnabled ?? defaultOpen ?? open;

		const presence = await tmuxSidebarPresence(api, tmux.windowId);
		leftPanePresent = presence.left;
		rightPanePresent = presence.right;
	}

	return {
		open,
		mode,
		leftWidth,
		rightWidth,
		leftPanePresent,
		rightPanePresent,
		tmux,
		settingsPath,
	};
}

const factory: CustomCommandFactory = api => ({
	name: "sidebar",
	description: "Manage tmux sidebars (status/open/close/toggle/mode/width)",
	async execute(args, ctx) {
		const subcommand = String(args[0] ?? "status").trim().toLowerCase();
		const settingsPath = resolveSettingsPath();
		const { payload, sidebar: storedSidebar } = await loadSidebarSettings(settingsPath);
		const tmux = await detectTmux(api);
		const sidebar = { ...storedSidebar };

		const persist = async (): Promise<void> => {
			await persistSidebarSettings(settingsPath, payload, sidebar);
		};

		const showStatus = async (): Promise<void> => {
			const status = await resolveStatus(api, sidebar, tmux, settingsPath);
			ctx.ui.notify(detailedStatus(status), "info");
			ctx.ui.setStatus("sidebar", undefined);
		};

		if (subcommand === "status") {
			await showStatus();
			return;
		}

		if (subcommand === "mode") {
			const requestedMode = normalizeMode(args[1]);
			if (!requestedMode) {
				ctx.ui.notify(`Invalid mode.\n${USAGE}`, "error");
				return;
			}
			sidebar.mode = requestedMode;
			await persist();
			if (tmux.windowId) {
				await applyTmuxDefaults(api, sidebar);
				await refreshSidebarManager(api, tmux.windowId, "ensure");
				await showStatus();
				return;
			}
			ctx.ui.notify(`Saved sidebar mode '${requestedMode}'. ${tmux.error ?? "Run inside tmux to apply immediately."}`, "warning");
			return;
		}

		if (subcommand === "width") {
			const side = String(args[1] ?? "").trim().toLowerCase();
			const width = normalizeWidth(args[2]);
			if (!VALID_SIDES.has(side as SidebarSide) || width === undefined) {
				ctx.ui.notify(`Invalid width arguments.\n${USAGE}`, "error");
				return;
			}

			if (side === "left") sidebar.left_width = width;
			if (side === "right") sidebar.right_width = width;
			await persist();

			if (tmux.windowId) {
				await applyTmuxDefaults(api, sidebar);
				await refreshSidebarManager(api, tmux.windowId, "ensure");
				await showStatus();
				return;
			}

			ctx.ui.notify(`Saved sidebar ${side} width ${width}. ${tmux.error ?? "Run inside tmux to apply immediately."}`, "warning");
			return;
		}

		if (subcommand === "open" || subcommand === "close") {
			sidebar.default_open = subcommand === "open";
			await persist();
			if (tmux.windowId) {
				await applyTmuxDefaults(api, sidebar, tmux.windowId);
				await refreshSidebarManager(api, tmux.windowId, "ensure");
				await showStatus();
				return;
			}
			ctx.ui.notify(
				`Saved sidebar default '${sidebar.default_open ? "open" : "closed"}'. ${tmux.error ?? "Run inside tmux to apply immediately."}`,
				"warning",
			);
			return;
		}

		if (subcommand === "toggle") {
			if (tmux.windowId) {
				await refreshSidebarManager(api, tmux.windowId, "toggle");
				const toggledStatus = await resolveStatus(api, sidebar, tmux, settingsPath);
				sidebar.default_open = toggledStatus.open;
				await persist();
				await applyTmuxDefaults(api, sidebar);
				await showStatus();
				return;
			}

			sidebar.default_open = !sidebar.default_open;
			await persist();
			ctx.ui.notify(
				`Toggled saved default to '${sidebar.default_open ? "open" : "closed"}'. ${tmux.error ?? "Run inside tmux to apply immediately."}`,
				"warning",
			);
			return;
		}

		ctx.ui.notify(`Unknown subcommand '${subcommand}'.\n${USAGE}`, "error");
	},
});

export default factory;

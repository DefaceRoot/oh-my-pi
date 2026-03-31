/**
 * Config CLI command handlers.
 *
 * Handles `omp config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import { APP_NAME, getAgentDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	type SettingPath,
	Settings,
	type SettingValue,
	settings,
} from "../config/settings";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import { theme } from "../modes/theme/theme";
import { initXdg } from "./commands/init-xdg";

import { getBundledModels, getBundledProviders, getTemperatureBounds } from "@oh-my-pi/pi-ai";
import { parseModelString } from "../config/model-resolver";
import { MODEL_ROLE_IDS } from "../config/model-registry";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
	};
}
// =============================================================================
// Setting Filtering
// =============================================================================

type CliSettingDef = {
	path: SettingPath;
	type: string;
	description: string;
	tab: string;
};

const ALL_SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const key = path as SettingPath;
	const ui = getUi(key);
	return {
		path: key,
		type: getType(key),
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
	};
}

/** Get available values for a setting */
function getSettingValues(def: CliSettingDef): readonly string[] | undefined {
	if (def.type === "enum") {
		return getEnumValues(def.path);
	}
	return undefined;
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg"];

/**
 * Parse config subcommand arguments.
 * Returns undefined if not a config command.
 */
export function parseConfigArgs(args: string[]): ConfigCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "config") {
		return undefined;
	}

	if (args.length < 2 || args[1] === "--help" || args[1] === "-h") {
		return { action: "list", flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as ConfigAction)) {
		console.error(chalk.red(`Unknown config command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: ConfigCommandArgs = {
		action: action as ConfigAction,
		flags: {},
	};

	const positionalArgs: string[] = [];
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (!arg.startsWith("-")) {
			positionalArgs.push(arg);
		}
	}

	if (positionalArgs.length > 0) {
		result.key = positionalArgs[0];
	}
	if (positionalArgs.length > 1) {
		result.value = positionalArgs.slice(1).join(" ");
	}

	return result;
}

// =============================================================================
// Value Formatting
// =============================================================================

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = getSettingValues(def);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Schema-Driven Value Parsing
// =============================================================================


/**
 * Attempt to resolve the API type for a single model pattern string.
 *
 * Strategy:
 * 1. Exact bundled-registry lookup (provider + model ID must match precisely).
 *    Fuzzy / partial pattern matching is intentionally excluded: a fuzzy match on a
 *    multi-API provider (e.g. `gitlab-duo/claude` → `claude-haiku-…`) would return an
 *    API that is only one of several the provider supports and could silently reject
 *    temperatures that are valid for the actual model the user configured.
 * 2. If no exact match, and the model string parses as `provider/id`, check whether all
 *    bundled models for that provider share a single API type. This handles custom model
 *    IDs on well-known single-API providers (e.g. `anthropic/my-custom` →
 *    `anthropic-messages`, `openai-codex/custom` → `openai-codex-responses`) without
 *    network calls.
 * Returns `undefined` when neither strategy yields a definitive API type (multi-API
 * providers, unparseable string, or provider not in bundled registry).
 */
function inferModelApi(modelPattern: string, allBundled: ReturnType<typeof getBundledModels>): string | undefined {
	const parsed = parseModelString(modelPattern);
	if (parsed) {
		// Strategy 1: exact match only — provider AND model ID must be in the bundled registry
		const exact = allBundled.find(m => m.provider === parsed.provider && m.id === parsed.id);
		if (exact) return exact.api;
		// Strategy 2: single-API-type provider heuristic
		const providerModels = getBundledModels(parsed.provider as Parameters<typeof getBundledModels>[0]);
		const apis = [...new Set(providerModels.map(m => m.api))];
		if (apis.length === 1) return apis[0];
	}
	return undefined;
}

/**
 * Gather temperature constraints from all currently configured model roles.
 *
 * Because `temperature` is a global setting applied to every role’s model session,
 * the effective valid range is the intersection of all per-API ranges.  Any role
 * whose model resolves to an API that does not support temperature at all (e.g.
 * `openai-codex-responses`) causes the constraint to become unsupported.
 *
 * Returns:
 *   `{ supported: false }` — at least one resolved role does not accept temperature.
 *   `{ supported: true; bounds; apis }` — tightest combined bounds and the API labels
 *     that produced them (for error messages).
 */
function resolveTemperatureConstraint():
	| { supported: false }
	| { supported: true; bounds: { min: number; max: number }; apis: string[] } {
	const allBundled = getBundledProviders().flatMap(p =>
		getBundledModels(p as Parameters<typeof getBundledModels>[0]),
	);

	let combinedMin = 0;
	let combinedMax = 2;
	const constrainingApis: string[] = [];

	for (const role of MODEL_ROLE_IDS) {
		const pattern = settings.getModelRole(role)?.trim();
		if (!pattern) continue;
		const api = inferModelApi(pattern, allBundled);
		if (!api) continue; // unresolvable — no constraint can be derived
		if (api === "openai-codex-responses") {
			return { supported: false };
		}
		const b = getTemperatureBounds(api);
		// applicable:false means unknown/extension API — skip it, no constraint can be derived
		if (!b.applicable) continue;
		// Intersect: take the tightest (narrowest) window across all resolved models
		if (b.max < combinedMax || b.min > combinedMin) {
			combinedMin = Math.max(combinedMin, b.min);
			combinedMax = Math.min(combinedMax, b.max);
			if (!constrainingApis.includes(api)) constrainingApis.push(api);
		}
	}

	return { supported: true, bounds: { min: combinedMin, max: combinedMax }, apis: constrainingApis };
}

function parseAndSetValue(path: SettingPath, rawValue: string): void {
	const schemaType = getType(path);
	let parsedValue: unknown;

	const trimmed = rawValue.trim();
	switch (schemaType) {
		case "boolean": {
			const lower = trimmed.toLowerCase();
			if (["true", "1", "yes", "on"].includes(lower)) parsedValue = true;
			else if (["false", "0", "no", "off"].includes(lower)) parsedValue = false;
			else throw new Error(`Invalid boolean value: ${rawValue}. Use true/false, yes/no, on/off, or 1/0`);
			break;
		}
		case "number": {
			parsedValue = Number(trimmed);
			if (!Number.isFinite(parsedValue as number)) throw new Error(`Invalid number: ${rawValue}`);
			if (path === "temperature") {
				const temp = parsedValue as number;
				// -1 is the universal sentinel meaning "use provider default"
				if (temp !== -1) {
					const constraint = resolveTemperatureConstraint();
					if (!constraint.supported) {
						throw new Error(
							`One or more configured models use an API that does not support temperature adjustment. Use -1 to let the provider control sampling.`,
						);
					}
					const { bounds, apis } = constraint;
					if (temp < bounds.min || temp > bounds.max) {
						const providerLabel = apis.length > 0 ? ` for ${apis.join(", ")}` : "";
						throw new Error(
							`Temperature ${temp} is out of range${providerLabel}. Valid range: ${bounds.min}\u2013${bounds.max} (or -1 for provider default).`,
						);
					}
				}
			}
			break;
		}
		case "enum": {
			const valid = getEnumValues(path);
			if (valid && !valid.includes(trimmed)) {
				throw new Error(`Invalid value: ${rawValue}. Valid values: ${valid.join(", ")}`);
			}
			parsedValue = trimmed;
			break;
		}
		case "array": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		case "record": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		default:
			parsedValue = trimmed;
	}

	settings.set(path, parsedValue as SettingValue<typeof path>);
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	await Settings.init();

	switch (cmd.action) {
		case "list":
			handleList(cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
	}
}

function handleList(flags: { json?: boolean }): void {
	const defs = ALL_SETTING_PATHS.map(path => findSettingDef(path)).filter((def): def is CliSettingDef => !!def);

	if (flags.json) {
		const result: Record<string, { value: unknown; type: string; description: string }> = {};
		for (const def of defs) {
			result[def.path] = {
				value: settings.get(def.path),
				type: def.type,
				description: def.description,
			};
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			const value = settings.get(def.path);
			const valueStr = formatValue(value);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const value = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value, type: def.type, description: def.description }, null, 2));
		return;
	}

	console.log(formatValue(value));
}

async function handleSet(key: string | undefined, value: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	try {
		parseAndSetValue(def.path, value);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	const newValue = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: newValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.path} = ${formatValue(newValue)}`));
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const path = def.path as SettingPath;
	const defaultValue = getDefault(path);
	settings.set(path, defaultValue as SettingValue<typeof path>);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: defaultValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Reset ${def.path} to ${formatValue(defaultValue)}`));
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}

// =============================================================================
// Help
// =============================================================================

export function printConfigHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} config`)} - Manage settings

${chalk.bold("Commands:")}
  list               List all settings with current values
  get <key>          Get a specific setting value
  set <key> <value>  Set a setting value
  reset <key>        Reset a setting to its default value
  path               Print the config directory path
  init-xdg           Initialize XDG Base Directory structure

${chalk.bold("Options:")}
  --json             Output as JSON

${chalk.bold("Examples:")}
  ${APP_NAME} config list
  ${APP_NAME} config get theme
  ${APP_NAME} config set theme catppuccin-mocha
  ${APP_NAME} config set compaction.enabled false
  ${APP_NAME} config set defaultThinkingLevel medium
  ${APP_NAME} config reset steeringMode
  ${APP_NAME} config list --json
  ${APP_NAME} config init-xdg

${chalk.bold("Boolean Values:")}
  true, false, yes, no, on, off, 1, 0
`);
}

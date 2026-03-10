/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";

const REPO = "can1357/oh-my-pi";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
export const FORK_REPO_ROOT = "/home/colin/devpod-repos/DefaceRoot/oh-my-pi";
export const PATH_PRECEDENCE_CHECK_COMMAND = "command -v omp && bun pm bin -g";
export const FORK_REINSTALL_COMMAND = `bun --cwd=${FORK_REPO_ROOT} install`;
export const FORK_DIRECT_ENTRY = `${FORK_REPO_ROOT}/packages/coding-agent/src/cli.ts`;

interface ReleaseInfo {
	tag: string;
	version: string;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!Bun.which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

type UpdateTarget = { method: "bun" } | { method: "binary"; path: string };

function resolveUpdateMethod(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	if (!bunBinDir) return "binary";
	return isPathInDirectory(ompPath, bunBinDir) ? "bun" : "binary";
}

export function _resolveUpdateMethodForTest(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	return resolveUpdateMethod(ompPath, bunBinDir);
}

function buildForkReinstallGuidance(): string {
	return `Refresh dependencies with: ${FORK_REINSTALL_COMMAND}\nThen verify PATH precedence with: ${PATH_PRECEDENCE_CHECK_COMMAND}`;
}

export function _buildForkReinstallGuidanceForTest(): string {
	return buildForkReinstallGuidance();
}
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const ompPath = resolveOmpPath();

	if (ompPath) {
		const method = resolveUpdateMethod(ompPath, bunBinDir);
		if (method === "bun") return { method };
		return { method, path: ompPath };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Get the latest release info from the npm registry.
 * Uses npm instead of GitHub API to avoid unauthenticated rate limiting.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;

	return {
		tag,
		version,
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `omp` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return Bun.which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(
	expectedVersion: string,
	expectedMethod: "bun" | "binary",
): Promise<{ ok: boolean; actual?: string; path?: string; pathMismatch?: boolean }> {
	const ompPath = resolveOmpPath();
	const pathMismatch =
		expectedMethod === "bun" && (!ompPath || resolveUpdateMethod(ompPath, await getBunGlobalBinDir()) !== "bun");

	if (!ompPath) return { ok: false, pathMismatch };

	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath, pathMismatch };
		const output = result.text().trim();
		// Output format: "omp/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion && !pathMismatch, actual, path: ompPath, pathMismatch };
	} catch {
		return { ok: false, path: ompPath, pathMismatch };
	}
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string, expectedMethod: "bun" | "binary"): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion, expectedMethod);
	if (result.ok) {
		console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
		return;
	}

	if (result.actual) {
		const warning =
			expectedMethod === "bun" && result.pathMismatch
				? `\nWarning: ${APP_NAME} at ${result.path} is outside Bun global bin and still reports ${result.actual} (expected ${expectedVersion})`
				: `\nWarning: ${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
		console.log(chalk.yellow(warning));
	} else {
		console.log(
			chalk.yellow(`\nWarning: could not verify updated version${result.path ? ` at ${result.path}` : ""}`),
		);
	}

	console.log(chalk.yellow(`\n${buildForkReinstallGuidance()}`));
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	const result = await $`bun install`.cwd(FORK_REPO_ROOT).nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`bun install failed with exit code ${result.exitCode}`);
	}

	await printVerification(VERSION, "bun");
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);

	console.log(chalk.dim("Installing update..."));
	try {
		try {
			await fs.promises.unlink(backupPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(targetPath, backupPath);
		await fs.promises.rename(tempPath, targetPath);
		await fs.promises.unlink(backupPath);

		await printVerification(expectedVersion, "binary");
		console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
	} catch (err) {
		if (fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
			await fs.promises.rename(backupPath, targetPath);
		}
		if (fs.existsSync(tempPath)) {
			await fs.promises.unlink(tempPath);
		}
		throw err;
	}
}

interface UpdateCommandDeps {
	resolveUpdateTarget(): Promise<UpdateTarget>;
	getLatestRelease(): Promise<ReleaseInfo>;
	updateViaBun(): Promise<void>;
	updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void>;
	log(message: string): void;
	error(message: string): void;
	exit(code: number): never;
}

const defaultUpdateCommandDeps: UpdateCommandDeps = {
	resolveUpdateTarget,
	getLatestRelease,
	updateViaBun,
	updateViaBinaryAt,
	log: message => console.log(message),
	error: message => console.error(message),
	exit: code => process.exit(code),
};

async function runUpdateCommandWithDeps(
	opts: { force: boolean; check: boolean },
	deps: UpdateCommandDeps,
): Promise<void> {
	deps.log(chalk.dim(`Current version: ${VERSION}`));

	let target: UpdateTarget;
	try {
		target = await deps.resolveUpdateTarget();
	} catch (err) {
		deps.error(chalk.red(`Update failed: ${err}`));
		deps.exit(1);
	}

	if (target.method === "bun") {
		if (opts.check) {
			deps.log(chalk.cyan(`Fork-managed Bun install detected.\n${buildForkReinstallGuidance()}`));
			return;
		}

		deps.log(chalk.cyan(`Reinstalling fork-managed Bun install from ${FORK_REPO_ROOT}`));
		try {
			await deps.updateViaBun();
			return;
		} catch (err) {
			deps.error(chalk.red(`Update failed: ${err}`));
			deps.exit(1);
		}
	}

	let release: ReleaseInfo;
	try {
		release = await deps.getLatestRelease();
	} catch (err) {
		deps.error(chalk.red(`Failed to check for updates: ${err}`));
		deps.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		deps.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		deps.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		deps.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		return;
	}

	try {
		await deps.updateViaBinaryAt(target.path, release.version);
	} catch (err) {
		deps.error(chalk.red(`Update failed: ${err}`));
		deps.exit(1);
	}
}

export async function _runUpdateCommandForTest(
	opts: { force: boolean; check: boolean },
	overrides: Partial<UpdateCommandDeps>,
): Promise<void> {
	return runUpdateCommandWithDeps(opts, { ...defaultUpdateCommandDeps, ...overrides });
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	await runUpdateCommandWithDeps(opts, defaultUpdateCommandDeps);
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update installation
  ${APP_NAME} update --check   Check binary updates or print fork reinstall guidance
  ${APP_NAME} update --force   Force reinstall
`);
}

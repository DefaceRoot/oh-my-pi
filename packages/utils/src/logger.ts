/**
 * Centralized file logger for omp.
 *
 * Logs to ~/.omp/logs/ with size-based rotation, supporting concurrent omp instances.
 * Each log entry includes process.pid for traceability.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RingBuffer } from "@oh-my-pi/pi-utils/ring";
import { getLogPath } from "./dirs";
import { isEacces, isEnoent, isEnotdir } from "./fs-error";

/** Maximum size of a single daily log file before rolling to numbered suffixes. */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/** Number of rotated log files to retain per day. */
const MAX_LOG_FILES = 5;

/** Track whether the logger should stop attempting file writes. */
let fileLoggingDisabled = false;

/** Custom format that includes pid and flattens metadata. */
function formatEntry(level: string, message: string, context?: Record<string, unknown>): string {
	const entry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		pid: process.pid,
		message,
	};
	if (context) {
		for (const [key, value] of Object.entries(context)) {
			entry[key] = value;
		}
	}
	try {
		return JSON.stringify(entry);
	} catch {
		return JSON.stringify({
			timestamp: entry.timestamp,
			level,
			pid: process.pid,
			message: String(message),
			serializationError: "Failed to serialize log context",
		});
	}
}

function toRotatedPath(logPath: string, index: number): string {
	const ext = path.extname(logPath);
	const base = ext.length > 0 ? logPath.slice(0, -ext.length) : logPath;
	return `${base}.${index}${ext}`;
}

function rotateLogFiles(logPath: string): void {
	for (let index = MAX_LOG_FILES - 1; index >= 1; index--) {
		const source = index === 1 ? logPath : toRotatedPath(logPath, index - 1);
		const target = toRotatedPath(logPath, index);
		try {
			if (fs.existsSync(source)) {
				fs.renameSync(source, target);
			}
		} catch {
			// Best effort only. Rotation must never break logging.
		}
	}
}

function ensureParentDir(logPath: string): void {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
}

function getLogSize(logPath: string): number {
	try {
		return fs.statSync(logPath).size;
	} catch {
		return 0;
	}
}

function writeEntry(level: string, message: string, context?: Record<string, unknown>): void {
	if (fileLoggingDisabled) return;

	const logPath = getLogPath();

	try {
		ensureParentDir(logPath);

		if (getLogSize(logPath) >= MAX_LOG_SIZE_BYTES) {
			rotateLogFiles(logPath);
		}

		fs.appendFileSync(logPath, `${formatEntry(level, message, context)}\n`, { encoding: "utf8" });
	} catch (error) {
		if (isEacces(error) || isEnoent(error) || isEnotdir(error)) {
			fileLoggingDisabled = true;
			return;
		}

		// Any other filesystem failure is also non-fatal; stop retrying to avoid noisy crashes.
		fileLoggingDisabled = true;
	}
}

/**
 * The logger interface used throughout the repo.
 */
export interface Logger {
	error(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
	time<T>(op: string, fn: () => T): T;
	timeAsync<T>(op: string, fn: () => PromiseLike<T>): Promise<T>;
}

/**
 * Log an error message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function error(message: string, context?: Record<string, unknown>): void {
	writeEntry("error", message, context);
}

/**
 * Log a warning message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function warn(message: string, context?: Record<string, unknown>): void {
	writeEntry("warn", message, context);
}

/**
 * Log a debug message.
 * @param message - The message to log.
 * @param context - The context to log.
 */
export function debug(message: string, context?: Record<string, unknown>): void {
	writeEntry("debug", message, context);
}

const LOGGED_TIMING_THRESHOLD_MS = 5;

const longOpBuffer = new RingBuffer<[op: string, duration: number]>(1000);
let longOpRecord = false;

function logTiming(op: string, duration: number): void {
	duration = Math.round(duration * 100) / 100;
	if (duration > LOGGED_TIMING_THRESHOLD_MS) {
		warn(`${op} done`, { duration, op });
		if (longOpRecord) {
			longOpBuffer.push([op, duration]);
		}
	} else {
		debug(`${op} done`, { duration, op });
	}
}

/**
 * Print all collected long operation timings to stderr.
 * To be called at the end of a startup or timing window.
 */
export function printTimings(): void {
	// Use stderr for timings output, do not use logger (see AGENTS.md).
	console.error("\n--- Startup Timings ---");
	let totalDuration = 0;
	for (const [op, duration] of longOpBuffer) {
		console.error(`  ${op}: ${duration}ms`);
		totalDuration += duration;
	}
	console.error(`  TOTAL: ${totalDuration}ms`);
	console.error("------------------------\n");
}

/**
 * Begin recording long operation timings.
 * Typically called at the beginning of startup.
 */
export function startTiming(): void {
	longOpBuffer.clear();
	longOpRecord = true;
}

/**
 * End timing window and print all timings.
 * Disables further buffering until next startTiming().
 */
export function endTiming(): void {
	longOpBuffer.clear();
	longOpRecord = false;
}

/**
 * Time a synchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T {
	const start = performance.now();
	try {
		return fn(...args);
	} finally {
		logTiming(op, performance.now() - start);
	}
}

/**
 * Time an asynchronous operation and log the duration.
 * @param op - The operation name.
 * @param fn - The function to time.
 * @returns The result of the function.
 */
export async function timeAsync<R, A extends unknown[]>(
	op: string,
	fn: (...args: A) => R,
	...args: A
): Promise<Awaited<R>> {
	const start = performance.now();
	try {
		return await fn(...args);
	} finally {
		logTiming(op, performance.now() - start);
	}
}

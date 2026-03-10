import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Maximum number of fs.watch handles to open simultaneously.
 * Prevents resource exhaustion on sessions with deep artifact trees.
 */
export const MAX_WATCH_DIRS = 32;

/**
 * Debounce window (ms) for coalescing rapid filesystem events into a single
 * invalidation callback.
 */
export const DEBOUNCE_MS = 150;

export type WatchManagerState = "idle" | "watching" | "degraded" | "disposed";

/** Minimal interface for a closeable watcher. */
export interface Closeable {
	close(): void;
}

/**
 * Factory function type for creating filesystem watchers.
 * Returns a Closeable on success, or undefined on failure.
 * The factory must call `onChange` when a filesystem event is detected.
 */
export type WatchFactory = (dirPath: string, onChange: () => void) => Closeable | undefined;

/**
 * Factory function type for listing subdirectories.
 * Returns absolute paths of immediate child directories under `dirPath`.
 */
export type ListSubdirsFactory = (dirPath: string) => Promise<string[]>;

export interface SubagentArtifactsWatchManagerOptions {
	/**
	 * Absolute path to the artifacts directory to watch.
	 */
	artifactsDir: string;

	/**
	 * Called (at most once per debounce window) when filesystem changes are detected.
	 * The manager does NOT reconcile itself — the caller is responsible for triggering
	 * SubagentIndex.reconcile() or equivalent.
	 */
	onInvalidate: () => void;

	/**
	 * Override for debounce interval (ms). Defaults to DEBOUNCE_MS.
	 */
	debounceMs?: number;

	/**
	 * Override for max watch dir cap. Defaults to MAX_WATCH_DIRS.
	 */
	maxWatchDirs?: number;

	/**
	 * Override for how fs watchers are created. Defaults to Node's fs.watch.
	 * Injecting this enables deterministic unit testing without real inotify handles.
	 */
	watchFactory?: WatchFactory;

	/**
	 * Override for how subdirectories are listed. Defaults to fs.readdir.
	 * Injecting this enables deterministic unit testing.
	 */
	listSubdirs?: ListSubdirsFactory;
}

/** Default watch factory using Node's fs.watch. */
function defaultWatchFactory(dirPath: string, onChange: () => void): Closeable | undefined {
	try {
		const watcher = fs.watch(dirPath, { persistent: false }, () => {
			onChange();
		});

		watcher.on("error", (err: Error) => {
			logger.warn("Filesystem watcher error", {
				path: dirPath,
				error: String(err),
			});
		});

		return watcher;
	} catch (error: unknown) {
		logger.warn("Failed to register filesystem watcher", {
			path: dirPath,
			error: String(error),
		});
		return undefined;
	}
}

/** Default subdirectory lister using fs.readdir. */
async function defaultListSubdirs(dirPath: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(dirPath, entry.name))
		.sort();
}

/**
 * Watches the subagent artifacts directory tree for filesystem changes and
 * notifies the caller via a debounced invalidation callback.
 *
 * Lifecycle:
 *   1. Call `start()` to begin watching. Watches the root, then discovers
 *      immediate subdirectories and watches them up to the cap.
 *   2. Filesystem events are coalesced via a debounce timer. Each debounce
 *      window fires at most one `onInvalidate` call.
 *   3. Call `dispose()` to close all watchers and release resources.
 *
 * Degraded mode:
 *   Entered when any watch registration fails (e.g. EMFILE, ENOSPC) or when
 *   the number of discovered directories exceeds the cap. In degraded mode,
 *   no watchers are active and the caller must use manual refresh (Ctrl+X R).
 *   The `state` and `degradedReason` properties are observable for later
 *   UI hint wiring.
 */
export class SubagentArtifactsWatchManager {
	readonly #artifactsDir: string;
	readonly #onInvalidate: () => void;
	readonly #debounceMs: number;
	readonly #maxWatchDirs: number;
	readonly #watchFactory: WatchFactory;
	readonly #listSubdirs: ListSubdirsFactory;

	#state: WatchManagerState = "idle";
	#watchers: Closeable[] = [];
	#debounceTimer: ReturnType<typeof setTimeout> | undefined;
	#degradedReason: string | undefined;

	constructor(options: SubagentArtifactsWatchManagerOptions) {
		this.#artifactsDir = options.artifactsDir;
		this.#onInvalidate = options.onInvalidate;
		this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
		this.#maxWatchDirs = options.maxWatchDirs ?? MAX_WATCH_DIRS;
		this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
		this.#listSubdirs = options.listSubdirs ?? defaultListSubdirs;
	}

	/** Current lifecycle state. */
	get state(): WatchManagerState {
		return this.#state;
	}

	/** Human-readable reason when in degraded mode; undefined otherwise. */
	get degradedReason(): string | undefined {
		return this.#degradedReason;
	}

	/** Number of active watch handles. */
	get watcherCount(): number {
		return this.#watchers.length;
	}

	/**
	 * Begin watching. Discovers the root and its immediate subdirectories.
	 * Idempotent: calling start() on an already-started or disposed manager is a no-op.
	 */
	async start(): Promise<void> {
		if (this.#state !== "idle") {
			return;
		}

		// Watch root directory
		const rootWatcher = this.#watchFactory(this.#artifactsDir, () => this.#scheduleInvalidation());
		if (!rootWatcher) {
			this.#enterDegraded(`Failed to watch root directory: ${this.#artifactsDir}`);
			return;
		}

		this.#watchers.push(rootWatcher);
		this.#state = "watching";

		// Discover and watch immediate subdirectories
		await this.#discoverSubdirs();
	}

	/**
	 * Close all watchers and cancel pending debounce timers.
	 * After dispose(), the manager cannot be restarted.
	 */
	dispose(): void {
		if (this.#state === "disposed") {
			return;
		}

		this.#clearDebounce();
		this.#closeAllWatchers();
		this.#state = "disposed";
	}

	async #discoverSubdirs(): Promise<void> {
		if (this.#state !== "watching") {
			return;
		}

		const subdirs = await this.#listSubdirs(this.#artifactsDir);

		for (const subdir of subdirs) {
			if (this.#state !== "watching") {
				return;
			}

			if (this.#watchers.length >= this.#maxWatchDirs) {
				this.#enterDegraded(
					`Watch directory cap exceeded (${this.#maxWatchDirs}). ` +
						`${subdirs.length} subdirectories found but only ${this.#maxWatchDirs} watchers allowed.`,
				);
				return;
			}

			const watcher = this.#watchFactory(subdir, () => this.#scheduleInvalidation());
			if (!watcher) {
				this.#enterDegraded(`Failed to watch subdirectory: ${subdir}`);
				return;
			}

			this.#watchers.push(watcher);
		}
	}

	#scheduleInvalidation(): void {
		if (this.#state === "disposed") {
			return;
		}

		if (this.#debounceTimer !== undefined) {
			return;
		}

		this.#debounceTimer = setTimeout(() => {
			this.#debounceTimer = undefined;
			if (this.#state !== "disposed") {
				this.#onInvalidate();
			}
		}, this.#debounceMs);
	}

	#enterDegraded(reason: string): void {
		logger.warn("Subagent watch manager entering degraded mode", { reason });
		this.#closeAllWatchers();
		this.#clearDebounce();
		this.#state = "degraded";
		this.#degradedReason = reason;
	}

	#closeAllWatchers(): void {
		for (const watcher of this.#watchers) {
			try {
				watcher.close();
			} catch {
				// Best-effort cleanup
			}
		}
		this.#watchers = [];
	}

	#clearDebounce(): void {
		if (this.#debounceTimer !== undefined) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = undefined;
		}
	}
}

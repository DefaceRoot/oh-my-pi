import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type Closeable,
	DEBOUNCE_MS,
	type ListSubdirsFactory,
	MAX_WATCH_DIRS,
	SubagentArtifactsWatchManager,
	type WatchFactory,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-watch";

// ─── Test doubles ───────────────────────────────────────────────────────

/**
 * Fake watcher that records lifecycle and allows manual event triggering.
 */
class FakeWatcher implements Closeable {
	closed = false;
	readonly dirPath: string;
	readonly onChange: () => void;

	constructor(dirPath: string, onChange: () => void) {
		this.dirPath = dirPath;
		this.onChange = onChange;
	}

	close(): void {
		this.closed = true;
	}

	/** Simulate a filesystem event. */
	fire(): void {
		if (!this.closed) {
			this.onChange();
		}
	}
}

/**
 * Builds a watch factory that collects all created watchers and optionally
 * fails for specific paths.
 */
function createTestWatchFactory(options?: { failPaths?: Set<string> }): {
	factory: WatchFactory;
	watchers: FakeWatcher[];
} {
	const watchers: FakeWatcher[] = [];
	const failPaths = options?.failPaths ?? new Set();

	const factory: WatchFactory = (dirPath, onChange) => {
		if (failPaths.has(dirPath)) {
			return undefined;
		}
		const watcher = new FakeWatcher(dirPath, onChange);
		watchers.push(watcher);
		return watcher;
	};

	return { factory, watchers };
}

/**
 * Builds a listSubdirs function that returns canned results.
 */
function createTestListSubdirs(subdirs: string[]): ListSubdirsFactory {
	return async () => subdirs;
}

/** Helper: sleep for a given duration using real timers. */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("SubagentArtifactsWatchManager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ─── Lifecycle basics ───────────────────────────────────────────

	test("starts in idle state", () => {
		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		expect(manager.state).toBe("idle");
		expect(manager.watcherCount).toBe(0);
		expect(manager.degradedReason).toBeUndefined();
		manager.dispose();
	});

	test("transitions to watching after start()", async () => {
		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();

		expect(manager.state).toBe("watching");
		expect(manager.watcherCount).toBe(1); // root only
		manager.dispose();
	});

	test("transitions to disposed after dispose()", async () => {
		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();
		manager.dispose();

		expect(manager.state).toBe("disposed");
		expect(manager.watcherCount).toBe(0);
	});

	test("start() is idempotent — second call is no-op", async () => {
		const { factory, watchers } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();
		expect(watchers.length).toBe(1);

		await manager.start();
		expect(watchers.length).toBe(1); // no new watcher created
		expect(manager.state).toBe("watching");
		manager.dispose();
	});

	test("dispose() is idempotent", async () => {
		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();
		manager.dispose();
		manager.dispose(); // second call is no-op
		expect(manager.state).toBe("disposed");
	});

	test("start() on disposed manager is no-op", async () => {
		const { factory, watchers } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		manager.dispose();
		await manager.start();

		expect(manager.state).toBe("disposed");
		expect(watchers.length).toBe(0);
	});

	test("dispose() closes all watchers", async () => {
		const { factory, watchers } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(["/fake/artifacts/sub-a", "/fake/artifacts/sub-b"]),
		});

		await manager.start();
		expect(watchers.length).toBe(3);
		expect(watchers.every(w => !w.closed)).toBe(true);

		manager.dispose();
		expect(watchers.every(w => w.closed)).toBe(true);
	});

	// ─── Subdir discovery ───────────────────────────────────────────

	test("discovers and watches immediate subdirectories", async () => {
		const { factory, watchers } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(["/fake/artifacts/agent-a", "/fake/artifacts/agent-b"]),
		});

		await manager.start();

		// root + 2 subdirs = 3 watchers
		expect(manager.watcherCount).toBe(3);
		expect(manager.state).toBe("watching");
		expect(watchers.map(w => w.dirPath)).toEqual([
			"/fake/artifacts",
			"/fake/artifacts/agent-a",
			"/fake/artifacts/agent-b",
		]);
		manager.dispose();
	});

	test("handles empty subdirectory list (root only)", async () => {
		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();

		expect(manager.watcherCount).toBe(1);
		expect(manager.state).toBe("watching");
		manager.dispose();
	});

	// ─── Normal debounced invalidation ──────────────────────────────

	test("fires onInvalidate after debounce when a watcher event occurs", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 30,
		});

		await manager.start();

		// Simulate a filesystem event
		watchers[0].fire();

		// Should not fire immediately
		expect(invalidateCount).toBe(0);

		// Wait for debounce to elapse
		await sleep(60);

		expect(invalidateCount).toBe(1);
		manager.dispose();
	});

	test("debounce coalesces rapid events into a single invalidation", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 50,
		});

		await manager.start();

		// Fire multiple rapid events
		watchers[0].fire();
		watchers[0].fire();
		watchers[0].fire();
		watchers[0].fire();
		watchers[0].fire();

		// Still pending
		expect(invalidateCount).toBe(0);

		// Wait past debounce
		await sleep(80);

		// Exactly one invalidation
		expect(invalidateCount).toBe(1);
		manager.dispose();
	});

	test("fires a second invalidation after the first debounce completes", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 30,
		});

		await manager.start();

		// First event → first debounce cycle
		watchers[0].fire();
		await sleep(60);
		expect(invalidateCount).toBe(1);

		// Second event → second debounce cycle
		watchers[0].fire();
		await sleep(60);
		expect(invalidateCount).toBe(2);

		manager.dispose();
	});

	test("does not fire onInvalidate after dispose()", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 30,
		});

		await manager.start();
		manager.dispose();

		// Fire on closed watcher (simulates a race)
		watchers[0].fire();
		await sleep(60);

		expect(invalidateCount).toBe(0);
	});

	test("cancels pending debounce timer on dispose()", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 200,
		});

		await manager.start();

		// Start a debounce cycle
		watchers[0].fire();
		await sleep(10); // Let event arrive but before debounce fires

		// Dispose while debounce is pending
		manager.dispose();

		// Wait past the debounce window
		await sleep(300);

		expect(invalidateCount).toBe(0);
	});

	test("subdir watcher events also trigger invalidation", async () => {
		const { factory, watchers } = createTestWatchFactory();
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(["/fake/artifacts/deep-agent"]),
			debounceMs: 30,
		});

		await manager.start();
		expect(watchers.length).toBe(2);

		// Fire event on the subdirectory watcher
		watchers[1].fire();
		await sleep(60);

		expect(invalidateCount).toBe(1);
		manager.dispose();
	});

	// ─── Degraded mode: registration failure ────────────────────────

	test("enters degraded mode when root watch fails", async () => {
		const failPaths = new Set(["/fake/artifacts"]);
		const { factory } = createTestWatchFactory({ failPaths });
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();

		expect(manager.state).toBe("degraded");
		expect(manager.degradedReason).toContain("Failed to watch root");
		expect(manager.watcherCount).toBe(0);
		manager.dispose();
	});

	test("enters degraded mode when subdirectory watch fails", async () => {
		const failPaths = new Set(["/fake/artifacts/bad-subdir"]);
		const { factory, watchers } = createTestWatchFactory({ failPaths });
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(["/fake/artifacts/good-subdir", "/fake/artifacts/bad-subdir"]),
		});

		await manager.start();

		expect(manager.state).toBe("degraded");
		expect(manager.degradedReason).toContain("Failed to watch subdirectory");
		expect(manager.degradedReason).toContain("bad-subdir");
		expect(manager.watcherCount).toBe(0); // All closed on degrade

		// Verify previously-opened watchers were cleaned up
		expect(watchers.every(w => w.closed)).toBe(true);
		manager.dispose();
	});

	test("degraded mode state and reason are observable for UI hint wiring", async () => {
		const failPaths = new Set(["/fake/artifacts"]);
		const { factory } = createTestWatchFactory({ failPaths });
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
		});

		await manager.start();

		// State properties must be observable for later mode wiring
		expect(manager.state).toBe("degraded");
		expect(typeof manager.degradedReason).toBe("string");
		expect(manager.degradedReason!.length).toBeGreaterThan(0);
		manager.dispose();
	});

	// ─── Degraded mode: cap overflow ────────────────────────────────

	test("enters degraded mode when subdir count exceeds maxWatchDirs cap", async () => {
		const cap = 3;
		// 4 subdirs + root = would need 5 watchers, exceeding cap of 3
		const subdirs = [
			"/fake/artifacts/sub-000",
			"/fake/artifacts/sub-001",
			"/fake/artifacts/sub-002",
			"/fake/artifacts/sub-003",
		];

		const { factory, watchers } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(subdirs),
			maxWatchDirs: cap,
		});

		await manager.start();

		expect(manager.state).toBe("degraded");
		expect(manager.degradedReason).toContain("cap exceeded");
		expect(manager.degradedReason).toContain(String(cap));
		expect(manager.watcherCount).toBe(0); // All closed on degrade
		expect(watchers.every(w => w.closed)).toBe(true);
		manager.dispose();
	});

	test("stays watching when subdir count fits within maxWatchDirs cap", async () => {
		const cap = 5;
		// 4 subdirs + root = 5 watchers, exactly at cap
		const subdirs = [
			"/fake/artifacts/sub-0",
			"/fake/artifacts/sub-1",
			"/fake/artifacts/sub-2",
			"/fake/artifacts/sub-3",
		];

		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(subdirs),
			maxWatchDirs: cap,
		});

		await manager.start();

		expect(manager.state).toBe("watching");
		expect(manager.watcherCount).toBe(cap); // root + 4 subdirs = 5
		expect(manager.degradedReason).toBeUndefined();
		manager.dispose();
	});

	test("degrades at cap boundary (root + subdirs > maxWatchDirs)", async () => {
		const cap = 3;
		// root uses 1 slot, 3 subdirs would need 4 total — one past cap
		const subdirs = ["/fake/artifacts/a", "/fake/artifacts/b", "/fake/artifacts/c"];

		const { factory } = createTestWatchFactory();
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs(subdirs),
			maxWatchDirs: cap,
		});

		await manager.start();

		expect(manager.state).toBe("degraded");
		expect(manager.degradedReason).toContain("cap exceeded");
		manager.dispose();
	});

	// ─── No invalidation in degraded mode ───────────────────────────

	test("does not fire onInvalidate in degraded mode", async () => {
		const failPaths = new Set(["/fake/artifacts"]);
		const { factory } = createTestWatchFactory({ failPaths });
		let invalidateCount = 0;
		const manager = new SubagentArtifactsWatchManager({
			artifactsDir: "/fake/artifacts",
			onInvalidate: () => {
				invalidateCount++;
			},
			watchFactory: factory,
			listSubdirs: createTestListSubdirs([]),
			debounceMs: 10,
		});

		await manager.start();
		expect(manager.state).toBe("degraded");

		await sleep(50);

		expect(invalidateCount).toBe(0);
		manager.dispose();
	});

	// ─── Default constants ──────────────────────────────────────────

	test("exports expected default constants", () => {
		expect(MAX_WATCH_DIRS).toBe(32);
		expect(DEBOUNCE_MS).toBe(150);
	});
});

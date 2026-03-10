import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SubagentIndex } from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-index";
import {
	type Closeable,
	SubagentArtifactsWatchManager,
	type WatchFactory,
} from "@oh-my-pi/pi-coding-agent/modes/subagent-view/subagent-watch";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// ─── Helpers ─────────────────────────────────────────────────────────────

beforeAll(async () => {
	await initTheme(false);
});

/** Wait at least `ms` milliseconds. */
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let tmpDirCounter = 0;
let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	tmpDirCounter += 1;
	const dir = path.join(process.env.TMPDIR ?? "/tmp", `subagent-watch-int-${Date.now()}-${tmpDirCounter}`);
	await fs.mkdir(dir, { recursive: true });
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tmpDirs) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	tmpDirs = [];
});

/** Write a minimal JSONL transcript file. */
async function writeTranscript(dir: string, id: string): Promise<string> {
	const filePath = path.join(dir, `${id}.jsonl`);
	await fs.writeFile(filePath, `{"type":"session_init","task":"mock ${id}"}\n`);
	return filePath;
}

// ─── Fake watcher that allows deterministic event triggering ─────────────

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

	fire(): void {
		if (!this.closed) {
			this.onChange();
		}
	}
}

function createFakeWatchFactory(): {
	factory: WatchFactory;
	watchers: FakeWatcher[];
} {
	const watchers: FakeWatcher[] = [];
	const factory: WatchFactory = (dirPath, onChange) => {
		const watcher = new FakeWatcher(dirPath, onChange);
		watchers.push(watcher);
		return watcher;
	};
	return { factory, watchers };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("SubagentArtifactsWatchManager + SubagentIndex integration", () => {
	test("watch event schedules debounced reconcile that updates snapshot version", async () => {
		const artifactsDir = await makeTmpDir();

		// Seed initial transcript
		await writeTranscript(artifactsDir, "0-Explore");

		const index = new SubagentIndex({ artifactsDir });

		// Bootstrap: reconcile to populate initial snapshot
		const initialSnapshot = await index.reconcile();
		expect(initialSnapshot.refs.length).toBe(1);
		const initialVersion = initialSnapshot.version;

		// Set up watch manager with fake watchers
		const { factory, watchers } = createFakeWatchFactory();
		let invalidateCount = 0;

		const watchManager = new SubagentArtifactsWatchManager({
			artifactsDir,
			onInvalidate: () => {
				invalidateCount += 1;
				// In the real wiring, this triggers requestSubagentRefresh("watch")
				// which calls index.reconcile(). We'll do it directly.
				void index.reconcile();
			},
			debounceMs: 20, // Short for testing
			watchFactory: factory,
			listSubdirs: async () => [],
		});

		await watchManager.start();
		expect(watchManager.state).toBe("watching");
		expect(watchers.length).toBeGreaterThanOrEqual(1);

		// Write a new transcript file
		await writeTranscript(artifactsDir, "1-Research");

		// Simulate the filesystem event via the fake watcher
		watchers[0]!.fire();

		// Wait for the debounce window + a bit of settling
		await delay(50);

		// The invalidation should have fired at least once
		expect(invalidateCount).toBeGreaterThanOrEqual(1);

		// Snapshot should be updated with the new transcript
		const updatedSnapshot = index.getSnapshot();
		expect(updatedSnapshot.refs.length).toBe(2);
		expect(updatedSnapshot.version).toBeGreaterThan(initialVersion);

		// Confirm both refs are present
		const refIds = updatedSnapshot.refs.map(r => r.id).sort();
		expect(refIds).toEqual(["0-Explore", "1-Research"]);

		watchManager.dispose();
	});

	test("rapid events within debounce window coalesce into single invalidation", async () => {
		const artifactsDir = await makeTmpDir();
		await writeTranscript(artifactsDir, "0-Explore");

		const index = new SubagentIndex({ artifactsDir });
		await index.reconcile();

		const { factory, watchers } = createFakeWatchFactory();
		let invalidateCount = 0;

		const watchManager = new SubagentArtifactsWatchManager({
			artifactsDir,
			onInvalidate: () => {
				invalidateCount += 1;
				void index.reconcile();
			},
			debounceMs: 50,
			watchFactory: factory,
			listSubdirs: async () => [],
		});

		await watchManager.start();

		// Fire multiple rapid events
		watchers[0]!.fire();
		watchers[0]!.fire();
		watchers[0]!.fire();

		// Wait for the debounce window to close
		await delay(100);

		// Only one invalidation should fire for the burst
		expect(invalidateCount).toBe(1);

		watchManager.dispose();
	});

	test("dispose stops future watch-driven updates", async () => {
		const artifactsDir = await makeTmpDir();
		await writeTranscript(artifactsDir, "0-Explore");

		const index = new SubagentIndex({ artifactsDir });
		await index.reconcile();
		const snapshotAfterBootstrap = index.getSnapshot();

		const { factory, watchers } = createFakeWatchFactory();
		let invalidateCount = 0;

		const watchManager = new SubagentArtifactsWatchManager({
			artifactsDir,
			onInvalidate: () => {
				invalidateCount += 1;
				void index.reconcile();
			},
			debounceMs: 20,
			watchFactory: factory,
			listSubdirs: async () => [],
		});

		await watchManager.start();
		expect(watchManager.state).toBe("watching");

		// Dispose the watch manager
		watchManager.dispose();
		expect(watchManager.state).toBe("disposed");

		// Confirm all watchers are closed
		for (const watcher of watchers) {
			expect(watcher.closed).toBe(true);
		}

		// Write a new file after dispose
		await writeTranscript(artifactsDir, "1-PostDispose");

		// Try to fire - should be no-op since closed
		watchers[0]!.fire();

		// Wait for any potential debounce
		await delay(60);

		// No invalidation should have fired
		expect(invalidateCount).toBe(0);

		// Snapshot should remain unchanged
		const snapshotAfterDispose = index.getSnapshot();
		expect(snapshotAfterDispose.version).toBe(snapshotAfterBootstrap.version);
		expect(snapshotAfterDispose.refs.length).toBe(1);
	});

	test("snapshot version increments on each reconcile with changes", async () => {
		const artifactsDir = await makeTmpDir();

		const index = new SubagentIndex({ artifactsDir });
		const empty = await index.reconcile();
		const v0 = empty.version;

		// Add first file
		await writeTranscript(artifactsDir, "alpha");
		const snap1 = await index.reconcile();
		expect(snap1.version).toBeGreaterThan(v0);
		expect(snap1.refs.length).toBe(1);

		// Add second file
		await writeTranscript(artifactsDir, "beta");
		const snap2 = await index.reconcile();
		expect(snap2.version).toBeGreaterThan(snap1.version);
		expect(snap2.refs.length).toBe(2);
	});

	test("watch manager enters watching state and discovers subdirectories", async () => {
		const artifactsDir = await makeTmpDir();
		const subDir = path.join(artifactsDir, "nested");
		await fs.mkdir(subDir, { recursive: true });
		await writeTranscript(subDir, "nested-agent");

		const { factory, watchers } = createFakeWatchFactory();
		let invalidateCount = 0;

		const watchManager = new SubagentArtifactsWatchManager({
			artifactsDir,
			onInvalidate: () => {
				invalidateCount += 1;
			},
			debounceMs: 20,
			watchFactory: factory,
			listSubdirs: async dir => {
				const entries = await fs.readdir(dir, { withFileTypes: true });
				return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
			},
		});

		await watchManager.start();
		expect(watchManager.state).toBe("watching");
		// Root + one subdirectory = 2 watchers
		expect(watchers.length).toBe(2);

		// Fire from the subdirectory watcher
		watchers[1]!.fire();
		await delay(40);
		expect(invalidateCount).toBe(1);

		watchManager.dispose();
	});
});

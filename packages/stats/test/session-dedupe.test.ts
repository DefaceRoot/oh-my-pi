import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import {
	closeDb,
	getBehaviorOverall,
	getMessageCount,
	getOverallStats,
	getRecentRequests,
	getStatsByModel,
	initDb,
	insertMessageStats,
	insertUserMessageStats,
} from "@oh-my-pi/omp-stats/db";
import type { MessageStats, UserMessageStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, getSessionsDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
const sessionFileName = "2026-05-15T15-53-03-785Z_019e2c57-5e2a-7000-8000-000000000001.jsonl";
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-dedupe-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function mirroredSessionFile(root: string): string {
	return path.join(root, "agent", "sessions", "-", sessionFileName);
}

function makeMessage(sessionFile: string): MessageStats {
	return {
		sessionFile,
		entryId: "assistant-entry",
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: 1_778_864_688_020,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			premiumRequests: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function makeUserMessage(sessionFile: string): UserMessageStats {
	return {
		sessionFile,
		entryId: "user-entry",
		folder: "/tmp/project",
		timestamp: 1_778_864_688_000,
		model: "gpt-5.4",
		provider: "openai-codex",
		chars: 42,
		words: 7,
		yelling: 1,
		profanity: 0,
		anguish: 1,
		negation: 0,
		repetition: 0,
		blame: 0,
	};
}

async function writeParsedSessionFile(): Promise<void> {
	const dir = path.join(getSessionsDir(), "-");
	await fs.mkdir(dir, { recursive: true });
	const assistantEntry = {
		type: "message",
		id: "assistant-entry",
		parentId: null,
		timestamp: new Date(1_778_864_688_020).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: 1_778_864_688_020,
			duration: 1000,
			ttft: 100,
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 200,
				cacheWrite: 0,
				totalTokens: 1700,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	const lines = [
		{ type: "session", version: 1, id: "session", timestamp: new Date(1_778_864_688_000).toISOString() },
		assistantEntry,
	];
	await Bun.write(path.join(dir, sessionFileName), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

async function createOldSchemaDb(): Promise<Database> {
	await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
	const database = new Database(getStatsDbPath());
	database.exec(`
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			UNIQUE(session_file, entry_id)
		);

		CREATE TABLE user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);

		CREATE TABLE meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		INSERT INTO meta (key, value) VALUES
			('user_messages_v6', 'pending'),
			('user_message_links_v1', 'pending'),
			('premium_requests_priority_v1', 'pending');
	`);
	return database;
}

function insertOldMessage(database: Database, sessionFile: string): void {
	database
		.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			sessionFile,
			"assistant-entry",
			"/tmp/project",
			"gpt-5.4",
			"openai-codex",
			"openai-codex-responses",
			1_778_864_688_020,
			1000,
			100,
			"stop",
			null,
			1000,
			500,
			200,
			0,
			1700,
			0,
			0,
			0,
			0,
			0,
			0,
		);
}

function insertOldUserMessage(database: Database, sessionFile: string): void {
	database
		.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish, negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			sessionFile,
			"user-entry",
			"/tmp/project",
			1_778_864_688_000,
			"gpt-5.4",
			"openai-codex",
			42,
			7,
			1,
			0,
			1,
			0,
			0,
			0,
		);
}

describe("stats mirrored session dedupe", () => {
	it("counts mirrored session files as one logical assistant request", async () => {
		await initDb();

		const primary = mirroredSessionFile("/tmp/primary-root");
		const mirror = mirroredSessionFile("/tmp/mirror-root");
		expect(insertMessageStats([makeMessage(primary)])).toBe(1);
		expect(insertMessageStats([makeMessage(mirror)])).toBe(0);

		const overall = getOverallStats(null);
		expect(getMessageCount()).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalInputTokens).toBe(1000);
		expect(getStatsByModel(null)[0]?.totalRequests).toBe(1);
		expect(getRecentRequests(10)).toHaveLength(1);
	});

	it("repairs existing full-path duplicates during database init", async () => {
		const database = await createOldSchemaDb();
		const primary = mirroredSessionFile("/tmp/primary-root");
		const mirror = mirroredSessionFile("/tmp/mirror-root");
		insertOldMessage(database, primary);
		insertOldMessage(database, mirror);
		insertOldUserMessage(database, primary);
		insertOldUserMessage(database, mirror);
		database.close();

		await initDb();

		expect(getMessageCount()).toBe(1);
		expect(getOverallStats(null).totalRequests).toBe(1);
		expect(getBehaviorOverall(null).totalMessages).toBe(1);
	});

	it("counts mirrored session files as one logical user message", async () => {
		await initDb();

		const primary = mirroredSessionFile("/tmp/primary-root");
		const mirror = mirroredSessionFile("/tmp/mirror-root");
		expect(insertUserMessageStats([makeUserMessage(primary)])).toBe(1);
		expect(insertUserMessageStats([makeUserMessage(mirror)])).toBe(0);

		expect(getBehaviorOverall(null).totalMessages).toBe(1);
	});

	it("does not count the same parsed session from two agent roots as fresh work", async () => {
		setAgentDir(tempDir?.join("primary-agent") ?? originalAgentDir);
		await writeParsedSessionFile();
		const first = await syncAllSessions({ workers: 1 });

		setAgentDir(tempDir?.join("mirror-agent") ?? originalAgentDir);
		await writeParsedSessionFile();
		const second = await syncAllSessions({ workers: 1 });

		expect(first).toEqual({ processed: 1, files: 1 });
		expect(second).toEqual({ processed: 0, files: 0 });
		expect(getOverallStats(null).totalRequests).toBe(1);
	});
});

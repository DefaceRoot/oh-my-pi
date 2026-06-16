import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	closeDb,
	getKnownSessionRoots,
	getRecentRequests,
	initDb,
	insertMessageStats,
	setFileOffset,
} from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-db-");
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

function createCodexGptStats(entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function createProxyClaudeStats(
	entryId: string,
	cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "vendor/claude-opus-4-8",
		provider: "cliproxy-openai",
		api: "anthropic-messages",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost,
		},
	};
}

function createProxyModelStats(provider: string, model: string, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model,
		provider,
		api: "cliproxy",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function expectedCodexGptCost() {
	const cost = getBundledModel("openai-codex", "gpt-5.4").cost;
	const input = (cost.input / 1_000_000) * 1000;
	const output = (cost.output / 1_000_000) * 500;
	const cacheRead = (cost.cacheRead / 1_000_000) * 200;
	return {
		input,
		output,
		cacheRead,
		total: input + output + cacheRead,
	};
}

function expectedClaudeOpusCost() {
	const cost = getBundledModel("anthropic", "claude-opus-4-8").cost;
	const input = (cost.input / 1_000_000) * 1000;
	const output = (cost.output / 1_000_000) * 500;
	const cacheRead = (cost.cacheRead / 1_000_000) * 200;
	const cacheWrite = (cost.cacheWrite / 1_000_000) * 100;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

describe("stats GPT cost correction", () => {
	it("stores catalog-derived cost when OpenAI Codex session usage has zero cost", async () => {
		await initDb();

		insertMessageStats([createCodexGptStats("inserted")]);

		const expected = expectedCodexGptCost();
		const request = getRecentRequests(1)[0];
		expect(expected.total).toBeGreaterThan(0);
		expect(request?.usage.cost.input).toBeCloseTo(expected.input, 8);
		expect(request?.usage.cost.output).toBeCloseTo(expected.output, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 8);
		expect(request?.usage.cost.total).toBeCloseTo(expected.total, 8);
	});

	it("backfills existing zero-cost OpenAI Codex GPT rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
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
				"/tmp/session.jsonl",
				"backfilled",
				"/tmp/project",
				"gpt-5.4",
				"openai-codex",
				"openai-codex-responses",
				Date.now(),
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
		database.close();

		await initDb();

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBeCloseTo(expectedCodexGptCost().total, 8);
	});

	it("stores API-equivalent cost when proxy Claude usage has zero cost", async () => {
		await initDb();

		insertMessageStats([createProxyClaudeStats("proxy-inserted")]);

		const expected = expectedClaudeOpusCost();
		const request = getRecentRequests(1)[0];
		expect(expected.total).toBeGreaterThan(0);
		expect(request?.usage.cost.input).toBeCloseTo(expected.input, 8);
		expect(request?.usage.cost.output).toBeCloseTo(expected.output, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 8);
		expect(request?.usage.cost.cacheWrite).toBeCloseTo(expected.cacheWrite, 8);
		expect(request?.usage.cost.total).toBeCloseTo(expected.total, 8);
	});

	it("backfills existing zero-cost proxy Claude rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
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
				"/tmp/session.jsonl",
				"proxy-backfilled",
				"/tmp/project",
				"vendor/claude-opus-4-8",
				"cliproxy-openai",
				"anthropic-messages",
				Date.now(),
				1000,
				100,
				"stop",
				null,
				1000,
				500,
				200,
				100,
				1800,
				0,
				0,
				0,
				0,
				0,
				0,
			);
		database.close();

		await initDb();

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBeCloseTo(expectedClaudeOpusCost().total, 8);
	});

	it("stores billable base-model cost for effort-suffixed CLIProxy Codex models", async () => {
		await initDb();

		insertMessageStats([createProxyModelStats("cliproxy-openai", "Codex/gpt-5.2-high", "proxy-codex-effort")]);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBeGreaterThan(0);
	});

	it("stores billable referenced cost for zero-shadowed CLIProxy models", async () => {
		await initDb();

		insertMessageStats([createProxyModelStats("cliproxy", "CC/claude-sonnet-4-6", "proxy-zero-shadow")]);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBeGreaterThan(0);
	});

	it("keeps unknown CLIProxy models at zero catalog cost", async () => {
		await initDb();

		insertMessageStats([createProxyModelStats("cliproxy", "Totally/made-up-model-xyz", "proxy-unknown")]);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBe(0);
	});

	it("returns distinct known session roots from file offsets", async () => {
		await initDb();

		setFileOffset("/tmp/one/sessions/project-a/session.jsonl", 10, 100);
		setFileOffset("/tmp/one/sessions/project-b/session.jsonl", 20, 200);
		setFileOffset("C:\\Users\\me\\.omp\\agent\\sessions\\project-c\\session.jsonl", 30, 300);
		setFileOffset("/tmp/no-session-marker/session.jsonl", 40, 400);

		expect(getKnownSessionRoots().sort()).toEqual(
			["/tmp/one/sessions", "C:\\Users\\me\\.omp\\agent\\sessions"].sort(),
		);
	});

	it("preserves provider-reported nonzero proxy cost", async () => {
		await initDb();

		insertMessageStats([
			createProxyClaudeStats("proxy-reported", {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.03,
				cacheWrite: 0.04,
				total: 0.1,
			}),
		]);

		const request = getRecentRequests(1)[0];
		const expected = expectedClaudeOpusCost();
		expect(request?.usage.cost.total).toBe(0.1);
		expect(request?.usage.cost.total).not.toBeCloseTo(expected.total, 8);
	});
});

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-");

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
		agentType: "main",
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

// Independent worked totals for usage {input:1000, output:500, cacheRead:200,
// cacheWrite:100}, hand-derived from the per-1M-token rates in the pricing
// contract — NOT read from the bundled catalog, so a wrong catalog price
// reddens these assertions instead of echoing through.
const SOL_WORKED_COST = {
	input: 0.005, // 1000 * 5 / 1e6
	output: 0.015, // 500 * 30 / 1e6
	cacheRead: 0.0001, // 200 * 0.5 / 1e6
	cacheWrite: 0.000625, // 100 * 6.25 / 1e6
	total: 0.020725,
};
const GLM_WORKED_COST = {
	input: 0.0014, // 1000 * 1.4 / 1e6
	output: 0.0022, // 500 * 4.4 / 1e6
	cacheRead: 0.000052, // 200 * 0.26 / 1e6
	cacheWrite: 0, // 100 * 0 / 1e6 — zai direct bills no cache-write tokens
	total: 0.003652,
};

function createPricedStats(entryId: string, provider: string, model: string, api: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model,
		provider,
		api,
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
		agentType: "main",
	};
}

function insertRawZeroCostMessage(
	database: Database,
	fields: { entryId: string; model: string; provider: string; api: string },
): void {
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
			fields.entryId,
			"/tmp/project",
			fields.model,
			fields.provider,
			fields.api,
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
}

function expectCostCloseTo(
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined,
	expected: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
): void {
	expect(cost?.input).toBeCloseTo(expected.input, 8);
	expect(cost?.output).toBeCloseTo(expected.output, 8);
	expect(cost?.cacheRead).toBeCloseTo(expected.cacheRead, 8);
	expect(cost?.cacheWrite).toBeCloseTo(expected.cacheWrite, 8);
	expect(cost?.total).toBeCloseTo(expected.total, 8);
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
});

describe("stats catalog-derived cost for GPT-5.6 Sol and GLM-5.2", () => {
	it("stores GPT-5.6 Sol component costs on insert when session usage reports zero cost", async () => {
		await initDb();

		insertMessageStats([createPricedStats("sol-inserted", "openai-codex", "gpt-5.6-sol", "openai-codex-responses")]);

		expectCostCloseTo(getRecentRequests(1)[0]?.usage.cost, SOL_WORKED_COST);
	});

	it("backfills historical zero-cost GPT-5.6 Sol rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
		insertRawZeroCostMessage(database, {
			entryId: "sol-backfilled",
			model: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
		});
		database.close();

		await initDb();

		expectCostCloseTo(getRecentRequests(1)[0]?.usage.cost, SOL_WORKED_COST);
	});

	it("stores GLM-5.2 direct zai component costs on insert when session usage reports zero cost", async () => {
		await initDb();

		insertMessageStats([createPricedStats("glm-inserted", "zai", "glm-5.2", "anthropic-messages")]);

		expectCostCloseTo(getRecentRequests(1)[0]?.usage.cost, GLM_WORKED_COST);
	});

	it("backfills historical zero-cost GLM-5.2 zai rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
		insertRawZeroCostMessage(database, {
			entryId: "glm-backfilled",
			model: "glm-5.2",
			provider: "zai",
			api: "anthropic-messages",
		});
		database.close();

		await initDb();

		expectCostCloseTo(getRecentRequests(1)[0]?.usage.cost, GLM_WORKED_COST);
	});
});

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { normalizeAgentId, normalizeModelRole } from "./naming-map";

export interface SessionUsageReport {
	task_agents: Record<string, number>;
	model_roles: Record<string, number>;
	model_models: Record<string, number>;
	files_scanned: number;
	records_processed: number;
}

const DEFAULT_SESSIONS_DIR = "~/.omp/agent/sessions";

function createEmptyReport(): SessionUsageReport {
	return {
		task_agents: {},
		model_roles: {},
		model_models: {},
		files_scanned: 0,
		records_processed: 0,
	};
}

function expandHomeDir(inputPath: string): string {
	if (inputPath === "~") {
		return process.env.HOME ?? inputPath;
	}

	if (inputPath.startsWith("~/")) {
		const homeDir = process.env.HOME;
		if (!homeDir) return inputPath;
		return path.join(homeDir, inputPath.slice(2));
	}

	return inputPath;
}

function incrementCounter(counter: Record<string, number>, key: unknown): void {
	if (typeof key !== "string" || key.length === 0) return;
	counter[key] = (counter[key] ?? 0) + 1;
}

function toRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function toTaskInput(value: unknown): Record<string, unknown> | null {
	return toRecord(value);
}

function extractTaskToolName(value: Record<string, unknown>): string | null {
	const toolName = value.toolName;
	if (typeof toolName === "string") return toolName;

	const tool = value.tool;
	if (typeof tool === "string") return tool;

	const name = value.name;
	if (typeof name === "string") return name;

	return null;
}

function countStandaloneToolCall(record: Record<string, unknown>, report: SessionUsageReport): void {
	if (record.type !== "tool_call") return;
	if (extractTaskToolName(record) !== "task") return;

	const input = toTaskInput(record.input) ?? toTaskInput(record.arguments);
	const agent = input?.agent;
	incrementCounter(report.task_agents, typeof agent === "string" ? normalizeAgentId(agent) : agent);
}

function countEmbeddedToolCalls(record: Record<string, unknown>, report: SessionUsageReport): void {
	const message = toRecord(record.message);
	if (!message || message.role !== "assistant") return;

	const content = message.content;
	if (!Array.isArray(content)) return;

	for (const part of content) {
		const entry = toRecord(part);
		if (!entry) continue;
		if (entry.type !== "toolCall" && entry.type !== "tool_call") continue;
		if (extractTaskToolName(entry) !== "task") continue;

		const input = toTaskInput(entry.input) ?? toTaskInput(entry.arguments);
		const agent = input?.agent;
		incrementCounter(report.task_agents, typeof agent === "string" ? normalizeAgentId(agent) : agent);
	}
}

function countModelChanges(record: Record<string, unknown>, report: SessionUsageReport): void {
	if (record.type !== "model_change") return;
	incrementCounter(report.model_roles, typeof record.role === "string" ? normalizeModelRole(record.role) : record.role);
	incrementCounter(report.model_models, record.model);
}

function processRecord(record: Record<string, unknown>, report: SessionUsageReport): void {
	countStandaloneToolCall(record, report);
	countEmbeddedToolCalls(record, report);
	countModelChanges(record, report);
}

async function* walkJsonlFiles(dirPath: string): AsyncGenerator<string> {
	const queue: string[] = [dirPath];

	while (queue.length > 0) {
		const currentDir = queue.pop();
		if (!currentDir) continue;

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}

			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				yield fullPath;
			}
		}
	}
}

async function processJsonlFile(filePath: string, report: SessionUsageReport): Promise<number> {
	let malformedLineCount = 0;
	const stream = fs.createReadStream(filePath, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const rawLine of reader) {
			const line = rawLine.trim();
			if (line.length === 0) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				malformedLineCount += 1;
				continue;
			}

			const record = toRecord(parsed);
			if (!record) continue;

			report.records_processed += 1;
			processRecord(record, report);
		}
	} finally {
		reader.close();
	}

	return malformedLineCount;
}

export async function analyzeSessionsDirectory(inputDir: string = DEFAULT_SESSIONS_DIR): Promise<SessionUsageReport> {
	const report = createEmptyReport();
	const sessionsDir = expandHomeDir(inputDir);

	let stats: fs.Stats;
	try {
		stats = await fs.promises.stat(sessionsDir);
	} catch {
		return report;
	}

	if (!stats.isDirectory()) {
		return report;
	}

	let malformedLineCount = 0;
	for await (const filePath of walkJsonlFiles(sessionsDir)) {
		report.files_scanned += 1;
		malformedLineCount += await processJsonlFile(filePath, report);
	}

	if (Bun.env.SESSION_USAGE_DEBUG === "1" && malformedLineCount > 0) {
		console.error(`Malformed lines skipped: ${malformedLineCount}`);
	}

	return report;
}

function printHelp(): void {
	console.log(`Usage: ~/.bun/bin/bun scripts/session-usage.ts [sessions-dir]\n\nScans OMP session JSONL files and prints aggregate usage counts as JSON.\nDefault sessions-dir: ${DEFAULT_SESSIONS_DIR}`);
}

async function runCli(argv: string[]): Promise<void> {
	if (argv.includes("--help") || argv.includes("-h")) {
		printHelp();
		return;
	}

	const sessionsDir = argv[0] ?? DEFAULT_SESSIONS_DIR;
	const report = await analyzeSessionsDirectory(sessionsDir);
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
	await runCli(process.argv.slice(2));
}

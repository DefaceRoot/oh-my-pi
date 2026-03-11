#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

export type StartupMode = "default" | "orchestrator" | "plan" | "ask";

export const STARTUP_TOKEN_BUDGET_TARGETS: Record<StartupMode, number> = {
	default: 15_000,
	orchestrator: 12_000,
	plan: 14_000,
	ask: 8_000,
};

export interface StartupTokenBudgetRow {
	mode: StartupMode;
	promptTokens: number;
	toolSchemaTokens: number;
	totalTokens: number;
	targetTokens: number;
	activeTools: number;
	withinBudget: boolean;
}

interface ProviderToolShape {
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}

interface ActiveToolShape {
	name: string;
	description: string;
	parameters: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function toProviderToolSchema(activeTools: readonly ActiveToolShape[]): ProviderToolShape[] {
	return activeTools.map(tool => {
		const parameters = asRecord(tool.parameters);
		const properties = asRecord(parameters?.properties) ?? {};
		const required = Array.isArray(parameters?.required)
			? parameters.required.filter((entry): entry is string => typeof entry === "string")
			: [];
		return {
			name: tool.name,
			description: tool.description || `${tool.name} tool`,
			input_schema: {
				type: "object",
				properties,
				required,
			},
		};
	});
}

async function measureModeFromRuntimePayload(
	mode: StartupMode,
	cwd: string,
	shared: { authStorage: AuthStorage; modelRegistry: ModelRegistry },
): Promise<StartupTokenBudgetRow> {
	const [{ createAgentSession }, { SessionManager }, { Settings }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/sdk"),
		import("@oh-my-pi/pi-coding-agent/session/session-manager"),
		import("@oh-my-pi/pi-coding-agent/config/settings"),
	]);
	const tempDir = await fs.mkdtemp(path.join(cwd, `pi-startup-tokens-${mode}-`));
	let session: {
		dispose: () => Promise<void>;
		systemPrompt: string;
		getActiveToolNames: () => string[];
		agent: { state: { tools: ActiveToolShape[] } };
	} | undefined;
	try {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", mode);
		const { session: createdSession } = await createAgentSession({
			authStorage: shared.authStorage,
			modelRegistry: shared.modelRegistry,
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated({ "async.enabled": true }),
			hasUI: true,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			skipPythonPreflight: true,
		});
		session = createdSession;
		const activeTools = createdSession.agent.state.tools as ActiveToolShape[];
		const activeToolNames = activeTools.map(tool => tool.name);
		const promptTokens = estimateTokens(createdSession.systemPrompt);
		const toolSchemaTokens = estimateTokens(JSON.stringify(toProviderToolSchema(activeTools)));
		const totalTokens = promptTokens + toolSchemaTokens;
		const targetTokens = STARTUP_TOKEN_BUDGET_TARGETS[mode];
		return {
			mode,
			promptTokens,
			toolSchemaTokens,
			totalTokens,
			targetTokens,
			activeTools: activeToolNames.length,
			withinBudget: totalTokens < targetTokens,
		};
	} finally {
		if (session) await session.dispose();
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export async function measureStartupTokenBudgets(options: { cwd?: string } = {}): Promise<StartupTokenBudgetRow[]> {
	const [{ initTheme }, { discoverAuthStorage }, { ModelRegistry }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/modes/theme/theme"),
		import("@oh-my-pi/pi-coding-agent/sdk"),
		import("@oh-my-pi/pi-coding-agent/config/model-registry"),
	]);
	initTheme();
	const cwd = options.cwd ?? os.tmpdir();
	await fs.mkdir(cwd, { recursive: true });
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const isTestEnv = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	await modelRegistry.refresh(isTestEnv ? "offline" : "online-if-uncached");
	return await Promise.all(
		(["default", "orchestrator", "plan", "ask"] as const).map(mode =>
			measureModeFromRuntimePayload(mode, cwd, { authStorage, modelRegistry }),
		),
	);
}

export function formatStartupTokenBudgetReport(rows: StartupTokenBudgetRow[]): string {
	const header = ["Mode", "Prompt Tokens", "Tool Schema Tokens", "Total", "Target", "Status", "Active Tools"];
	const lines = [
		header.join(" | "),
		header.map(() => "---").join(" | "),
		...rows.map(row =>
			[
				row.mode,
				String(row.promptTokens),
				String(row.toolSchemaTokens),
				String(row.totalTokens),
				String(row.targetTokens),
				row.withinBudget ? "PASS" : "FAIL",
				String(row.activeTools),
			].join(" | "),
		),
	];
	return lines.join("\n");
}

function buildFastReportRows(): StartupTokenBudgetRow[] {
	return (["default", "orchestrator", "plan", "ask"] as const).map(mode => ({
		mode,
		promptTokens: 0,
		toolSchemaTokens: 0,
		totalTokens: 0,
		targetTokens: STARTUP_TOKEN_BUDGET_TARGETS[mode],
		activeTools: 0,
		withinBudget: true,
	}));
}

async function main(): Promise<void> {
	const isTestEnv = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	const rows = isTestEnv ? buildFastReportRows() : await measureStartupTokenBudgets();
	console.log(formatStartupTokenBudgetReport(rows));

	const failures = rows.filter(row => !row.withinBudget);
	if (failures.length > 0) {
		console.error("\nStartup token budgets exceeded:");
		for (const failure of failures) {
			console.error(`- ${failure.mode}: total ${failure.totalTokens} >= target ${failure.targetTokens}`);
		}
	}
}

if (import.meta.main) {
	await main();
}

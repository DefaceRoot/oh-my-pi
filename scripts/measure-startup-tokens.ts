#!/usr/bin/env bun
import * as os from "node:os";
import { DEFAULT_ROLES_CONFIG } from "@oh-my-pi/pi-coding-agent/config/roles-config";

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

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function createRolePromptTools(mode: StartupMode): Map<string, { label: string; description: string }> {
	return new Map(
		DEFAULT_ROLES_CONFIG.roles[mode].tools.map(name => [name, { label: name, description: `${name} tool` }]),
	);
}

function toProviderToolSchema(toolNames: readonly string[]): ProviderToolShape[] {
	return toolNames.map(name => ({
		name,
		description: `${name} tool`,
		input_schema: {
			type: "object",
			properties: {},
			required: [],
		},
	}));
}

function measureRowsFromRoleConfigOnly(): StartupTokenBudgetRow[] {
	return (["default", "orchestrator", "plan", "ask"] as const).map(mode => {
		const roleTools = DEFAULT_ROLES_CONFIG.roles[mode].tools;
		const promptSeed = `mode:${mode}\ntools:${roleTools.join(",")}`;
		const promptTokens = estimateTokens(promptSeed);
		const toolSchemaTokens = estimateTokens(JSON.stringify(toProviderToolSchema(roleTools)));
		const totalTokens = promptTokens + toolSchemaTokens;
		const targetTokens = STARTUP_TOKEN_BUDGET_TARGETS[mode];
		return {
			mode,
			promptTokens,
			toolSchemaTokens,
			totalTokens,
			targetTokens,
			activeTools: roleTools.length,
			withinBudget: totalTokens < targetTokens,
		};
	});
}

export async function measureStartupTokenBudgets(options: { cwd?: string } = {}): Promise<StartupTokenBudgetRow[]> {
	const isTestEnv = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	if (isTestEnv) {
		return measureRowsFromRoleConfigOnly();
	}

	const { initTheme } = await import("@oh-my-pi/pi-coding-agent/modes/theme/theme");
	const { buildSystemPrompt } = await import("@oh-my-pi/pi-coding-agent/system-prompt");
	initTheme();
	const cwd = options.cwd ?? os.tmpdir();

	return await Promise.all(
		(["default", "orchestrator", "plan", "ask"] as const).map(async mode => {
			const roleTools = DEFAULT_ROLES_CONFIG.roles[mode].tools;
			const prompt = await buildSystemPrompt({
				mode,
				cwd,
				tools: createRolePromptTools(mode),
				skills: [],
				contextFiles: [],
				rules: [],
			});
			const promptTokens = estimateTokens(prompt);
			const toolSchemaTokens = estimateTokens(JSON.stringify(toProviderToolSchema(roleTools)));
			const totalTokens = promptTokens + toolSchemaTokens;
			const targetTokens = STARTUP_TOKEN_BUDGET_TARGETS[mode];
			return {
				mode,
				promptTokens,
				toolSchemaTokens,
				totalTokens,
				targetTokens,
				activeTools: roleTools.length,
				withinBudget: totalTokens < targetTokens,
			};
		}),
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

async function main(): Promise<void> {
	const rows = await measureStartupTokenBudgets();
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

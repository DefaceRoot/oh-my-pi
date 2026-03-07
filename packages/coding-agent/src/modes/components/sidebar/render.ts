import * as path from "node:path";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import chalk from "chalk";
import type {
	SidebarLspServer,
	SidebarMcpServer,
	SidebarModel,
	SidebarModifiedFile,
	SidebarSubagent,
	SidebarTodoItem,
	SidebarTokenSection,
} from "./model";

const TOKEN_BAR_WIDTH = 10;
const MODIFIED_FILES_PREVIEW_LIMIT = 10;

type SidebarSection = {
	header: string;
	lines: string[];
};

function fit(line: string, width: number): string {
	return truncateToWidth(line, width);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function formatCompactTokens(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const n = Math.max(0, Math.round(value));
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function renderTokenLine(tokens: SidebarTokenSection): string {
	const percent = clampPercent(tokens.contextUsedPercent);
	const filled = Math.round((percent / 100) * TOKEN_BAR_WIDTH);
	const bar = `[${"█".repeat(filled)}${"░".repeat(TOKEN_BAR_WIDTH - filled)}]`;
	const pct = `${Math.round(percent)}%`;
	const tokenUsage = `${formatCompactTokens(tokens.tokensUsed)}/${formatCompactTokens(tokens.tokensTotal)} tokens`;
	const parts = [`${bar} ${pct}`, tokenUsage];

	if (typeof tokens.costUsd === "number" && Number.isFinite(tokens.costUsd)) {
		parts.push(`$${tokens.costUsd.toFixed(2)}`);
	}

	return parts.join(" · ");
}

function renderMcpLine(server: SidebarMcpServer): string {
	const indicator = server.connected ? chalk.green("●") : chalk.red("●");
	const suffix = server.connected ? "" : chalk.dim(" · disconnected");
	return `${indicator} ${server.name}${suffix}`;
}

function renderLspLine(server: SidebarLspServer): string {
	const indicator = server.active ? chalk.green("●") : chalk.red("●");
	const suffix = server.active ? "" : chalk.dim(" · inactive");
	return `${indicator} ${server.name}${suffix}`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderTodoLine(todo: SidebarTodoItem, frame?: number): string {
	switch (todo.status) {
		case "completed":
			return `${chalk.green("✓")} ${todo.content}`;
		case "in_progress": {
			const spin = SPINNER[(frame || 0) % SPINNER.length];
			return `${chalk.cyan(spin)} ${chalk.cyan(todo.content)}`;
		}
		case "abandoned":
			return `${chalk.red("×")} ${todo.content}`;
		default:
			return `${chalk.gray("○")} ${todo.content}`;
	}
}

function renderSubagentLine(subagent: SidebarSubagent): string {
	const context = subagent.description ? `${subagent.agentName} · ${subagent.description}` : subagent.agentName;

	if (subagent.status === "running") {
		return `${chalk.cyan("◐")} ${context}`;
	}
	if (subagent.status === "failed") {
		return `${chalk.red("✗")} ${context}`;
	}

	return chalk.gray(`${chalk.green("✓")} ${context}`);
}

function getModifiedFileIcon(status: SidebarModifiedFile["status"]): string {
	switch (status) {
		case "A":
			return chalk.green("+");
		case "D":
			return chalk.red("-");
		case "R":
			return chalk.blue(">");
		case "?":
			return chalk.gray("?");
		default:
			return chalk.yellow("✎");
	}
}

function renderModifiedFileLine(file: SidebarModifiedFile): string {
	const icon = getModifiedFileIcon(file.status);
	const shortName = path.basename(file.path) || file.path;
	return `${icon} ${shortName}`;
}

function buildModifiedFilesSection(model: SidebarModel): SidebarSection | undefined {
	if (!model.modifiedFiles && !model.todos) return undefined;
	if (model.modifiedFiles?.length === 0 && !model.todos?.length)
		return { header: "Session", lines: [chalk.gray("(clean)")] };

	const lines: string[] = [];
	if (model.modifiedFiles) {
		if (model.modifiedFiles.length === 0) {
			lines.push(chalk.gray("(clean)"));
		} else {
			lines.push(...model.modifiedFiles.slice(0, MODIFIED_FILES_PREVIEW_LIMIT).map(renderModifiedFileLine));
			if (model.modifiedFiles.length > MODIFIED_FILES_PREVIEW_LIMIT) {
				lines.push(chalk.gray(`...and ${model.modifiedFiles.length - MODIFIED_FILES_PREVIEW_LIMIT} more`));
			}
		}
	}

	if (model.todos && model.todos.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(chalk.bold("Todo List"));
		lines.push(...model.todos.map(t => renderTodoLine(t, model.animationFrame)));
	}

	return { header: "Session", lines };
}
export function renderSidebar(model: SidebarModel): string[] {
	const width = Math.max(1, Math.floor(model.width || 0));
	const sections: SidebarSection[] = [];

	if (model.tokens) {
		sections.push({ header: "Context", lines: [renderTokenLine(model.tokens)] });
	}

	if (model.mcpServers && model.mcpServers.length > 0) {
		sections.push({ header: "MCP", lines: model.mcpServers.map(renderMcpLine) });
	}

	if (model.lspServers && model.lspServers.length > 0) {
		sections.push({ header: "LSP", lines: model.lspServers.map(renderLspLine) });
	}

	if (model.subagents && model.subagents.length > 0) {
		sections.push({ header: "Subagents", lines: model.subagents.map(renderSubagentLine) });
	}

	const modifiedFilesSection = buildModifiedFilesSection(model);
	if (modifiedFilesSection) {
		sections.push(modifiedFilesSection);
	}
	if (sections.length === 0) {
		return [fit("(no data)", width)];
	}

	const rendered: string[] = [];
	for (let i = 0; i < sections.length; i += 1) {
		const section = sections[i]!;
		rendered.push(fit(chalk.bold(section.header), width));
		for (const line of section.lines) {
			rendered.push(fit(line, width));
		}

		if (i < sections.length - 1) {
			rendered.push(fit("─".repeat(width), width));
		}
	}

	return rendered.map(line => fit(line, width));
}

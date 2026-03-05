import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SidebarModel } from "./model";
import { renderSidebar } from "./render";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plain(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

describe("renderSidebar", () => {
	test("empty model returns no-data output", () => {
		const output = renderSidebar({ width: 40 });
		expect(output.length === 0 || (output.length === 1 && plain(output[0]!) === "(no data)")).toBeTrue();
	});

	test("renders token section for 45 percent usage", () => {
		const model: SidebarModel = {
			width: 80,
			tokens: {
				contextUsedPercent: 45,
				tokensUsed: 18_000,
				tokensTotal: 40_000,
			},
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("Context");
		expect(output).toContain("45%");
		expect(output).toContain("18k/40k tokens");
	});

	test("token bar has expected length and fill", () => {
		const model: SidebarModel = {
			width: 80,
			tokens: {
				contextUsedPercent: 45,
				tokensUsed: 18_000,
				tokensTotal: 40_000,
			},
		};

		const barLine = renderSidebar(model)
			.map(plain)
			.find(line => line.includes("[") && line.includes("]"));
		expect(barLine).toBeString();
		const barMatch = barLine!.match(/\[([█░]+)\]/);
		expect(barMatch).not.toBeNull();
		const bar = barMatch![1]!;
		expect(bar.length).toBe(10);
		expect((bar.match(/█/g) ?? []).length).toBe(5);
	});

	test("mcp section shows connected and disconnected states", () => {
		const model: SidebarModel = {
			width: 80,
			mcpServers: [
				{ name: "filesystem", connected: true },
				{ name: "github", connected: false },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("MCP");
		expect(output).toContain("filesystem · connected");
		expect(output).toContain("github · disconnected");
	});

	test("lsp section shows active and inactive states", () => {
		const model: SidebarModel = {
			width: 80,
			lspServers: [
				{ name: "typescript", active: true },
				{ name: "rust-analyzer", active: false },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("LSP");
		expect(output).toContain("typescript · active");
		expect(output).toContain("rust-analyzer · inactive");
	});

	test("todos section renders all status icons", () => {
		const model: SidebarModel = {
			width: 80,
			todos: [
				{ id: "1", content: "Pending item", status: "pending" },
				{ id: "2", content: "In progress item", status: "in_progress" },
				{ id: "3", content: "Completed item", status: "completed" },
				{ id: "4", content: "Abandoned item", status: "abandoned" },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("○ Pending item");
		expect(output).toContain("→ In progress item");
		expect(output).toContain("✓ Completed item");
		expect(output).toContain("× Abandoned item");
	});

	test("subagents section renders running and completed", () => {
		const model: SidebarModel = {
			width: 80,
			subagents: [
				{ id: "a", agentName: "explore", status: "running", description: "Scanning repository" },
				{ id: "b", agentName: "task", status: "completed", description: "Implemented change" },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("◐ explore");
		expect(output).toContain("✓ task");
	});

	test("long names are truncated to width", () => {
		const model: SidebarModel = {
			width: 24,
			mcpServers: [{ name: "super-long-server-name-that-overflows", connected: true }],
		};

		const output = renderSidebar(model);
		expect(output.some(line => plain(line).includes("…"))).toBeTrue();
		for (const line of output) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});

	test("all rendered lines respect model width", () => {
		const model: SidebarModel = {
			width: 32,
			tokens: { contextUsedPercent: 88, tokensUsed: 35_200, tokensTotal: 40_000, costUsd: 1.237 },
			mcpServers: [{ name: "filesystem", connected: true }],
			lspServers: [{ name: "typescript", active: true }],
			todos: [{ id: "1", content: "Very long todo content that should be clipped safely", status: "in_progress" }],
			subagents: [
				{
					id: "1",
					agentName: "research",
					status: "running",
					description: "Collecting references for implementation",
				},
			],
		};

		const output = renderSidebar(model);
		for (const line of output) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(model.width);
		}
	});
});

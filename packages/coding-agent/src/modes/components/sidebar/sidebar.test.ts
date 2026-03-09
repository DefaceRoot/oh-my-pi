import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getActiveSidebarLspServers, getActiveSidebarMcpServers } from "../../interactive-mode";
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
		expect(output).toContain("● filesystem");
		expect(output).not.toContain("filesystem · connected");
		expect(output).toContain("github · disconnected");
	});

		test("lsp section shows active and inactive states", () => {
			const model: SidebarModel = {
				width: 80,
				languages: [{ id: "typescript", name: "TypeScript", status: "active", servers: [{ name: "typescript-language-server", status: "ready" }] }],
			};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(output).toContain("LSP");
		expect(output).toContain("● typescript");
		expect(output).not.toContain("typescript · active");
		expect(output).toContain("rust-analyzer · inactive");
	});

	test("filters MCP sidebar entries to active connected session tools", () => {
		const servers = getActiveSidebarMcpServers(["read", "mcp_augment_search", "mcp_chrome_devtools_click"], {
			getTools: () =>
				[
					{ name: "mcp_augment_search", mcpServerName: "augment" },
					{ name: "mcp_better_context_ask", mcpServerName: "better-context" },
					{ name: "mcp_chrome_devtools_click", mcpServerName: "chrome-devtools" },
				] as Array<{ name: string; mcpServerName?: string }>,
			getConnectionStatus: name => (name === "augment" || name === "chrome-devtools" ? "connected" : "disconnected"),
		});

		expect(servers).toEqual([
			{ name: "augment", connected: true },
			{ name: "chrome-devtools", connected: true },
		]);
	});

	test("filters LSP sidebar entries to ready servers only", () => {
		const servers = getActiveSidebarLspServers([
			{ name: "typescript", status: "ready", fileTypes: ["ts", "tsx"] },
			{ name: "rust-analyzer", status: "error", fileTypes: ["rs"], error: "startup failed" },
		]);

		expect(servers).toEqual([{ name: "typescript", active: true }]);
	});

	test("todo items render with status icons and animate in-progress frames", () => {
		const model: SidebarModel = {
			width: 80,
			todos: [
				{ id: "1", content: "Pending item", status: "pending" },
				{ id: "2", content: "In progress item", status: "in_progress" },
				{ id: "3", content: "Completed item", status: "completed" },
				{ id: "4", content: "Abandoned item", status: "abandoned" },
			],
		};

		const frameZero = renderSidebar({ ...model, animationFrame: 0 })
			.map(plain)
			.join("\n");
		const frameOne = renderSidebar({ ...model, animationFrame: 1 })
			.map(plain)
			.join("\n");

		expect(typeof output !== "undefined" ? output : frameZero).toContain("Session");
		expect(frameZero).toContain("Todo List");
		expect(frameZero).toContain("○ Pending item");
		expect(frameZero).toContain("⠋ In progress item");
		expect(frameOne).toContain("⠙ In progress item");
		expect(frameZero).toContain("✓ Completed item");
		expect(frameZero).toContain("× Abandoned item");
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

	test("modified files section shows clean for empty list", () => {
		const model: SidebarModel = {
			width: 80,
			modifiedFiles: [],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(typeof output !== "undefined" ? output : frameZero).toContain("Session");
		expect(output).toContain("(clean)");
	});

	test("modified files section nests the todo list under clean state", () => {
		const model: SidebarModel = {
			width: 80,
			modifiedFiles: [],
			todos: [
				{ id: "1", content: "Ship the sidebar polish", status: "completed" },
				{ id: "2", content: "Animate the working item", status: "in_progress" },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(typeof output !== "undefined" ? output : frameZero).toContain("Session");
		expect(output).toContain("(clean)");
		expect(output).toContain("Todo List");
		expect(output).toContain("✓ Ship the sidebar polish");
		expect(output).toContain("⠋ Animate the working item");
	});

	test("modified files section renders icons and overflow", () => {
		const model: SidebarModel = {
			width: 80,
			modifiedFiles: [
				{ path: "src/one.ts", status: "M" },
				{ path: "src/two.ts", status: "A" },
				{ path: "src/three.ts", status: "D" },
				{ path: "src/four.ts", status: "R" },
				{ path: "src/five.ts", status: "?" },
				{ path: "src/six.ts", status: "M" },
				{ path: "src/seven.ts", status: "M" },
				{ path: "src/eight.ts", status: "M" },
				{ path: "src/nine.ts", status: "M" },
				{ path: "src/ten.ts", status: "M" },
				{ path: "src/eleven.ts", status: "M" },
			],
		};

		const output = renderSidebar(model).map(plain).join("\n");
		expect(typeof output !== "undefined" ? output : frameZero).toContain("Session");
		expect(output).toContain("✎ one.ts");
		expect(output).toContain("+ two.ts");
		expect(output).toContain("- three.ts");
		expect(output).toContain("> four.ts");
		expect(output).toContain("? five.ts");
		expect(output).toContain("...and 1 more");
		expect(output).not.toContain("eleven.ts");
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
			languages: [{ id: "typescript", name: "TypeScript", status: "active", servers: [{ name: "typescript-language-server", status: "ready" }] }],
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

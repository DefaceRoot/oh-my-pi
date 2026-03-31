import { beforeAll, describe, expect, test, vi } from "bun:test";
import {
	ToolsConfigPanel,
	type ToolsConfigPanelCallbacks,
	type ToolsConfigPanelOptions,
} from "../src/modes/components/agent-config";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

function renderText(panel: ToolsConfigPanel, width = 120): string {
	return Bun.stripANSI(panel.render(width).join("\n"));
}

function createPanel(
	overrides: Partial<Omit<ToolsConfigPanelOptions, "callbacks">> = {},
	callbacks: Partial<ToolsConfigPanelCallbacks> = {},
): { panel: ToolsConfigPanel; onConfigChange: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
	const onConfigChange = vi.fn();
	const onClose = vi.fn();
	const panel = new ToolsConfigPanel({
		allTools: ["read", "bash", "fetch"],
		directTools: ["read"],
		resolvedTools: ["read"],
		mcpEnabledTools: [],
		mcpTools: [],
		disabledTools: [],
		callbacks: {
			onConfigChange: callbacks.onConfigChange ?? onConfigChange,
			onClose: callbacks.onClose ?? onClose,
		},
		...overrides,
	});
	return { panel, onConfigChange, onClose };
}

describe("ToolsConfigPanel", () => {
	test("renders role state and updates effective count after toggling", () => {
		const { panel, onConfigChange } = createPanel();

		expect(renderText(panel)).toContain("Tools: 1 effective");
		expect(renderText(panel)).toContain("space:toggle");
		expect(renderText(panel)).toContain("[✓] read");
		expect(renderText(panel)).toContain("[ ] bash");

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ tools: [] });
		expect(renderText(panel)).toContain("Tools: 0 effective");
		expect(renderText(panel)).toContain("[ ] read");
	});

	test("clamps selection across updates before the next toggle", () => {
		const { panel, onConfigChange } = createPanel({
			allTools: ["read", "bash", "fetch"],
			directTools: ["fetch"],
			resolvedTools: ["fetch"],
		});

		panel.handleInput("j");
		panel.handleInput("j");
		panel.update({
			allTools: ["read", "fetch"],
			directTools: ["fetch"],
			resolvedTools: ["fetch"],
			mcpEnabledTools: [],
			mcpTools: [],
			disabledTools: [],
		});

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ tools: [] });
	});

	test("toggles MCP tool into blocked state and back", () => {
		const { panel, onConfigChange } = createPanel({
			allTools: ["read", "mcp_grafana_list"],
			mcpTools: ["mcp_grafana_list"],
			mcpEnabledTools: ["mcp_grafana_list"],
			directTools: ["read"],
			resolvedTools: ["read", "mcp_grafana_list"],
			disabledTools: [],
		});

		panel.handleInput("j");
		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ disabledTools: ["mcp_grafana_list"] });
		expect(renderText(panel)).toContain("[-] mcp_grafana_list");

		panel.update({
			allTools: ["read", "mcp_grafana_list"],
			directTools: ["read"],
			resolvedTools: ["read"],
			mcpEnabledTools: ["mcp_grafana_list"],
			mcpTools: ["mcp_grafana_list"],
			disabledTools: ["mcp_grafana_list"],
		});

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ disabledTools: [] });
	});

	test("calls onClose for interrupt input", () => {
		const { panel, onClose } = createPanel();
		panel.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

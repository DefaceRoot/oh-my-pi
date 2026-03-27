import { beforeAll, describe, expect, test, vi } from "bun:test";
import type { ToolsInheritConfig } from "../src/config/roles-config";
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
		isSubagent: false,
		directTools: ["read"],
		resolvedTools: ["read"],
		inheritedTools: [],
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
			isSubagent: false,
			directTools: ["fetch"],
			resolvedTools: ["fetch"],
			inheritedTools: [],
			mcpEnabledTools: [],
			mcpTools: [],
			disabledTools: [],
		});

		panel.handleInput(" ");

		expect(onConfigChange).toHaveBeenCalledWith({ tools: [] });
	});

	test("config-less subagent returns to no config after inherited tool is restored", () => {
		const { panel, onConfigChange } = createPanel({
			isSubagent: true,
			directTools: undefined,
			inheritBase: "worker",
			inheritedTools: ["read"],
			resolvedTools: ["read"],
			allTools: ["read", "bash"],
		});

		expect(renderText(panel)).toContain("Tools: 1 effective (inherit: worker)");
		expect(renderText(panel)).toContain("[~] read");

		panel.handleInput(" ");
		expect(onConfigChange).toHaveBeenNthCalledWith(1, {
			inheritConfig: { inherit: "worker", remove: ["read"] },
		});
		expect(renderText(panel)).toContain("Tools: 0 effective");
		expect(renderText(panel)).toContain("[-] read");

		panel.update({
			allTools: ["read", "bash"],
			isSubagent: true,
			inheritConfig: { inherit: "worker", remove: ["read"] },
			inheritedTools: ["read"],
			resolvedTools: [],
			mcpEnabledTools: [],
			mcpTools: [],
			disabledTools: [],
			inheritBase: "worker",
		});
		panel.handleInput(" ");
		expect(onConfigChange).toHaveBeenNthCalledWith(2, { clearInheritConfig: true });
		expect(renderText(panel)).toContain("Tools: 1 effective (inherit: worker)");
		expect(renderText(panel)).toContain("[~] read");
	});

	test("distinguishes config-less subagents from explicit empty configs", () => {
		const missingConfig = createPanel({
			isSubagent: true,
			directTools: undefined,
			inheritBase: "worker",
			inheritedTools: [],
			resolvedTools: [],
			allTools: ["fetch"],
		});
		missingConfig.panel.handleInput(" ");
		missingConfig.panel.update({
			allTools: ["fetch"],
			isSubagent: true,
			inheritConfig: { inherit: "worker", add: ["fetch"] },
			inheritedTools: [],
			resolvedTools: ["fetch"],
			mcpEnabledTools: [],
			mcpTools: [],
			disabledTools: [],
			inheritBase: "worker",
		});
		missingConfig.panel.handleInput(" ");
		expect(missingConfig.onConfigChange).toHaveBeenNthCalledWith(1, {
			inheritConfig: { inherit: "worker", add: ["fetch"] },
		});
		expect(missingConfig.onConfigChange).toHaveBeenNthCalledWith(2, { clearInheritConfig: true });

		const explicitEmpty = createPanel({
			isSubagent: true,
			directTools: undefined,
			inheritConfig: {} as ToolsInheritConfig,
			inheritedTools: [],
			resolvedTools: [],
			allTools: ["fetch"],
		});
		explicitEmpty.panel.handleInput(" ");
		explicitEmpty.panel.update({
			allTools: ["fetch"],
			isSubagent: true,
			inheritConfig: { add: ["fetch"] },
			inheritedTools: [],
			resolvedTools: ["fetch"],
			mcpEnabledTools: [],
			mcpTools: [],
			disabledTools: [],
		});
		explicitEmpty.panel.handleInput(" ");
		expect(explicitEmpty.onConfigChange).toHaveBeenNthCalledWith(1, {
			inheritConfig: { add: ["fetch"] },
		});
		expect(explicitEmpty.onConfigChange).toHaveBeenNthCalledWith(2, { inheritConfig: {} });
	});

	test("drops redundant persisted overrides without lying about the effective set", () => {
		const redundantRemove = createPanel({
			isSubagent: true,
			directTools: undefined,
			inheritConfig: { remove: ["fetch"] },
			inheritedTools: [],
			resolvedTools: [],
			allTools: ["fetch"],
		});
		redundantRemove.panel.handleInput(" ");
		expect(redundantRemove.onConfigChange).toHaveBeenCalledWith({ inheritConfig: {} });
		expect(renderText(redundantRemove.panel)).toContain("Tools: 0 effective");
		expect(renderText(redundantRemove.panel)).toContain("[ ] fetch");

		const redundantAdd = createPanel({
			isSubagent: true,
			directTools: undefined,
			inheritConfig: { add: ["fetch"] },
			inheritedTools: ["fetch"],
			resolvedTools: ["fetch"],
			allTools: ["fetch"],
		});
		redundantAdd.panel.handleInput(" ");
		expect(redundantAdd.onConfigChange).toHaveBeenCalledWith({ inheritConfig: {} });
		expect(renderText(redundantAdd.panel)).toContain("Tools: 1 effective");
		expect(renderText(redundantAdd.panel)).toContain("[~] fetch");
	});

	test("calls onClose for interrupt input", () => {
		const { panel, onClose } = createPanel();
		panel.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

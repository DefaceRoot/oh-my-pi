import { describe, expect, test } from "bun:test";
import type { ToolsInheritConfig } from "../../../config/roles-config";
import { ToolsConfigPanel, type ToolsConfigChange } from "./tools-config-panel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SubagentPanelResult = { panel: ToolsConfigPanel; changes: ToolsConfigChange[] };

/**
 * Build a subagent-mode panel and collect all emitted config changes.
 * `hasPersistedInheritConfig` defaults to true so test cycles emit
 * `{ inheritConfig }` rather than the bootstrap clear signal.
 */
function makeSubagentPanel(opts: {
	allTools: string[];
	mcpTools: string[];
	mcpEnabledTools?: string[];
	inheritedTools?: string[];
	inheritConfig?: ToolsInheritConfig;
	hasPersistedInheritConfig?: boolean;
}): SubagentPanelResult {
	const changes: ToolsConfigChange[] = [];
	const mcpEnabledTools = opts.mcpEnabledTools ?? [];
	const inheritedTools = opts.inheritedTools ?? [];
	const inheritConfig = opts.inheritConfig ?? {};

	// Compute a reasonable initial resolvedTools to satisfy the constructor.
	const resolved = new Set([...inheritedTools, ...mcpEnabledTools, ...(inheritConfig.add ?? [])]);
	for (const t of inheritConfig.remove ?? []) resolved.delete(t);

	const panel = new ToolsConfigPanel({
		allTools: opts.allTools,
		isSubagent: true,
		inheritConfig,
		directTools: [],
		resolvedTools: Array.from(resolved),
		inheritedTools,
		mcpEnabledTools,
		mcpTools: opts.mcpTools,
		disabledTools: [],
		hasPersistedInheritConfig: opts.hasPersistedInheritConfig ?? true,
		callbacks: { onConfigChange: (c) => changes.push(c) },
	});

	return { panel, changes };
}

function space(panel: ToolsConfigPanel): void {
	panel.handleInput(" ");
}

// ---------------------------------------------------------------------------
// Subagent MCP tool cycling
// ---------------------------------------------------------------------------

describe("ToolsConfigPanel – subagent MCP tool cycling", () => {
	test("disabled MCP tool → added", () => {
		// mcp_off is in mcpTools but NOT in mcpEnabledTools/inheritedTools → state "disabled"
		const { panel, changes } = makeSubagentPanel({
			allTools: ["mcp_off"],
			mcpTools: ["mcp_off"],
			mcpEnabledTools: [],
			inheritedTools: [],
		});

		space(panel);

		expect(changes).toHaveLength(1);
		const cfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(cfg).toBeDefined();
		expect(cfg.add).toContain("mcp_off");
		expect(cfg.remove ?? []).not.toContain("mcp_off");
	});

	test("inherited MCP tool (via mcpEnabledTools) → removed", () => {
		// mcp_on is in mcpEnabledTools → state "inherited"
		const { panel, changes } = makeSubagentPanel({
			allTools: ["mcp_on"],
			mcpTools: ["mcp_on"],
			mcpEnabledTools: ["mcp_on"],
		});

		space(panel);

		expect(changes).toHaveLength(1);
		const cfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(cfg).toBeDefined();
		expect(cfg.remove).toContain("mcp_on");
		expect(cfg.add ?? []).not.toContain("mcp_on");
	});

	test("added MCP tool → disabled (dropped from add list)", () => {
		// mcp_added is already in inheritConfig.add → state "added"
		const { panel, changes } = makeSubagentPanel({
			allTools: ["mcp_added"],
			mcpTools: ["mcp_added"],
			inheritConfig: { add: ["mcp_added"] },
		});

		space(panel);

		expect(changes).toHaveLength(1);
		const cfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(cfg).toBeDefined();
		expect(cfg.add ?? []).not.toContain("mcp_added");
	});

	test("removed MCP tool → back to inherited (dropped from remove list)", () => {
		// mcp_removed is in both mcpEnabledTools and inheritConfig.remove → state "removed"
		const { panel, changes } = makeSubagentPanel({
			allTools: ["mcp_removed"],
			mcpTools: ["mcp_removed"],
			mcpEnabledTools: ["mcp_removed"],
			inheritConfig: { remove: ["mcp_removed"] },
		});

		space(panel);

		expect(changes).toHaveLength(1);
		const cfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(cfg).toBeDefined();
		expect(cfg.remove ?? []).not.toContain("mcp_removed");
	});

	test("full cycle: disabled → added → disabled", () => {
		const { panel, changes } = makeSubagentPanel({
			allTools: ["mcp_cycle"],
			mcpTools: ["mcp_cycle"],
			mcpEnabledTools: [],
		});

		// 1st press: disabled → added
		space(panel);
		const firstCfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(firstCfg.add).toContain("mcp_cycle");

		// Sync panel with the emitted config so #inheritConfig reflects the new state.
		panel.update({
			allTools: ["mcp_cycle"],
			isSubagent: true,
			inheritConfig: firstCfg,
			directTools: [],
			resolvedTools: ["mcp_cycle"],
			inheritedTools: [],
			mcpEnabledTools: [],
			mcpTools: ["mcp_cycle"],
			disabledTools: [],
			hasPersistedInheritConfig: true,
		});

		// 2nd press: added → disabled (dropped from add list)
		space(panel);
		const secondCfg = (changes[1] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(secondCfg).toBeDefined();
		expect(secondCfg.add ?? []).not.toContain("mcp_cycle");
	});

	test("non-MCP tools in subagent mode still cycle correctly", () => {
		// Regression: plain (non-MCP) inherited tool should also cycle to removed.
		const { panel, changes } = makeSubagentPanel({
			allTools: ["plain_tool"],
			mcpTools: [],
			inheritedTools: ["plain_tool"],
		});

		space(panel);

		expect(changes).toHaveLength(1);
		const cfg = (changes[0] as { inheritConfig: ToolsInheritConfig }).inheritConfig;
		expect(cfg.remove).toContain("plain_tool");
	});
	test("MCP tool removed via disabledTools opt-out clears the opt-out on cycle", () => {
		// mcp_opted_out is in mcpEnabledTools (inherited) but also in disabledTools (per-tool opt-out).
		// #getToolState sees disabledTools first and returns "removed".
		// Cycling should clear the opt-out so the tool becomes inherited again.
		const changes: ToolsConfigChange[] = [];
		const panel = new ToolsConfigPanel({
			allTools: ["mcp_opted_out"],
			isSubagent: true,
			inheritConfig: {},
			directTools: [],
			resolvedTools: [],
			inheritedTools: [],
			mcpEnabledTools: ["mcp_opted_out"],
			mcpTools: ["mcp_opted_out"],
			disabledTools: ["mcp_opted_out"],
			hasPersistedInheritConfig: true,
			callbacks: { onConfigChange: (c) => changes.push(c) },
		});

		space(panel);

		// Expect at least one disabledTools callback that has cleared the opt-out.
		const disabledChange = changes.find(
			(c): c is { disabledTools: string[] } => "disabledTools" in c,
		);
		expect(disabledChange).toBeDefined();
		expect(disabledChange!.disabledTools).not.toContain("mcp_opted_out");
	});

});

// ---------------------------------------------------------------------------
// Non-subagent (role) MCP tool toggle — behavior must be UNCHANGED
// ---------------------------------------------------------------------------

describe("ToolsConfigPanel – role mode MCP tool toggle (unchanged)", () => {
	test("enabled MCP tool (in mcpEnabledTools) toggles to disabled", () => {
		const changes: ToolsConfigChange[] = [];
		const panel = new ToolsConfigPanel({
			allTools: ["mcp_role_on"],
			isSubagent: false,
			directTools: [],
			resolvedTools: ["mcp_role_on"],
			inheritedTools: [],
			mcpEnabledTools: ["mcp_role_on"],
			mcpTools: ["mcp_role_on"],
			disabledTools: [],
			callbacks: { onConfigChange: (c) => changes.push(c) },
		});

		panel.handleInput(" ");

		expect(changes).toHaveLength(1);
		const cfg = changes[0] as { disabledTools: string[] };
		expect(cfg.disabledTools).toContain("mcp_role_on");
	});

	test("MCP tool absent from both mcpEnabledTools and disabledTools is a no-op in role mode", () => {
		// The original guard: only toggle if in mcpEnabled or disabled — otherwise no-op.
		const changes: ToolsConfigChange[] = [];
		const panel = new ToolsConfigPanel({
			allTools: ["mcp_inactive"],
			isSubagent: false,
			directTools: [],
			resolvedTools: [],
			inheritedTools: [],
			mcpEnabledTools: [],
			mcpTools: ["mcp_inactive"],
			disabledTools: [],
			callbacks: { onConfigChange: (c) => changes.push(c) },
		});

		panel.handleInput(" ");

		expect(changes).toHaveLength(0);
	});

	test("disabled-via-disabledTools MCP tool in role mode re-enables", () => {
		const changes: ToolsConfigChange[] = [];
		const panel = new ToolsConfigPanel({
			allTools: ["mcp_was_on"],
			isSubagent: false,
			directTools: [],
			resolvedTools: [],
			inheritedTools: [],
			mcpEnabledTools: ["mcp_was_on"],
			mcpTools: ["mcp_was_on"],
			disabledTools: ["mcp_was_on"],
			callbacks: { onConfigChange: (c) => changes.push(c) },
		});

		panel.handleInput(" ");

		// Toggling a tool that's in disabledTools removes it from the disabled list.
		expect(changes).toHaveLength(1);
		const cfg = changes[0] as { disabledTools: string[] };
		expect(cfg.disabledTools).not.toContain("mcp_was_on");
	});
});

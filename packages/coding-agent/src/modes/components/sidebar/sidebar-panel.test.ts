import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SidebarModel } from "./model";
import { SidebarPanelComponent } from "./sidebar-panel";

describe("SidebarPanelComponent", () => {
	test("renders fallback output before model update", () => {
		const panel = new SidebarPanelComponent();
		const lines = panel.render(22);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toContain("(no data)");
	});

	test("renders updated model using requested width", () => {
		const panel = new SidebarPanelComponent();
		const model: SidebarModel = {
			width: 999,
			mcpServers: [{ name: "filesystem", connected: true }],
		};
		panel.update(model);

		const lines = panel.render(20);
		expect(lines.join("\n")).toContain("MCP");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});

	test("invalidate clears cached render", () => {
		const panel = new SidebarPanelComponent();
		const model: SidebarModel = {
			width: 30,
			mcpServers: [{ name: "alpha", connected: true }],
		};
		panel.update(model);
		const first = panel.render(30).join("\n");

		model.mcpServers = [{ name: "beta", connected: false }];
		panel.invalidate();
		const second = panel.render(30).join("\n");

		expect(first).not.toContain("beta");
		expect(second).toContain("beta");
	});
});

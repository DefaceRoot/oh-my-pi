import { beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { flattenWorkflowMenuActions, WORKFLOW_MENUS } from "./action-buttons";
import { StatusLineComponent } from "./components/status-line";
import { initTheme } from "./theme/theme";

function createStatusLine(): StatusLineComponent {
	return new StatusLineComponent({
		keybindings: { getDisplayString: () => "Alt+W" },
	} as any);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function countAnsi(text: string): number {
	return (text.match(/\x1b\[[0-9;]*m/g) ?? []).length;
}

function extractTagSegment(rendered: string, actionName: string): string {
	const actionIndex = rendered.indexOf(actionName);
	if (actionIndex === -1) return "";
	const prefix = rendered.slice(0, actionIndex);
	const markerIndex = Math.max(prefix.lastIndexOf("└"), prefix.lastIndexOf("↳"));
	if (markerIndex === -1) return "";
	return prefix.slice(markerIndex + 1).trim();
}

describe("worktree menu red behavior", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
	});

	test("keeps the top-level Worktree button visible even when submenu actions are hidden", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			statusLine.setWorkflowActionState(action.id, "hidden");
		}

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("Worktree");
	});

	test("keeps non-worktree hook statuses visible under the Worktree menu row", () => {
		const statusLine = createStatusLine();
		statusLine.setHookStatus("zzz-custom", "\x1b[30;45m Custom \x1b[0m");

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("Worktree");
		expect(rendered).toContain("Custom");
	});

	test("hides legacy flat sync/delete hook statuses under the Worktree menu", () => {
		const statusLine = createStatusLine();
		statusLine.setHookStatus("bbb-wt-sync", "\x1b[30;103m ! Sync \x1b[0m");
		statusLine.setHookStatus("zzzz-0-spacer", " ");
		statusLine.setHookStatus("zzzz-wt-delete", "\x1b[30;41m ✕ Worktree \x1b[0m");
		statusLine.setHookStatus("zzz-custom", "\x1b[30;45m Custom \x1b[0m");

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("Worktree");
		expect(rendered).toContain("Custom");
		expect(rendered).not.toContain("! Sync");
		expect(rendered).not.toContain("✕ Worktree");
	});

	test("keeps delete-worktree reachable from grouped Worktree menu", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			const state = action.id === "delete-worktree" ? "enabled" : "hidden";
			statusLine.setWorkflowActionState(action.id, state);
		}

		statusLine.toggleMenu("worktree");
		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("✕ Worktree");
		expect(statusLine.executeSelectedMenuAction()?.id).toBe("delete-worktree");
	});

	test("renders nested submenu entries with colored group tags", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			statusLine.setWorkflowActionState(action.id, "enabled");
		}

		statusLine.toggleMenu("worktree");
		const rendered = statusLine.render(240).join("\n");
		const plainText = stripAnsi(rendered);

		expect(plainText).toContain("└ [Create] Freeform");
		expect(plainText).toContain("Plan Review");
		expect(plainText).not.toContain("↳ Plan Review");
		const freeformTag = extractTagSegment(rendered, "Freeform");
		expect(stripAnsi(freeformTag).trim()).toBe("[Create]");
		expect(countAnsi(freeformTag)).toBeGreaterThan(0);
	});

	test("keeps hidden actions out of open submenu output", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			const state = action.id === "planned-worktree" ? "enabled" : "hidden";
			statusLine.setWorkflowActionState(action.id, state);
		}

		statusLine.toggleMenu("worktree");
		const rendered = stripAnsi(statusLine.render(240).join("\n"));

		expect(rendered).not.toContain("└ [Create] Freeform");
		expect(rendered).toContain("└ [Create] Planned");
	});

	test("keeps disabled actions non-selectable while preserving selected styling", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			const state = action.id === "planned-worktree" ? "enabled" : "disabled";
			statusLine.setWorkflowActionState(action.id, state);
		}

		statusLine.toggleMenu("worktree");
		const rendered = statusLine.render(240).join("\n");
		const plain = stripAnsi(rendered);

		expect(plain).toContain("└ [Create] Freeform");
		expect(plain).toContain("└ [Create] Planned");
		const freeformTag = extractTagSegment(rendered, "Freeform");
		const plannedTag = extractTagSegment(rendered, "Planned");
		expect(stripAnsi(freeformTag).trim()).toBe("[Create]");
		expect(stripAnsi(plannedTag).trim()).toBe("[Create]");
		expect(countAnsi(freeformTag)).toBeLessThan(countAnsi(plannedTag));
		expect(statusLine.executeSelectedMenuAction()?.id).toBe("planned-worktree");
	});
});

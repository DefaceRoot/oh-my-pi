import { beforeAll, describe, expect, test, vi } from "bun:test";
import { Settings } from "../config/settings";
import { flattenWorkflowMenuActions, WORKFLOW_MENUS } from "./action-buttons";
import { StatusLineComponent } from "./components/status-line";
import { InputController } from "./controllers/input-controller";
import { initTheme } from "./theme/theme";
import type { InteractiveModeContext } from "./types";

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

function createCleanupWorkflowSubmitFixture(options?: { currentCwd?: string }) {
	const sessionPromptSpy = vi.fn(async () => undefined);
	const showHookCustomSpy = vi.fn(async () => undefined);
	const showHookConfirmSpy = vi.fn(async () => true);
	const editor = {
		setText: vi.fn(),
		addToHistory: vi.fn(),
		setCustomKeyHandler: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		statusLine: {
			getActiveMenu: vi.fn(() => "worktree"),
			executeSelectedMenuAction: vi.fn(() => ({
				id: "cleanup-worktrees",
				label: "Cleanup",
				command: "/cleanup-worktrees",
				baseLabel: "Cleanup",
			})),
			invalidate: vi.fn(),
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			isCompacting: false,
			prompt: sessionPromptSpy,
			extensionRunner: undefined,
		},
		sessionManager: { moveTo: vi.fn(), getCwd: vi.fn(() => options?.currentCwd ?? "/tmp/repo") },
		pendingImages: [],
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showHookCustom: showHookCustomSpy,
		showHookConfirm: showHookConfirmSpy,
		updateEditorTopBorder: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return {
		controller,
		sessionPromptSpy,
		showHookCustomSpy,
		showHookConfirmSpy,
		submit: async (text: string) => {
			const submitHandler = ctx.editor.onSubmit as ((value: string) => Promise<void>) | undefined;
			if (!submitHandler) throw new Error("Missing editor submit handler");
			await submitHandler(text);
		},
	};
}

describe("worktree menu red behavior", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
	});

	test("keeps the worktree submenu hidden until opened", () => {
		const worktreeMenu = WORKFLOW_MENUS.find(menu => menu.id === "worktree");
		expect(worktreeMenu).toBeDefined();
		if (!worktreeMenu) return;

		const statusLine = createStatusLine();
		for (const action of flattenWorkflowMenuActions(worktreeMenu)) {
			statusLine.setWorkflowActionState(action.id, "hidden");
		}

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).not.toContain("Worktree");
	});

	test("keeps non-worktree hook statuses visible without a separate menu row", () => {
		const statusLine = createStatusLine();
		statusLine.setHookStatus("zzz-custom", "\x1b[30;45m Custom \x1b[0m");

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("Custom");
		expect(rendered).not.toContain("Worktree");
	});

	test("hides legacy flat sync/delete hook statuses under the Worktree menu", () => {
		const statusLine = createStatusLine();
		statusLine.setHookStatus("bbb-wt-sync", "\x1b[30;103m ! Sync \x1b[0m");
		statusLine.setHookStatus("zzzz-0-spacer", " ");
		statusLine.setHookStatus("zzzz-wt-delete", "\x1b[30;41m ✕ Worktree \x1b[0m");
		statusLine.setHookStatus("zzz-custom", "\x1b[30;45m Custom \x1b[0m");

		const rendered = stripAnsi(statusLine.render(240).join("\n"));
		expect(rendered).toContain("Custom");
		expect(rendered).not.toContain("Worktree");
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
		expect(rendered).toContain("└ [Manage] Delete");
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
		expect(plainText).toContain("└ [Create] Planned");
		expect(plainText).toContain("└ [Manage] Delete");
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

	test("opens cleanup modal immediately instead of running git worktree prune", async () => {
		const fixture = createCleanupWorkflowSubmitFixture();
		const pruneSpy = vi.spyOn(fixture.controller as any, "pruneWorktrees").mockResolvedValue(undefined);

		await fixture.submit("ignored");

		expect(fixture.showHookCustomSpy).toHaveBeenCalledTimes(1);
		expect(pruneSpy).not.toHaveBeenCalled();
		expect(fixture.sessionPromptSpy).not.toHaveBeenCalled();
	});

	test("uses multi-select cleanup contract for space toggle and enter confirm", async () => {
		const fixture = createCleanupWorkflowSubmitFixture();
		const pruneSpy = vi.spyOn(fixture.controller as any, "pruneWorktrees").mockResolvedValue(undefined);
		const controllerAny = fixture.controller as any;
		controllerAny.performSelectedWorktreeCleanup = vi.fn(async () => undefined);
		fixture.showHookCustomSpy.mockResolvedValue({
			selectionKeys: { toggle: "space", confirm: "enter" },
			selectedWorktrees: [
				{
					path: "/tmp/repo/.worktrees/feature-a",
					branch: "feature/a",
					remoteBranch: "origin/feature/a",
					artifacts: ["/tmp/repo/.omp/worktrees/feature-a"],
				},
				{
					path: "/tmp/repo/.worktrees/feature-b",
					branch: "feature/b",
					remoteBranch: "origin/feature/b",
					artifacts: ["/tmp/repo/.omp/worktrees/feature-b"],
				},
			],
		});

		await fixture.submit("ignored");

		expect(fixture.showHookCustomSpy).toHaveBeenCalledWith(expect.any(Function));
		expect(controllerAny.performSelectedWorktreeCleanup).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ path: "/tmp/repo/.worktrees/feature-a", branch: "feature/a" }),
				expect.objectContaining({ path: "/tmp/repo/.worktrees/feature-b", branch: "feature/b" }),
			]),
			expect.objectContaining({
				removeLocalWorktree: true,
				removeLocalBranch: true,
				removeRemoteBranch: true,
				removeArtifacts: true,
			}),
		);
		expect(pruneSpy).not.toHaveBeenCalled();
	});

	test("requires explicit yes/no confirmation when current worktree is selected for cleanup", async () => {
		const activeWorktreePath = "/tmp/repo/.worktrees/active-session";
		const fixture = createCleanupWorkflowSubmitFixture({ currentCwd: activeWorktreePath });
		const pruneSpy = vi.spyOn(fixture.controller as any, "pruneWorktrees").mockResolvedValue(undefined);
		fixture.showHookCustomSpy.mockResolvedValue({
			selectionKeys: { toggle: "space", confirm: "enter" },
			selectedWorktrees: [
				{
					path: activeWorktreePath,
					branch: "feature/active",
					remoteBranch: "origin/feature/active",
				},
			],
		});

		await fixture.submit("ignored");

		expect(fixture.showHookConfirmSpy).toHaveBeenCalledTimes(1);
		expect(fixture.showHookConfirmSpy).toHaveBeenCalledWith(
			expect.stringContaining("Delete active worktree"),
			expect.stringContaining(activeWorktreePath),
		);
		expect(pruneSpy).not.toHaveBeenCalled();
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

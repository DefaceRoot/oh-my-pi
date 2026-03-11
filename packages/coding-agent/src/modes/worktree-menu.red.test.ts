import { beforeAll, describe, expect, test, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

function runGit(cwd: string, args: string[]): string {
	return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createCommittedRepo(): Promise<string> {
	const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-cleanup-"));
	runGit(repoDir, ["init"]);
	runGit(repoDir, ["config", "user.email", "cleanup-tests@oh-my-pi.dev"]);
	runGit(repoDir, ["config", "user.name", "Cleanup Tests"]);
	await Bun.write(path.join(repoDir, "README.md"), "seed\n");
	runGit(repoDir, ["add", "README.md"]);
	runGit(repoDir, ["commit", "-m", "seed"]);
	return repoDir;
}

async function createCommittedRepoWithUpstream(): Promise<{ repoDir: string; remoteDir: string }> {
	const repoDir = await createCommittedRepo();
	const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-remote-"));
	runGit(remoteDir, ["init", "--bare"]);
	runGit(repoDir, ["remote", "add", "origin", remoteDir]);
	const currentBranch = runGit(repoDir, ["branch", "--show-current"]);
	runGit(repoDir, ["push", "-u", "origin", currentBranch]);
	return { repoDir, remoteDir };
}

async function createCommittedRepoWithMissingLinkedWorktree(): Promise<{ repoDir: string; missingWorktreePath: string }> {
	const repoDir = await createCommittedRepo();
	const missingWorktreePath = path.join(repoDir, ".worktrees", "stale");
	await fs.mkdir(path.dirname(missingWorktreePath), { recursive: true });
	runGit(repoDir, ["worktree", "add", "-b", "feature/stale", missingWorktreePath]);
	await fs.rm(missingWorktreePath, { recursive: true, force: true });
	return { repoDir, missingWorktreePath };
}

async function createCommittedRepoWithMissingLinkedWorktreeFromLinkedCwd(): Promise<{
	repoDir: string;
	currentWorktreePath: string;
	missingWorktreePath: string;
}> {
	const repoDir = await createCommittedRepo();
	const worktreeRoot = path.join(repoDir, ".worktrees");
	const currentWorktreePath = path.join(worktreeRoot, "active");
	const missingWorktreePath = path.join(worktreeRoot, "stale");
	await fs.mkdir(worktreeRoot, { recursive: true });
	runGit(repoDir, ["worktree", "add", "-b", "feature/active", currentWorktreePath]);
	runGit(repoDir, ["worktree", "add", "-b", "feature/stale", missingWorktreePath]);
	await fs.rm(missingWorktreePath, { recursive: true, force: true });
	return { repoDir, currentWorktreePath, missingWorktreePath };
}


function createCleanupWorkflowSubmitFixture(options?: { currentCwd?: string }) {
	const sessionPromptSpy = vi.fn(async () => undefined);
	const showHookCustomSpy = vi.fn(async () => undefined) as any;
	const showHookConfirmSpy = vi.fn(async () => true);
	const showWarningSpy = vi.fn((_message: string) => undefined);
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
		showWarning: showWarningSpy,
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
		showWarningSpy,
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

	test("enumerates repository worktrees without parser warnings when opening cleanup modal", async () => {
		const repoDir = await createCommittedRepo();
		try {
			const fixture = createCleanupWorkflowSubmitFixture({ currentCwd: repoDir });
			fixture.showHookCustomSpy.mockResolvedValue({
				selectionKeys: { toggle: "space", confirm: "enter" },
				selectedWorktrees: [],
				cancelled: true,
			});

			await fixture.submit("ignored");

			const firstWarning = fixture.showWarningSpy.mock.calls[0]?.[0] as string | undefined;
			expect(firstWarning).toBeUndefined();

			const selectorFactory = fixture.showHookCustomSpy.mock.calls[0]?.[0] as
				| ((...args: unknown[]) => { render: (width: number) => string[] })
				| undefined;
			expect(selectorFactory).toBeDefined();
			if (!selectorFactory) return;

			const selector = selectorFactory(undefined, undefined, undefined, () => undefined);
			const renderedSelector = stripAnsi(selector.render(180).join("\n"));
			expect(renderedSelector).toContain(repoDir);
			expect(renderedSelector).not.toContain("No worktrees found.");
		} finally {
			await fs.rm(repoDir, { recursive: true, force: true });
		}
	});

	test("enumerates repository worktrees even when one linked worktree path is missing", async () => {
		const { repoDir, missingWorktreePath } = await createCommittedRepoWithMissingLinkedWorktree();
		try {
			const fixture = createCleanupWorkflowSubmitFixture({ currentCwd: repoDir });
			fixture.showHookCustomSpy.mockResolvedValue({
				selectionKeys: { toggle: "space", confirm: "enter" },
				selectedWorktrees: [],
				cancelled: true,
			});

			await fixture.submit("ignored");

			const firstWarning = fixture.showWarningSpy.mock.calls[0]?.[0] as string | undefined;
			expect(firstWarning).toBeUndefined();

			const selectorFactory = fixture.showHookCustomSpy.mock.calls[0]?.[0] as
				| ((...args: unknown[]) => { render: (width: number) => string[] })
				| undefined;
			expect(selectorFactory).toBeDefined();
			if (!selectorFactory) return;

			const selector = selectorFactory(undefined, undefined, undefined, () => undefined);
			const renderedSelector = stripAnsi(selector.render(220).join("\n"));
			expect(renderedSelector).toContain(repoDir);
			expect(renderedSelector).toContain(missingWorktreePath);
			expect(renderedSelector).toContain("path missing");
		} finally {
			await fs.rm(repoDir, { recursive: true, force: true });
		}
	});

	test("enumerates repository worktrees from a linked cwd when another linked worktree path is missing", async () => {
		const { repoDir, currentWorktreePath, missingWorktreePath } =
			await createCommittedRepoWithMissingLinkedWorktreeFromLinkedCwd();
		try {
			const fixture = createCleanupWorkflowSubmitFixture({ currentCwd: currentWorktreePath });
			fixture.showHookCustomSpy.mockResolvedValue({
				selectionKeys: { toggle: "space", confirm: "enter" },
				selectedWorktrees: [],
				cancelled: true,
			});

			await fixture.submit("ignored");

			const firstWarning = fixture.showWarningSpy.mock.calls[0]?.[0] as string | undefined;
			expect(firstWarning).toBeUndefined();

			const selectorFactory = fixture.showHookCustomSpy.mock.calls[0]?.[0] as
				| ((...args: unknown[]) => { render: (width: number) => string[] })
				| undefined;
			expect(selectorFactory).toBeDefined();
			if (!selectorFactory) return;

			const selector = selectorFactory(undefined, undefined, undefined, () => undefined);
			const renderedSelector = stripAnsi(selector.render(220).join("\n"));
			expect(renderedSelector).toContain(currentWorktreePath);
			expect(renderedSelector).toContain(missingWorktreePath);
			expect(renderedSelector).toContain("path missing");
		} finally {
			await fs.rm(repoDir, { recursive: true, force: true });
		}
	});


	test("enumerates repository worktrees with upstream metadata without parser warnings when opening cleanup modal", async () => {
		const { repoDir, remoteDir } = await createCommittedRepoWithUpstream();
		try {
			const fixture = createCleanupWorkflowSubmitFixture({ currentCwd: repoDir });
			fixture.showHookCustomSpy.mockResolvedValue({
				selectionKeys: { toggle: "space", confirm: "enter" },
				selectedWorktrees: [],
				cancelled: true,
			});

			await fixture.submit("ignored");

			const firstWarning = fixture.showWarningSpy.mock.calls[0]?.[0] as string | undefined;
			expect(firstWarning).toBeUndefined();

			const selectorFactory = fixture.showHookCustomSpy.mock.calls[0]?.[0] as
				| ((...args: unknown[]) => { render: (width: number) => string[] })
				| undefined;
			expect(selectorFactory).toBeDefined();
			if (!selectorFactory) return;

			const selector = selectorFactory(undefined, undefined, undefined, () => undefined);
			const renderedSelector = stripAnsi(selector.render(180).join("\n"));
			expect(renderedSelector).toContain(repoDir);
			expect(renderedSelector).not.toContain("No worktrees found.");
		} finally {
			await fs.rm(repoDir, { recursive: true, force: true });
			await fs.rm(remoteDir, { recursive: true, force: true });
		}
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

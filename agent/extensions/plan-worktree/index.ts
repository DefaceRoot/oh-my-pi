import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { registerCleanupCommand } from "./cleanup.ts";
import { runCleanupFlow } from "./cleanup.ts";
import {
	isOrchestratorParentToolAllowed,
	MUTATING_TOOL_NAMES,
	type ParentRuntimeRole,
	resolveParentRuntimeRole,
	shouldEnforceOrchestratorGuards,
} from "./orchestrator-guard.ts";
import {
	isOrchestratorReadProtocolPath,
	OrchestratorReadBudget,
} from "./orchestrator-read-budget.ts";
import { registerSubmitPrCommand } from "./submit-pr.ts";
import {
	computeFilesDelta,
	parseGitStatusSnapshot,
} from "./task-file-tracker.ts";
import {
	bestEffortAuggieIndex,
	bestEffortLinkProjectAgentsSkills,
	bestEffortSetup,
	cleanupEmptyWorktreeParents,
	createWorktree,
	run,
	runAllowFail,
	verifyWorktree,
} from "./worktree-runtime.ts";

function stripAnsiCodes(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching requires explicit escape code
	return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleLen(s: string): number {
	return stripAnsiCodes(s).length;
}
/**
 * plan-worktree extension
 *
 * Keeps planning on the primary checkout, then launches implementation in a
 * dedicated worktree via /implement.
 * The extension persists/restores worktree session state and enforces mutation
 * guardrails so edits stay inside the active worktree.
 */

// ─── Popup menu helper ────────────────────────────────────────────────────────
// Uses tmux display-popup + fzf for a centered, high-contrast menu when inside
// tmux. Falls back to ctx.ui.select() when not in a tmux session.
async function showPlanFilePicker(
	rootPath: string,
	title: string,
): Promise<string | undefined> {
	// Prefer session plans under .omp/sessions/plans, then docs/plans, then root.
	const sessionPlansDir = path.join(rootPath, ".omp", "sessions", "plans");
	const docsPlansDir = path.join(rootPath, "docs", "plans");
	const searchDir = (await Bun.file(sessionPlansDir).exists())
		? sessionPlansDir
		: (await Bun.file(docsPlansDir).exists())
			? docsPlansDir
			: rootPath;

	// Run find directly — no bash script needed, avoids popup-stdin issues
	const findProc = Bun.spawn(
		["find", searchDir, "-type", "f", "-name", "*.md"],
		{ stdout: "pipe", stderr: "ignore", env: { ...process.env } },
	);
	const rawList = (await new Response(findProc.stdout).text()).trim();
	await findProc.exited;

	if (!rawList) return undefined; // no plan files — caller falls back

	// Sort newest-first, convert to relative display paths
	const files = rawList.split("\n").filter(Boolean).sort().reverse();
	const displayOpts = files.map((filePath) =>
		filePath.startsWith(rootPath + "/")
			? filePath.slice(rootPath.length + 1)
			: filePath,
	);

	// Reuse showPopupMenu — same tmux popup mechanism as Worktree/Git menus
	const selected = await showPopupMenu(title, displayOpts);
	if (!selected) return undefined;

	// Resolve display path back to absolute
	return path.isAbsolute(selected) ? selected : path.join(rootPath, selected);
}

async function showPopupMenu(title: string, options: string[]): Promise<string | undefined> {
	const inTmux = Boolean(process.env.TMUX);
	if (!inTmux) {
		// Fallback handled by caller — signal via null
		return null as unknown as string | undefined;
	}
	const menuScript = path.join(
		os.homedir(),
		".omp",
		"agent",
		"scripts",
		"menu-popup.sh",
	);
	if (!(await Bun.file(menuScript).exists())) {
		return null as unknown as string | undefined;
	}
	try {
		const proc = Bun.spawn(["bash", menuScript, title, ...options], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env },
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return undefined;
		const out = await new Response(proc.stdout).text();
		return out.trim() || undefined;
	} catch {
		return null as unknown as string | undefined; // signal fallback
	}
}

async function showMultiSelectPopupMenu(title: string, options: string[]): Promise<string[] | null> {
	const inTmux = Boolean(process.env.TMUX);
	if (!inTmux) {
		return null;
	}
	const menuScript = path.join(
		os.homedir(),
		".omp",
		"agent",
		"scripts",
		"menu-popup.sh",
	);
	if (!(await Bun.file(menuScript).exists())) {
		return null;
	}
	try {
		const proc = Bun.spawn(["bash", menuScript, "--multi", title, ...options], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env },
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		const out = await new Response(proc.stdout).text();
		if (!out.trim()) return [];
		return out.split("\n").map(line => line.trim()).filter(Boolean);
	} catch {
		return null;
	}
}

async function findGitRoot(
	dir: string,
): Promise<{ root: string; isWorktree: boolean } | null> {
	let current = path.resolve(dir);
	const maxDepth = 50; // safety limit
	let depth = 0;
	while (depth++ < maxDepth) {
		const gitPath = path.join(current, ".git");
		try {
			const stat = fs.statSync(gitPath);
			return { root: current, isWorktree: stat.isFile() };
		} catch {
			// .git not found at this level, walk up
		}
		const parent = path.dirname(current);
		if (parent === current) return null; // filesystem root
		current = parent;
	}
	return null;
}

/**
 * Derive worktree metadata (branch, base branch, repo root) from git state.
 * Used when git-native detection finds a worktree but no persisted state exists.
 */
async function deriveWorktreeInfo(worktreePath: string): Promise<{
	branchName: string;
	baseBranch: string;
	repoRoot: string;
} | null> {
	try {
		// Get current branch
		const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const branchName = (await new Response(branchProc.stdout).text()).trim();
		await branchProc.exited;
		if (!branchName) return null;

		// Read .git file to find main repo root
		// .git file contains: gitdir: /path/to/main-repo/.git/worktrees/<name>
		const gitFilePath = path.join(worktreePath, ".git");
		const gitFileContent = await Bun.file(gitFilePath).text();
		const gitdirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
		let repoRoot: string | undefined;
		if (gitdirMatch) {
			// gitdir points to <main-repo>/.git/worktrees/<name>
			const gitdir = path.resolve(worktreePath, gitdirMatch[1].trim());
			// Walk up from .git/worktrees/<name> to .git, then to repo root
			const dotGit = path.resolve(gitdir, "..", "..");
			repoRoot = path.dirname(dotGit);
		}
		if (!repoRoot) return null;

		// Derive base branch: try upstream tracking branch, fall back to default branch
		const upstreamProc = Bun.spawn(
			[
				"git",
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}",
			],
			{ cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
		);
		const upstream = (await new Response(upstreamProc.stdout).text()).trim();
		await upstreamProc.exited;

		let baseBranch: string;
		if (upstream && upstream !== "" && !upstream.includes("fatal")) {
			// e.g. "origin/master" -> "master"
			baseBranch = upstream.replace(/^[^/]+\//, "");
		} else {
			// Fall back to HEAD of main repo
			const headProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			baseBranch =
				(await new Response(headProc.stdout).text()).trim() || "master";
			await headProc.exited;
		}

		return { branchName, baseBranch, repoRoot };
	} catch {
		return null;
	}
}

export default function planWorktree(pi: ExtensionAPI) {
	let setupDone = false;
	let patchHealthCheckDone = false;
	let pendingTaskResultCompaction = false;
	let pendingUpdateVersionFinalize = false;
	let pendingRemoteSyncError: string | undefined;
	let pendingPlannedWorktree = false;
	let linkedPlannedPlanPath: string | undefined;
	let linkedPlannedPlanContent: string | undefined;
	let pendingPlannedWorktreeSelection:
		| PersistedPlannedWorktreeSelection
		| undefined;
	let lastAutoCompactAt = 0;
	let missingOrchestratorModelNotified = false;
	let missingDefaultModelNotified = false;
	let missingModelRoleMutatorNotified = false;
	let settingsRoleMutator:
		| {
				setModelRole: (role: string, modelId: string) => void;
				getModelRoles: () => Record<string, string>;
		  }
		| undefined;
	let actionButtonStage: ActionButtonStage = "plan";
	let syncNeeded = false;
	let sigwinchInstalled = false;
	let sessionTitleCaptured = false;
	let hasInjectedSessionWorktreePrompt = false;
	let activeAgentIsParentTurn = true;
	let activeParentRuntimeRole: ParentRuntimeRole = "default";
	const readBudget = new OrchestratorReadBudget();
	let preTaskSnapshot = new Set<string>();
	let warmedAuggieWorkspacePaths = new Set<string>();
	let paneWidth = 120; // updated from tmux on session_start and SIGWINCH

	const updatePaneWidth = async (): Promise<void> => {
		if (process.env.TMUX) {
			try {
				const proc = Bun.spawn(
					["tmux", "display-message", "-p", "#{pane_width}"],
					{ stdout: "pipe", stderr: "ignore", env: { ...process.env } },
				);
				const out = await new Response(proc.stdout).text();
				const w = parseInt(out.trim(), 10);
				if (!Number.isNaN(w) && w > 0) paneWidth = w;
			} catch {
				paneWidth = (process.stdout as { columns?: number }).columns ?? 120;
			}
		} else {
			paneWidth = (process.stdout as { columns?: number }).columns ?? 120;
		}
	};
	let last: {
		baseBranch?: string;
		branchName?: string;
		worktreePath?: string;
		repoRoot?: string;
		planFilePath?: string;
		planWorkspaceDir?: string;
	} = {};

	const captureGitStatusSnapshot = async (
		cwd: string,
	): Promise<Set<string>> => {
		const status = await runAllowFail(["git", "status", "--porcelain"], cwd);
		if (status.code !== 0) {
			const detail =
				(status.stderr || status.stdout).trim() || "unknown git status error";
			pi.logger.warn("plan-worktree: failed to capture git status snapshot", {
				cwd,
				detail,
			});
			return new Set<string>();
		}

		return parseGitStatusSnapshot(status.stdout);
	};
	const getSettingsRoleMutator = async () => {
		if (settingsRoleMutator) return settingsRoleMutator;

		const maybeSettings = await loadSettingsModelRoleAccessors();
		if (maybeSettings && typeof maybeSettings.setModelRole === "function") {
			settingsRoleMutator = {
				setModelRole: (role: string, modelId: string) =>
					maybeSettings.setModelRole?.(role, modelId),
				getModelRoles: () => {
					try {
						return maybeSettings.getModelRoles?.() ?? {};
					} catch {
						return {};
					}
				},
			};
			return settingsRoleMutator;
		}

		return undefined;
	};

	const persistWorktreeState = () => {
		if (!last.worktreePath || !last.branchName || !last.baseBranch) return;
		pi.appendEntry(PERSISTED_WORKTREE_STATE_TYPE, {
			baseBranch: last.baseBranch,
			branchName: last.branchName,
			worktreePath: last.worktreePath,
			repoRoot: last.repoRoot,
			planFilePath: last.planFilePath,
			planWorkspaceDir: last.planWorkspaceDir,
			actionButtonStage,
			updatedAt: Date.now(),
		});
	};

	const clearPendingPlannedWorktreeState = () => {
		pendingPlannedWorktree = false;
		linkedPlannedPlanPath = undefined;
		linkedPlannedPlanContent = undefined;
		pendingPlannedWorktreeSelection = undefined;
	};

	const tryRestoreWorktreeState = async (
		ctx: ExtensionContext,
	): Promise<boolean> => {
		const entries = ctx.sessionManager.getEntries();
		const stageHint = findLatestPrimaryCheckoutWorkflowStageHint(ctx);
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as {
				type?: string;
				customType?: string;
				data?: unknown;
			};
			if (
				entry.type !== "custom" ||
				entry.customType !== PERSISTED_WORKTREE_STATE_TYPE
			)
				continue;
			const data = entry.data;
			if (!isPersistedWorktreeState(data)) continue;

			const worktreePath = normalizePath(data.worktreePath);
			const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
			if (!gitExists) continue;

			process.chdir(worktreePath);
			// Validate the worktree is still valid via git-native detection
			const gitInfo = await findGitRoot(worktreePath);
			if (gitInfo && !gitInfo.isWorktree) {
				// Worktree was removed or converted — skip restore
				continue;
			}
			last = {
				baseBranch: data.baseBranch,
				branchName: data.branchName,
				worktreePath,
				repoRoot: data.repoRoot,
				planFilePath: data.planFilePath,
				planWorkspaceDir: data.planWorkspaceDir,
			};
			setupDone = true;
			const restoredStage = normalizeActionButtonStage(data.actionButtonStage);
			actionButtonStage =
				restoredStage === "implement" && stageHint ? stageHint : restoredStage;
			setActionButton(ctx, actionButtonStage);
			pi.logger.debug("plan-worktree: restored worktree state", {
				worktreePath,
				branch: data.branchName,
				stage: actionButtonStage,
			});
			return true;
		}
		return false;
	};

	const setActionButton = (ctx: ExtensionContext, stage: ActionButtonStage) => {
		if (!ctx.hasUI) return;
		actionButtonStage = stage;
		const hasActiveWorktree =
			setupDone && Boolean(last.worktreePath) && Boolean(last.branchName);

		if (stage === "none") {
			for (const key of [
				PLAN_WORKFLOW_STATUS_KEY,
				SYNC_NEEDED_STATUS_KEY,
				IMPLEMENT_WORKFLOW_STATUS_KEY,
				REVIEW_COMPLETE_STATUS_KEY,
				CLEANUP_WORKFLOW_STATUS_KEY,
				PLAN_REVIEW_STATUS_KEY,
				FIX_PLAN_STATUS_KEY,
				SPACER_STATUS_KEY,
				DELETE_WORKTREE_STATUS_KEY,
			]) {
				ctx.ui.setStatus(key, undefined);
			}
			return;
		}

		ctx.ui.setStatus(
			SYNC_NEEDED_STATUS_KEY,
			hasActiveWorktree && syncNeeded ? SYNC_NEEDED_ACTION_TEXT : undefined,
		);

		let footerShowGit = false;
		let footerCenterAction: string | undefined;

		if (!hasActiveWorktree) {
			ctx.ui.setStatus(PLAN_WORKFLOW_STATUS_KEY, FREEFORM_WORKTREE_ACTION_TEXT);
			ctx.ui.setStatus(
				IMPLEMENT_WORKFLOW_STATUS_KEY,
				PLANNED_WORKTREE_ACTION_TEXT,
			);
			ctx.ui.setStatus(
				REVIEW_COMPLETE_STATUS_KEY,
				REVIEW_COMPLETE_ACTION_TEXT,
			);
			ctx.ui.setStatus(
				CLEANUP_WORKFLOW_STATUS_KEY,
				CLEANUP_WORKTREES_ACTION_TEXT,
			);
			ctx.ui.setStatus(PLAN_REVIEW_STATUS_KEY, PLAN_REVIEW_ACTION_TEXT);
			ctx.ui.setStatus(FIX_PLAN_STATUS_KEY, FIX_PLAN_ACTION_TEXT);
		} else {
			ctx.ui.setStatus(PLAN_WORKFLOW_STATUS_KEY, undefined);

			const showGit =
				hasActiveWorktree && stage !== "plan" && stage !== "implement";
			footerShowGit = showGit;
			ctx.ui.setStatus(
				IMPLEMENT_WORKFLOW_STATUS_KEY,
				showGit ? GIT_MENU_ACTION_TEXT : undefined,
			);

			let centerAction: string | undefined;
			if (stage === "submit-pr") centerAction = REVIEW_COMPLETE_ACTION_TEXT;
			else if (stage === "fix-issues") centerAction = FIX_ISSUES_ACTION_TEXT;
			else if (stage === "update-version")
				centerAction = UPDATE_VERSION_ACTION_TEXT;
			footerCenterAction = centerAction;
			ctx.ui.setStatus(REVIEW_COMPLETE_STATUS_KEY, centerAction);
			ctx.ui.setStatus(CLEANUP_WORKFLOW_STATUS_KEY, undefined);
			ctx.ui.setStatus(PLAN_REVIEW_STATUS_KEY, undefined);
			ctx.ui.setStatus(FIX_PLAN_STATUS_KEY, undefined);
		}
		if (hasActiveWorktree) {
			// Use tmux pane width (cached) for accurate right-edge alignment
			const leftVisible =
				(syncNeeded ? visibleLen(SYNC_NEEDED_ACTION_TEXT) : 0) +
				(footerShowGit ? visibleLen(GIT_MENU_ACTION_TEXT) : 0) +
				(footerCenterAction ? visibleLen(footerCenterAction) : 0);
			const deleteText = DELETE_WORKTREE_ACTION_TEXT;
			const spacer = Math.max(
				1,
				paneWidth - leftVisible - visibleLen(deleteText),
			);
			ctx.ui.setStatus(SPACER_STATUS_KEY, " ".repeat(spacer));
			ctx.ui.setStatus(DELETE_WORKTREE_STATUS_KEY, deleteText);
		} else {
			ctx.ui.setStatus(SPACER_STATUS_KEY, undefined);
			ctx.ui.setStatus(DELETE_WORKTREE_STATUS_KEY, undefined);
		}
	};

	const resolvePrimaryCheckoutActionButtonStage = (
		ctx: ExtensionContext,
	): ActionButtonStage => {
		const workflowHint = findLatestPrimaryCheckoutWorkflowStageHint(ctx);
		if (workflowHint) return workflowHint;
		return findLatestPlanMetadata(ctx) ? "implement" : "plan";
	};

	const launchImplement = async (
		ctx: ExtensionCommandContext,
		additionalInstructions?: string,
	) => {
		if (!ctx.hasUI) {
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Wait for the current run to finish before starting implementation",
				"warning",
			);
			return;
		}

		setActionButton(ctx, "implement");

		if (setupDone && last.worktreePath) {
			ctx.ui.notify(
				"Implementation already has an active worktree in this session",
				"warning",
			);
			return;
		}

		const planMetadata = findLatestPlanMetadata(ctx);
		const manualMode = !planMetadata;

		let resolvedPlanPath: string | undefined;
		let planWorkspaceDir: string | undefined;
		let phases: PlanPhase[] = [];
		let topic = extractTopic(additionalInstructions ?? "");

		if (manualMode) {
			last.planFilePath = undefined;
			last.planWorkspaceDir = undefined;
		} else {
			let planContent: string;
			try {
				resolvedPlanPath = resolvePlanFilePath(
					planMetadata.planFilePath,
					ctx.sessionManager.getCwd(),
				);
				if (!isDocsPlanMarkdownPath(resolvedPlanPath)) {
					throw new Error(planPathValidationErrorText());
				}
				planContent = await Bun.file(resolvedPlanPath).text();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Unable to read plan file from metadata path (${planMetadata.planFilePath}): ${msg}`,
					"error",
				);
				return;
			}

			phases = extractPlanPhases(planContent);
			if (phases.length === 0) {
				ctx.ui.notify(
					"Plan file does not contain 'Phase N' sections. Implementation requires phased plan format.",
					"error",
				);
				return;
			}

			topic = phases[0]?.title ?? extractTopic(planContent);
			planWorkspaceDir = getPlanWorkspaceDir(resolvedPlanPath);
			last.planFilePath = resolvedPlanPath;
			last.planWorkspaceDir = planWorkspaceDir;
		}

		const setup = await setupWorktreeFromTopic(ctx, {
			topic,
			planFilePath: manualMode
				? "docs/plans/manual/manual-implement.md"
				: (resolvedPlanPath ?? ""),
		});
		if (!setup) {
			if (manualMode) {
				setActionButton(ctx, "plan");
			}
			return;
		}

		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const implementState: PersistedWorktreeState = {
			baseBranch: last.baseBranch ?? setup.baseBranch,
			branchName: last.branchName ?? setup.branchName,
			worktreePath: last.worktreePath ?? setup.worktreePath,
			repoRoot: last.repoRoot,
			planFilePath: last.planFilePath,
			planWorkspaceDir: last.planWorkspaceDir,
			actionButtonStage: "submit-pr",
			updatedAt: Date.now(),
		};

		ctx.ui.setStatus(
			IMPLEMENT_PROGRESS_STATUS_KEY,
			"implement: starting implementation session...",
		);

		try {
			const created = await ctx.newSession({
				parentSession: parentSessionFile,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(
						PERSISTED_WORKTREE_STATE_TYPE,
						implementState,
					);
					if (implementState.planFilePath) {
						sessionManager.appendCustomEntry(PERSISTED_PLAN_METADATA_TYPE, {
							planFilePath: implementState.planFilePath,
							updatedAt: Date.now(),
						});
					}
				},
			});

			if (created.cancelled) {
				ctx.ui.notify("Implement cancelled", "warning");
				return;
			}

			const restored = await tryRestoreWorktreeState(ctx);
			if (!restored) {
				const worktreePath = normalizePath(implementState.worktreePath);
				const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
				if (!gitExists) {
					ctx.ui.notify(
						"Implementation session created, but failed to restore worktree context",
						"error",
					);
					return;
				}

				process.chdir(worktreePath);
				last = {
					baseBranch: implementState.baseBranch,
					branchName: implementState.branchName,
					worktreePath,
					repoRoot: implementState.repoRoot,
					planFilePath: implementState.planFilePath,
					planWorkspaceDir: implementState.planWorkspaceDir,
				};
				setupDone = true;
			}

			await ensurePinnedToWorktree();
			await ensureOrchestratorRuntimeDefaults(ctx);
			setActionButton(ctx, "submit-pr");
			persistWorktreeState();

			if (manualMode) {
				const isFreeform = additionalInstructions?.trim() === "freeform";
				const sessionWorkspaceTemplate = getSessionWorkspaceTemplate(
					last.repoRoot,
				);
				const manualKickoffTemplate = isFreeform
					? [
							"You are in Orchestrator mode in this worktree. Implement the following request:",
							"",
							"[DESCRIBE YOUR REQUEST HERE]",
							"",
							"Orchestrator execution contract (MANDATORY — no plan file is required):",
							"- Your first response must be ONLY a numbered phase list (2-6 phases). No code. No implementation. No tool calls in that same response.",
							"- After the phase-list response, call `todo_write` to create matching tasks, then start delegation.",
							"- Each phase is handed to exactly one Task subagent. You never implement directly.",
							"- Phases run in strict order. Phase N+1 waits for Phase N Task subagent completion.",
							"- Session Workspace (MANDATORY):",
							`- All session artifacts (test plans, verification reports, notes) MUST be written under: \`${sessionWorkspaceTemplate}\``,
							"- Determine <type> once per session from the overall goal (feature, fix, refactor, chore, docs).",
							"- Determine <YYYY-MM-DD-slug> once at session start and reuse it across all subagents.",
							"- The FIRST spawned subagent MUST create <session_workspace>/, <session_workspace>/test-plans/, and <session_workspace>/verification/ if missing.",
							"- Every subagent assignment MUST include the resolved session workspace path in assignment context.",
							"- TDD Protocol (MANDATORY): for each implementation phase/task, first spawn a prerequisite Task subagent that uses the `test-driven-development` and `qa-test-planner` skills.",
							"- That prerequisite task must read requirements, write failing tests that encode those criteria (RED), and confirm failures are expected.",
							"- The test-writing task should write its test plan to: <session_workspace>/test-plans/<phase-or-task-name>.md",
							"- Only AFTER that RED task completes may you spawn the implementation task, which must make those tests pass (GREEN).",
							"- Exception: pure refactoring where existing tests already cover behavior may skip the prerequisite test task; if skipping, require explicit test coverage evidence in the assignment.",
							"- Exception: research/explore-only tasks and documentation-only tasks do not require prerequisite test tasks.",
							"- Verifier Workflow (MANDATORY): after each spawned batch completes, spawn parallel verifiers (one per completed implementation task).",
							"- Verifier checks MUST cover: lint passed on modified files, tests exist and pass, and success criteria are met.",
							"- The verifier agent should write its verification report to: <session_workspace>/verification/<phase-or-task-name>.md",
							"- For each verifier no_go: spawn a targeted fix Task subagent, then re-verify (max 2 remediation loops per task before escalating).",
							"- If a phase is blocked: spawn one remediation Task subagent. Do not fix inline.",
							"- Finish each phase with atomic commits (commit-hygiene skill). Push to origin after each phase.",
							"- After all phases complete: write a 3-5 line summary only.",
						]
					: [
							"Implement the approved plan from @docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md in this worktree.",
							"",
							"Orchestrator execution contract:",
							"- Read ONLY the phase headings from the plan file. Do not read source code files.",
							"- Spawn exactly one Task subagent per phase in strict order.",
							"- Do not parallelize phases. Wait for each Task subagent to complete before the next.",
							"- Session Workspace (MANDATORY):",
							`- All session artifacts (test plans, verification reports, notes) MUST be written under: \`${sessionWorkspaceTemplate}\``,
							"- Determine <type> once per session from the overall goal (feature, fix, refactor, chore, docs).",
							"- Determine <YYYY-MM-DD-slug> once at session start and reuse it across all subagents.",
							"- The FIRST spawned subagent MUST create <session_workspace>/, <session_workspace>/test-plans/, and <session_workspace>/verification/ if missing.",
							"- Every subagent assignment MUST include the resolved session workspace path in assignment context.",
							"- TDD Protocol (MANDATORY): before each phase implementation task, spawn a prerequisite Task subagent that uses `test-driven-development` and `qa-test-planner` and writes failing tests from the phase success criteria (RED).",
							"- Require the prerequisite task to confirm failures are for missing behavior, not test/harness errors.",
							"- The test-writing task should write its test plan to: <session_workspace>/test-plans/<phase-or-task-name>.md",
							"- Spawn the phase implementation task only after RED completion; it must make those tests pass (GREEN).",
							"- Exception: pure refactoring where existing tests already cover that phase's success criteria may skip the prerequisite test task, and the assignment must cite those tests.",
							"- Exception: research/discovery-only and documentation-only phases do not require prerequisite RED tasks.",
							'- Verifier Workflow (MANDATORY): after each phase\'s task(s) complete, spawn: task(agent="verifier", assignment="Verify phase N: [success criteria]. Check: (1) lint passed on modified files, (2) tests exist and pass, (3) success criteria met. Modified files: [list from task result]. Write verification report to: <session_workspace>/verification/<phase-or-task-name>.md"). The `qa-test-planner` skill is auto-injected.',
							'- If verifier verdict is "no_go": spawn a targeted fix task, then re-verify. Max 2 remediation loops per phase before escalating.',
							"- If a phase is blocked: spawn one remediation Task subagent. Do not patch inline.",
							"- Keep plan-scoped artifacts in the plan workspace directory.",
							"- Apply commit-hygiene skill per phase. Commit titles: Conventional Commit + one emoji.",
							"- Finish each phase with atomic commits scoped to that phase only. Push to origin.",
							"- Stop immediately on unrecoverable failure and report.",
						].join("\n");

				ctx.ui.setEditorText(manualKickoffTemplate);
				ctx.ui.notify(
					"Worktree ready in a new session. Attach your plan file with @ and submit to start implementation.",
					"info",
				);
				pi.sendMessage({
					customType: "implement-manual/ready",
					content: [
						"## Manual implement mode ready",
						"",
						"No /plan-new metadata was found in this session, so automatic kickoff was skipped.",
						"Attach your existing plan doc (for example: @docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md) and submit when ready.",
					].join("\n"),
					display: true,
					details: { mode: "manual" },
				});
				return;
			}

			if (!planMetadata) {
				throw new Error(
					"plan metadata missing for automatic implement kickoff",
				);
			}

			const kickoffPrompt = buildImplementationKickoffPrompt({
				planFilePath: planMetadata.planFilePath,
				metadataEntryId: planMetadata.entryId,
				metadataTimestamp: planMetadata.timestamp,
				resolvedPlanPath: resolvedPlanPath ?? planMetadata.planFilePath,
				planWorkspaceDir:
					planWorkspaceDir ??
					getPlanWorkspaceDir(resolvedPlanPath ?? planMetadata.planFilePath),
				phases,
				worktreePath: last.worktreePath,
				branchName: last.branchName,
				baseBranch: last.baseBranch,
				repoRoot: last.repoRoot,
				additionalInstructions: additionalInstructions?.trim(),
			});

			pi.sendUserMessage(kickoffPrompt);
			ctx.ui.notify(
				"Implementation kickoff sent to orchestrator agent in a new session",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: implement failed", { error: msg });
			ctx.ui.notify(`implement failed: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(IMPLEMENT_PROGRESS_STATUS_KEY, undefined);
		}
	};

	const launchReviewComplete = async (
		ctx: ExtensionCommandContext,
		args?: string,
	) => {
		if (!ctx.hasUI) return;

		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Wait for the current run to finish before starting review",
				"warning",
			);
			return;
		}



		const manualPlanPathArg = parseReviewCompleteManualPlanPath(args ?? "");
		const planMetadata = findLatestPlanMetadata(ctx);
		const persistedPlanPath = last.planFilePath?.trim();
		const preferredPlanPath =
			persistedPlanPath && persistedPlanPath.length > 0
				? persistedPlanPath
				: undefined;

		const hasWorktreeContext = Boolean(
			last.worktreePath && last.branchName && last.baseBranch,
		);

		let resolvedPlanPath: string;
		let planContent: string;
		let displayPlanMetadataPath: string;
		let metadataEntryId: string;
		let metadataTimestamp: string;
		let selectedPlanReferenceForError =
			manualPlanPathArg ??
			preferredPlanPath ??
			planMetadata?.planFilePath ??
			"unknown";
		const pickerRoot = normalizePath(ctx.sessionManager.getCwd());
		const resolveReviewPickerRoot = (): string => pickerRoot;
		try {
			if (manualPlanPathArg) {
				resolvedPlanPath = resolvePlanFilePath(
					manualPlanPathArg,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = manualPlanPathArg;
				metadataEntryId = "(manual-review-input)";
				metadataTimestamp = "(manual)";
				selectedPlanReferenceForError = manualPlanPathArg;
			} else if (preferredPlanPath) {
				resolvedPlanPath = normalizePath(preferredPlanPath);
				displayPlanMetadataPath = preferredPlanPath;
				metadataEntryId = "(persisted-workflow-plan)";
				metadataTimestamp = "(persisted)";
				selectedPlanReferenceForError = preferredPlanPath;
			} else if (planMetadata) {
				resolvedPlanPath = resolvePlanFilePath(
					planMetadata.planFilePath,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = planMetadata.planFilePath;
				metadataEntryId = planMetadata.entryId;
				metadataTimestamp = planMetadata.timestamp;
				selectedPlanReferenceForError = planMetadata.planFilePath;
			} else {
				// Try popup file picker first (tmux), fall back to text input
				const pickedPath = await showPlanFilePicker(
					await resolveReviewPickerRoot(),
					"Select Plan File for Review",
				);
				const manualInput =
					pickedPath ??
					(await ctx.ui.input(
						"Enter plan file path for review (example: .omp/sessions/plans/<type>/<YYYY-MM-DD-slug>/<plan>.md)",
						".omp/sessions/plans/",
					));
				const manualFromPrompt = parseReviewCompleteManualPlanPath(
					manualInput ?? "",
				);
				if (!manualFromPrompt) {
					ctx.ui.notify(
						"No plan file selected. Use /review-complete @.omp/sessions/plans/<type>/<YYYY-MM-DD-slug>/<plan>.md",
						"error",
					);
					return;
				}

				resolvedPlanPath = resolvePlanFilePath(
					manualFromPrompt,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = manualFromPrompt;
				metadataEntryId = "(manual-review-input)";
				metadataTimestamp = "(manual)";
				selectedPlanReferenceForError = manualFromPrompt;
			}

			if (!isMarkdownPlanPath(resolvedPlanPath)) {
				throw new Error(linkedPlanPathValidationErrorText());
			}
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`Unable to read review plan file (${selectedPlanReferenceForError}): ${msg}`,
				"error",
			);
			return;
		}

		let phases = extractPlanPhases(planContent);
		let normalizationFallback:
			| {
					originalResolvedPlanPath: string;
					sourcePhaseHeadings: LegacyPhaseHeading[];
			  }
			| undefined;
		if (phases.length === 0) {
			const sourcePhaseHeadings = extractLegacyPhaseHeadings(planContent);
			if (sourcePhaseHeadings.length === 0) {
				ctx.ui.notify(
					"Plan file does not contain 'Phase N' sections. Review requires phased plan format.",
					"error",
				);
				return;
			}

			const originalResolvedPlanPath = resolvedPlanPath;
			resolvedPlanPath = await allocateNormalizedReviewPlanPath(
				originalResolvedPlanPath,
			);
			phases = buildNormalizedReviewPhases(sourcePhaseHeadings);
			normalizationFallback = { originalResolvedPlanPath, sourcePhaseHeadings };
			ctx.ui.notify(
				"Plan headings are not strict Phase N. Review will normalize to a new copy before verification.",
				"warning",
			);
		}

		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const planWorkspaceDir = getPlanWorkspaceDir(resolvedPlanPath);
		last.planFilePath = resolvedPlanPath;
		last.planWorkspaceDir = planWorkspaceDir;
		const reviewState: PersistedWorktreeState | undefined = hasWorktreeContext
			? {
				baseBranch: last.baseBranch!,
				branchName: last.branchName!,
				worktreePath: last.worktreePath!,
				repoRoot: last.repoRoot,
				planFilePath: resolvedPlanPath,
				planWorkspaceDir,
				actionButtonStage: "fix-issues",
				updatedAt: Date.now(),
			}
			: undefined;

		ctx.ui.setStatus(
			REVIEW_COMPLETE_PROGRESS_STATUS_KEY,
			"review-complete: starting review session...",
		);

		try {
			const created = await ctx.newSession({
				parentSession: parentSessionFile,
				setup: async (sessionManager) => {
					if (reviewState) {
						sessionManager.appendCustomEntry(
							PERSISTED_WORKTREE_STATE_TYPE,
							reviewState,
						);
					}
					sessionManager.appendCustomEntry(PERSISTED_PLAN_METADATA_TYPE, {
						planFilePath: resolvedPlanPath,
						updatedAt: Date.now(),
					});
				},
			});

			if (created.cancelled) {
				ctx.ui.notify("Review cancelled", "warning");
				return;
			}

			if (reviewState) {
				const restored = await tryRestoreWorktreeState(ctx);
				if (!restored) {
					const worktreePath = normalizePath(reviewState.worktreePath);
					const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
					if (!gitExists) {
						ctx.ui.notify(
							"Review session created, but failed to restore worktree context",
							"error",
						);
						return;
					}

					process.chdir(worktreePath);
					last = {
						baseBranch: reviewState.baseBranch,
						branchName: reviewState.branchName,
						worktreePath,
						repoRoot: reviewState.repoRoot,
						planFilePath: reviewState.planFilePath,
						planWorkspaceDir: reviewState.planWorkspaceDir,
					};
					setupDone = true;
				}

				await ensurePinnedToWorktree();
				await ensureOrchestratorRuntimeDefaults(ctx);
				setActionButton(ctx, "fix-issues");
				persistWorktreeState();
			} else {
				setupDone = false;
				last = {
					planFilePath: resolvedPlanPath,
					planWorkspaceDir,
				};
				await ensureOrchestratorRuntimeDefaults(ctx);
				setActionButton(ctx, "fix-issues");
			}
			const kickoffPrompt = normalizationFallback
				? buildReviewCompleteNormalizationKickoffPrompt({
						planFilePath: displayPlanMetadataPath,
						metadataEntryId,
						metadataTimestamp,
						originalResolvedPlanPath:
							normalizationFallback.originalResolvedPlanPath,
						resolvedPlanPath,
						planWorkspaceDir,
						phases,
						sourcePhaseHeadings: normalizationFallback.sourcePhaseHeadings,
						worktreePath: last.worktreePath,
						branchName: last.branchName,
						baseBranch: last.baseBranch,
					})
				: buildReviewCompleteKickoffPrompt({
						planFilePath: displayPlanMetadataPath,
						metadataEntryId,
						metadataTimestamp,
						resolvedPlanPath,
						planWorkspaceDir,
						phases,
						worktreePath: last.worktreePath,
						branchName: last.branchName,
						baseBranch: last.baseBranch,
					});

			pi.sendUserMessage(kickoffPrompt);
			ctx.ui.notify(
				"Review kickoff sent to orchestrator agent in a new session",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: review-complete failed", { error: msg });
			ctx.ui.notify(`review-complete failed: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(REVIEW_COMPLETE_PROGRESS_STATUS_KEY, undefined);
		}
	};

	const launchFixIssues = async (
		ctx: ExtensionCommandContext,
		args?: string,
	) => {
		if (!ctx.hasUI) return;

		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Wait for the current run to finish before starting issue remediation",
				"warning",
			);
			return;
		}
		const findings = findLatestAssistantReviewFindings(ctx);
		if (!findings) {
			ctx.ui.notify(
				"Could not find a review report in this session. Run a review and wait for the final report first.",
				"error",
			);
			return;
		}
		const manualPlanPathArg = parseReviewCompleteManualPlanPath(args ?? "");
		const planMetadata = findLatestPlanMetadata(ctx);
		const persistedPlanPath = last.planFilePath?.trim();
		const preferredPlanPath =
			persistedPlanPath && persistedPlanPath.length > 0
				? persistedPlanPath
				: undefined;

		let resolvedPlanPath: string;
		let planContent: string;
		let displayPlanMetadataPath: string;
		let metadataEntryId: string;
		let metadataTimestamp: string;
		let selectedPlanReferenceForError =
			manualPlanPathArg ??
			preferredPlanPath ??
			planMetadata?.planFilePath ??
			"unknown";
		try {
			if (manualPlanPathArg) {
				resolvedPlanPath = resolvePlanFilePath(
					manualPlanPathArg,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = manualPlanPathArg;
				metadataEntryId = "(manual-fix-input)";
				metadataTimestamp = "(manual)";
				selectedPlanReferenceForError = manualPlanPathArg;
			} else if (preferredPlanPath) {
				resolvedPlanPath = normalizePath(preferredPlanPath);
				displayPlanMetadataPath = preferredPlanPath;
				metadataEntryId = "(persisted-workflow-plan)";
				metadataTimestamp = "(persisted)";
				selectedPlanReferenceForError = preferredPlanPath;
			} else if (planMetadata) {
				resolvedPlanPath = resolvePlanFilePath(
					planMetadata.planFilePath,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = planMetadata.planFilePath;
				metadataEntryId = planMetadata.entryId;
				metadataTimestamp = planMetadata.timestamp;
				selectedPlanReferenceForError = planMetadata.planFilePath;
			} else {
				// Try popup file picker first (tmux), fall back to text input
				const pickedPath = await showPlanFilePicker(
					normalizePath(ctx.sessionManager.getCwd()),
					"Select Plan File for Fix Issues",
				);
				const manualInput =
					pickedPath ??
					(await ctx.ui.input(
						"Enter plan file path for issue remediation (example: .omp/sessions/plans/<type>/<YYYY-MM-DD-slug>/<plan>.md)",
						".omp/sessions/plans/",
					));
				const manualFromPrompt = parseReviewCompleteManualPlanPath(
					manualInput ?? "",
				);
				if (!manualFromPrompt) {
					ctx.ui.notify(
						"No plan file selected. Use /fix-issues @.omp/sessions/plans/<type>/<YYYY-MM-DD-slug>/<plan>.md",
						"error",
					);
					return;
				}

				resolvedPlanPath = resolvePlanFilePath(
					manualFromPrompt,
					ctx.sessionManager.getCwd(),
				);
				displayPlanMetadataPath = manualFromPrompt;
				metadataEntryId = "(manual-fix-input)";
				metadataTimestamp = "(manual)";
				selectedPlanReferenceForError = manualFromPrompt;
			}

			if (!isMarkdownPlanPath(resolvedPlanPath)) {
				throw new Error(linkedPlanPathValidationErrorText());
			}
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`Unable to read remediation plan file (${selectedPlanReferenceForError}): ${msg}`,
				"error",
			);
			return;
		}

		const phases = extractPlanPhases(planContent);
		if (phases.length === 0) {
			ctx.ui.notify(
				"Plan file does not contain 'Phase N' sections. Fix Issues requires phased plan format.",
				"error",
			);
			return;
		}

		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const planWorkspaceDir = getPlanWorkspaceDir(resolvedPlanPath);
		last.planFilePath = resolvedPlanPath;
		last.planWorkspaceDir = planWorkspaceDir;
		const hasFixWorktreeContext = Boolean(
			last.worktreePath && last.branchName && last.baseBranch,
		);

		// Best-effort: derive git context when no worktree is active
		if (!hasFixWorktreeContext) {
			const gitInfo = await findGitRoot(process.cwd());
			if (gitInfo) {
				if (gitInfo.isWorktree) {
					const wtInfo = await deriveWorktreeInfo(gitInfo.root);
					if (wtInfo) {
						last.worktreePath = gitInfo.root;
						last.branchName = wtInfo.branchName;
						last.baseBranch = wtInfo.baseBranch;
						last.repoRoot = wtInfo.repoRoot;
						setupDone = true;
					}
				}
				if (!last.branchName) {
					try {
						const branchProc = Bun.spawn(
							["git", "branch", "--show-current"],
							{ cwd: gitInfo.root, stdout: "pipe", stderr: "pipe" },
						);
						const branchName = (
							await new Response(branchProc.stdout).text()
						).trim();
						await branchProc.exited;
						if (branchName) {
							last.worktreePath = gitInfo.root;
							last.branchName = branchName;
							last.baseBranch = branchName;
							last.repoRoot = gitInfo.root;
							setupDone = true;
						}
					} catch {
						// Git not available — proceed without context
					}
				}
			}
		}

		const hasResolvedWorktreeContext = Boolean(
			last.worktreePath && last.branchName && last.baseBranch,
		);
		const fixState: PersistedWorktreeState | undefined =
			hasResolvedWorktreeContext
				? {
						baseBranch: last.baseBranch!,
						branchName: last.branchName!,
						worktreePath: last.worktreePath!,
						repoRoot: last.repoRoot,
						planFilePath: resolvedPlanPath,
						planWorkspaceDir,
						actionButtonStage: "fix-issues",
						updatedAt: Date.now(),
					}
				: undefined;

		ctx.ui.setStatus(
			FIX_ISSUES_PROGRESS_STATUS_KEY,
			"fix-issues: starting remediation session...",
		);

		try {
			const created = await ctx.newSession({
				parentSession: parentSessionFile,
				setup: async (sessionManager) => {
					if (fixState) {
						sessionManager.appendCustomEntry(
							PERSISTED_WORKTREE_STATE_TYPE,
							fixState,
						);
					}
					sessionManager.appendCustomEntry(PERSISTED_PLAN_METADATA_TYPE, {
						planFilePath: resolvedPlanPath,
						updatedAt: Date.now(),
					});
					sessionManager.appendCustomEntry(PERSISTED_REVIEW_FINDINGS_TYPE, {
						sourceEntryId: findings.entryId,
						sourceTimestamp: findings.timestamp,
						content: findings.content,
						updatedAt: Date.now(),
					});
				},
			});

			if (created.cancelled) {
				ctx.ui.notify("Fix Issues cancelled", "warning");
				return;
			}

			if (fixState) {
				const restored = await tryRestoreWorktreeState(ctx);
				if (!restored) {
					const worktreePath = normalizePath(fixState.worktreePath);
					const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
					if (!gitExists) {
						ctx.ui.notify(
							"Fix Issues session created, but failed to restore worktree context",
							"error",
						);
						return;
					}

					process.chdir(worktreePath);
					last = {
						baseBranch: fixState.baseBranch,
						branchName: fixState.branchName,
						worktreePath,
						repoRoot: fixState.repoRoot,
						planFilePath: fixState.planFilePath,
						planWorkspaceDir: fixState.planWorkspaceDir,
					};
					setupDone = true;
				}

				await ensurePinnedToWorktree();
				await ensureOrchestratorRuntimeDefaults(ctx);
				setActionButton(ctx, "fix-issues");
				persistWorktreeState();
			} else {
				last = {
					planFilePath: resolvedPlanPath,
					planWorkspaceDir,
				};
				await ensureOrchestratorRuntimeDefaults(ctx);
				setActionButton(ctx, "fix-issues");
			}

			const kickoffPrompt = buildFixIssuesKickoffPrompt({
				planFilePath: displayPlanMetadataPath,
				metadataEntryId,
				metadataTimestamp,
				resolvedPlanPath,
				planWorkspaceDir,
				phases,
				worktreePath: last.worktreePath,
				branchName: last.branchName,
				baseBranch: last.baseBranch,
				reviewFindingsEntryId: findings.entryId,
				reviewFindingsTimestamp: findings.timestamp,
				reviewFindings: findings.content,
			});

			pi.sendUserMessage(kickoffPrompt);
			ctx.ui.notify(
				"Fix Issues kickoff sent to orchestrator agent in a new session",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: fix-issues failed", { error: msg });
			ctx.ui.notify(`fix-issues failed: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(FIX_ISSUES_PROGRESS_STATUS_KEY, undefined);
		}
	};

	const launchUpdateVersion = async (
		ctx: ExtensionCommandContext,
		args?: string,
	) => {
		if (!ctx.hasUI) return;

		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Wait for the current run to finish before starting version update",
				"warning",
			);
			return;
		}

		if (actionButtonStage !== "update-version") {
			if (actionButtonStage === "fix-issues") {
				const findings = findLatestAssistantReviewFindings(ctx);
				if (!findings) {
					ctx.ui.notify(
						"Update Version can run after Fix Issues, or after a clean review report with zero Critical/Severe/Major findings.",
						"warning",
					);
					return;
				}
				if (!reviewFindingsIncludeCodeRabbitGate(findings.content)) {
					ctx.ui.notify(
						"Latest review report is missing CodeRabbit gate evidence. Re-run /review-complete and include CodeRabbit Critical/Severe/Major results.",
						"error",
					);
					return;
				}
				if (reviewFindingsHaveBlockingCodeRabbitIssues(findings.content)) {
					ctx.ui.notify(
						"Update Version is blocked by review findings. Run Fix Issues before updating version.",
						"warning",
					);
					return;
				}
				ctx.ui.notify(
					"Review reported zero Critical/Severe/Major findings. Proceeding to Update Version without remediation.",
					"info",
				);
			} else {
				ctx.ui.notify(
					"Update Version is available after Fix Issues launches remediation, or after a clean review report with zero Critical/Severe/Major findings.",
					"warning",
				);
				return;
			}
		}

		if (
			!setupDone ||
			!last.worktreePath ||
			!last.branchName ||
			!last.baseBranch
		) {
			ctx.ui.notify(
				"No active implementation worktree found for version update",
				"warning",
			);
			return;
		}

		const requestedBump = args?.trim() ?? "";
		if (
			requestedBump &&
			requestedBump !== "patch" &&
			requestedBump !== "minor" &&
			requestedBump !== "major"
		) {
			ctx.ui.notify(
				"Usage: /update-version-workflow [patch|minor|major]",
				"warning",
			);
			return;
		}

		const activeWorktreePath = normalizePath(last.worktreePath);
		pendingUpdateVersionFinalize = false;

		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const updateState: PersistedWorktreeState = {
			baseBranch: last.baseBranch,
			branchName: last.branchName,
			worktreePath: activeWorktreePath,
			repoRoot: last.repoRoot,
			planFilePath: last.planFilePath,
			planWorkspaceDir: last.planWorkspaceDir,
			actionButtonStage: "update-version",
			updatedAt: Date.now(),
		};

		ctx.ui.setStatus(
			UPDATE_VERSION_PROGRESS_STATUS_KEY,
			"update-version: starting dedicated version session...",
		);

		try {
			await ensurePinnedToWorktree();

			const dirty = await runAllowFail(
				["git", "status", "--porcelain"],
				activeWorktreePath,
			);
			if (dirty.code !== 0) {
				throw new Error(
					(dirty.stderr || dirty.stdout).trim() || "failed to read git status",
				);
			}
			if (dirty.stdout.trim()) {
				ctx.ui.notify(
					"Update Version requires a clean worktree (no staged/unstaged/untracked files). Commit and push first.",
					"error",
				);
				return;
			}

			const upstream = await runAllowFail(
				[
					"git",
					"rev-parse",
					"--abbrev-ref",
					"--symbolic-full-name",
					"@{upstream}",
				],
				activeWorktreePath,
			);
			if (upstream.code !== 0 || !upstream.stdout.trim()) {
				ctx.ui.notify(
					"Update Version requires an upstream tracking branch. Push with --set-upstream first.",
					"error",
				);
				return;
			}

			const syncState = await runAllowFail(
				["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
				activeWorktreePath,
			);
			if (syncState.code !== 0) {
				throw new Error(
					(syncState.stderr || syncState.stdout).trim() ||
						"failed to inspect upstream sync state",
				);
			}
			const match = syncState.stdout.trim().match(/^(\d+)\s+(\d+)$/);
			if (!match) {
				throw new Error(
					`unexpected upstream sync output: ${syncState.stdout.trim()}`,
				);
			}
			const behindCount = Number.parseInt(match[1] ?? "0", 10);
			const aheadCount = Number.parseInt(match[2] ?? "0", 10);
			if (behindCount > 0 || aheadCount > 0) {
				ctx.ui.notify(
					`Update Version requires branch synced with upstream (behind ${behindCount}, ahead ${aheadCount}). Pull/rebase/push first.`,
					"error",
				);
				return;
			}

			const created = await ctx.newSession({
				parentSession: parentSessionFile,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(
						PERSISTED_WORKTREE_STATE_TYPE,
						updateState,
					);
					if (updateState.planFilePath) {
						sessionManager.appendCustomEntry(PERSISTED_PLAN_METADATA_TYPE, {
							planFilePath: updateState.planFilePath,
							updatedAt: Date.now(),
						});
					}
				},
			});

			if (created.cancelled) {
				ctx.ui.notify("Update Version cancelled", "warning");
				return;
			}

			const restored = await tryRestoreWorktreeState(ctx);
			if (!restored) {
				const worktreePath = normalizePath(updateState.worktreePath);
				const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
				if (!gitExists) {
					ctx.ui.notify(
						"Update Version session created, but failed to restore worktree context",
						"error",
					);
					return;
				}

				process.chdir(worktreePath);
				last = {
					baseBranch: updateState.baseBranch,
					branchName: updateState.branchName,
					worktreePath,
					repoRoot: updateState.repoRoot,
					planFilePath: updateState.planFilePath,
					planWorkspaceDir: updateState.planWorkspaceDir,
				};
				setupDone = true;
			}

			await ensurePinnedToWorktree();
			await ensureDefaultRuntimeDefaults(ctx);
			setActionButton(ctx, "update-version");
			persistWorktreeState();
			pendingUpdateVersionFinalize = true;

			const versionCommand = requestedBump
				? `/update-version ${requestedBump}`
				: "/update-version";
			pi.sendUserMessage(versionCommand);
			ctx.ui.notify(
				"Update Version kickoff sent to default agent in a new session",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pendingUpdateVersionFinalize = false;
			pi.logger.error("plan-worktree: update-version-workflow failed", {
				error: msg,
			});
			ctx.ui.notify(`update-version-workflow failed: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(UPDATE_VERSION_PROGRESS_STATUS_KEY, undefined);
		}
	};

	const finalizeUpdateVersionRun = async (ctx: ExtensionContext) => {
		if (!last.worktreePath || !last.branchName) return;
		const worktreePath = normalizePath(last.worktreePath);
		const branchName = last.branchName;

		if (ctx.hasUI) {
			ctx.ui.setStatus(
				UPDATE_VERSION_PROGRESS_STATUS_KEY,
				"update-version: finalizing commit + push...",
			);
		}

		try {
			await ensurePinnedToWorktree();

			const beforeStatus = await runAllowFail(
				["git", "status", "--porcelain"],
				worktreePath,
			);
			if (beforeStatus.code !== 0) {
				throw new Error(
					(beforeStatus.stderr || beforeStatus.stdout).trim() ||
						"failed to read git status",
				);
			}

			if (beforeStatus.stdout.trim()) {
				const add = await runAllowFail(
					["git", "add", ...UPDATE_VERSION_COMMIT_FILES],
					worktreePath,
				);
				if (add.code !== 0) {
					throw new Error(
						(add.stderr || add.stdout).trim() ||
							"failed to stage release files",
					);
				}

				const version = await readWorkspaceVersion(worktreePath);
				const commitMessage = version
					? `chore(release): bump version to ${version}`
					: "chore(release): bump version";

				const commit = await runAllowFail(
					["git", "commit", "-m", commitMessage],
					worktreePath,
				);
				if (commit.code !== 0) {
					throw new Error(
						(commit.stderr || commit.stdout).trim() ||
							"failed to commit release files",
					);
				}
			}

			const push = await runAllowFail(
				["git", "push", "--set-upstream", "origin", branchName],
				worktreePath,
				120_000,
			);
			if (push.code !== 0) {
				throw new Error(
					(push.stderr || push.stdout).trim() ||
						"failed to push release commit",
				);
			}

			const afterStatus = await runAllowFail(
				["git", "status", "--porcelain"],
				worktreePath,
			);
			if (afterStatus.code !== 0) {
				throw new Error(
					(afterStatus.stderr || afterStatus.stdout).trim() ||
						"failed to verify git status",
				);
			}
			if (afterStatus.stdout.trim()) {
				throw new Error(
					"version workflow left uncommitted files after finalize",
				);
			}

			const syncState = await runAllowFail(
				["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
				worktreePath,
			);
			if (syncState.code !== 0) {
				throw new Error(
					(syncState.stderr || syncState.stdout).trim() ||
						"failed to verify upstream sync",
				);
			}
			const match = syncState.stdout.trim().match(/^(\d+)\s+(\d+)$/);
			if (!match) {
				throw new Error(
					`unexpected upstream sync output: ${syncState.stdout.trim()}`,
				);
			}
			const behindCount = Number.parseInt(match[1] ?? "0", 10);
			const aheadCount = Number.parseInt(match[2] ?? "0", 10);
			if (behindCount > 0 || aheadCount > 0) {
				throw new Error(
					`branch not synced after finalize (behind ${behindCount}, ahead ${aheadCount})`,
				);
			}

			setActionButton(ctx, "submit-pr");
			persistWorktreeState();
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Update Version finished with commit + push. Submit PR is ready.",
					"info",
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setActionButton(ctx, "update-version");
			persistWorktreeState();
			pi.logger.error("plan-worktree: update-version finalize failed", {
				error: msg,
				branchName,
				worktreePath,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`Update Version finalize failed: ${msg}`, "error");
			}
		} finally {
			if (ctx.hasUI) {
				ctx.ui.setStatus(UPDATE_VERSION_PROGRESS_STATUS_KEY, undefined);
			}
		}
	};

	const getWorktreePrompt = () => {
		if (!last.worktreePath) return "";
		const branchLabel = last.branchName ?? "(unknown)";
		const baseLabel = last.baseBranch ?? "(unknown)";
		const planPathLine = last.planFilePath
			? `- **Plan file:** \`${last.planFilePath}\`\n`
			: "";
		const planWorkspaceLine = last.planWorkspaceDir
			? `- **Plan workspace:** \`${last.planWorkspaceDir}\`\n`
			: "";
		return (
			`\n\n## Worktree Active\n` +
			`You are now working inside a git worktree.\n` +
			`- **Branch:** \`${branchLabel}\` (based on \`${baseLabel}\`)\n` +
			`- **Path:** \`${last.worktreePath}\`\n` +
			planPathLine +
			planWorkspaceLine +
			`All relative paths resolve against this worktree. ` +
			`Do NOT reference the original repo path. ` +
			`For file-edit tools (edit/write/notebook), only use paths inside the worktree path above.\n`
		);
	};

	const isOrchestratorParentMode = () =>
		setupDone && !!last.worktreePath && actionButtonStage !== "update-version";
	const SUBAGENT_SUBMIT_RESULT_CONTRACT_RE =
		/(?:\*\*)?MUST(?:\*\*)?\s+call\s+`submit_result`(?:\s+tool)?(?:\s+exactly\s+once)?/i;
	const SUBAGENT_ROLE_MARKER_RE = /<role>[^<]*(?:subagent|worker\s+subagent)/i;
	const SUBAGENT_JOB_MARKER_RE = /operating on a delegated sub-task/i;
	const SUBAGENT_ACTING_AS_MARKER_RE = /═══════════Acting as═══════════/i;
	const SUBAGENT_ASSIGNMENT_PROMPT_RE = /your assignment is below\./i;
	const SUBAGENT_BACKGROUND_PROMPT_RE = /═══════════Background═══════════/i;
	const isSubagentTurn = (systemPrompt: string, prompt?: string): boolean => {
		const fromSystemPrompt = Boolean(systemPrompt) &&
			(SUBAGENT_SUBMIT_RESULT_CONTRACT_RE.test(systemPrompt) ||
				SUBAGENT_ROLE_MARKER_RE.test(systemPrompt) ||
				SUBAGENT_JOB_MARKER_RE.test(systemPrompt) ||
				SUBAGENT_ACTING_AS_MARKER_RE.test(systemPrompt));
		if (fromSystemPrompt) return true;
		if (!prompt) return false;
		return (
			SUBAGENT_ASSIGNMENT_PROMPT_RE.test(prompt) ||
			SUBAGENT_BACKGROUND_PROMPT_RE.test(prompt)
		);
	};

	const getOrchestratorPrompt = () => {
		if (!isOrchestratorParentMode() || !setupDone || !last.worktreePath)
			return "";
		const sessionWorkspaceTemplate = getSessionWorkspaceTemplate(last.repoRoot);
		return [
			"",
			"## ORCHESTRATOR MODE — READ BEFORE EVERY RESPONSE",
			"",
			"<critical>",
			"You are COORDINATION-ONLY. You do NOT write code, run non-guarded commands, or implement anything.",
			"Every implementation action is delegated to a Task subagent. No exceptions.",
			"Direct parent reading is capped at 5 files per user input and only when strictly needed for decomposition.",
			"After the read cap is reached, all additional discovery MUST be delegated to Task subagents (prefer explore for reconnaissance).",
			"</critical>",
			"",
			"FORBIDDEN (tools are blocked and these are hard logical prohibitions):",
			"- Writing, editing, or creating any file — use Task subagents for this",
			"- Running parent-side research tools beyond the capped read budget",
			"- Running bash/shell for anything except `git status` on the worktree",
			"- Providing code snippets or implementation details in your response text",
			"- Using any MCP server tools from the parent turn",
			"",
			"## Your only job: Understand → Decompose → Delegate → Report",
			"",
			"State tracking (MANDATORY):",
			"- Use `todo_write` from kickoff to completion so the user can always see live progress.",
			"- Create/update todos before first delegation, after every phase result, and whenever blockers/remediation appear.",
			"- Keep exactly one todo in_progress; mark items completed immediately when done.",
			"",
			"Session Workspace (MANDATORY):",
			`- All session artifacts (test plans, verification reports, notes) MUST be written under: \`${sessionWorkspaceTemplate}\``,
			"- Determine <type> once at session start based on the overall session goal (feature, fix, refactor, chore, docs).",
			"- Determine <YYYY-MM-DD-slug> once at session start and reuse it for the full session.",
			"- The FIRST spawned subagent in the session MUST create <session_workspace>/, <session_workspace>/test-plans/, and <session_workspace>/verification/ if they do not exist.",
			"- Every Task subagent assignment MUST include the resolved session workspace path in assignment context.",
			"",
			"TDD Protocol (MANDATORY):",
			"- For every implementation task, you MUST first spawn a prerequisite task before the implementation task.",
			"- The prerequisite test task must: read success criteria/requirements, write failing tests that encode those criteria (RED phase), and confirm those tests fail for the right reasons.",
			"- The prerequisite test task SHOULD use the `test-driven-development` and `qa-test-planner` skills.",
			"- Include the resolved session workspace path in each prerequisite test-task assignment context.",
			"- The test-writing task should write its test plan to: <session_workspace>/test-plans/<phase-or-task-name>.md",
			"- Only AFTER the test task completes do you spawn the implementation task.",
			"- The implementation task MUST make those tests pass (GREEN phase).",
			"- Planned work: apply this sequence for each plan phase before phase implementation begins.",
			"- Ad hoc work: apply the same sequence for each decomposed implementation task.",
			"- You may skip the prerequisite test-task only when existing tests already cover the success criteria; if skipped, cite the covering tests.",
			"- Exception: research/explore-only tasks do not require prerequisite test tasks.",
			"- Exception: documentation-only tasks do not require prerequisite test tasks.",
			"",
			"Verifier Workflow (MANDATORY):",
			"- After implementation tasks complete, you MUST spawn a verifier agent to validate the work. The `qa-test-planner` skill is auto-injected for verifier agents.",
			"- Verifier checks MUST cover: lint passed on modified files, tests exist and pass, and stated success criteria are met.",
			"- Include the resolved session workspace path in each verifier assignment context.",
			"- The verifier agent should write its verification report to: <session_workspace>/verification/<phase-or-task-name>.md",
			"- Verifier output contract:",
			'  - go: { verdict: "go", summary: "1-2 sentence confirmation" }',
			'  - no_go: { verdict: "no_go", issues: ["itemized failures"], summary: "what failed and why" }',
			"- PLANNED MODE (phases from a plan):",
			'  1. After each phase\'s task(s) complete, spawn: task(agent="verifier", assignment="Verify phase N: [success criteria]. Check: (1) lint passed on modified files, (2) tests exist and pass, (3) success criteria met. Modified files: [list from task result]. Write verification report to: <session_workspace>/verification/<phase-or-task-name>.md"). The `qa-test-planner` skill is auto-injected.',
			'  2. If verdict is "go" -> proceed to next phase',
			'  3. If verdict is "no_go" -> spawn targeted fix task -> re-verify',
			"  4. Max 2 remediation loops per phase. If still no_go -> STOP and report to user",
			"- AD HOC MODE (no plan, direct requests):",
			"  1. After each spawned batch completes, spawn parallel verifiers (one per completed implementation task)",
			"  2. Collect all verdicts",
			"  3. For each no_go -> spawn targeted fix task -> re-verify",
			"  4. Max 2 remediation loops per task. Escalate remaining no_go items to user",
			"",
			"WITH a plan file:",
			"- Read the minimum context needed to sequence phases (typically the plan plus a few key files, never above the cap).",
			"- Create one todo per phase plus verification/closeout tasks, then spawn exactly one Task subagent per phase in strict order.",
			"- Keep each Task assignment tightly scoped: 1-2 file edits/actions maximum. Split broader work into additional Task subagents (parallel when independent).",
			"- If deeper context is required, spawn an `explore` subagent first, then an `implement` implementation subagent.",
			"- Apply the TDD protocol phase-by-phase using each phase's success criteria before phase implementation begins.",
			"",
			"WITHOUT a plan file (freeform or unplanned request):",
			"- Ask clarifying questions via `ask` ONLY when requirements are genuinely unclear; otherwise proceed directly to phased decomposition.",
			"- You may ask additional clarifying questions later only if new ambiguity/blockers appear.",
			"- FIRST response must be ONLY a numbered phase list (2-6 phases). No tool calls, no `todo_write`, and no extra prose in that same response.",
			"- After that first phase-list response, call `todo_write` to create matching tasks, then delegate execution via Task subagents.",
			"- Break freeform work into small Task assignments (1-2 file edits/actions each) and run independent tasks in parallel.",
			"- Apply the same TDD protocol for each ad hoc phase/task derived from user requirements before implementation starts.",
			"- Parent orchestrator must not call direct discovery tools (for example `find`, `grep`, or any `mcp_*` tool). Route all discovery through Task subagents (`explore` for reconnaissance).",
			"",
			"After each Task subagent completes:",
			"- Run `git status --porcelain` in the active worktree before advancing. If dirty, spawn a remediation Task subagent dedicated to commit/push cleanup, then re-check until clean.",
			"- Update `todo_write` first, then continue.",
			"- Confirm each implementation Task that changed files ran its own nested `lint` subagent scoped to those changed paths; missing lint evidence or any lint failure means the phase is BLOCKED until remediated.",
			"- Quality PASSED with clean git status → spawn next phase. One-line response: 'Phase N complete. Starting Phase N+1.'",
			"- BLOCKED → add/update blocker todos, then spawn exactly one remediation Task subagent for that phase. Never patch inline.",
			"- All phases done → complete final todos and write a plain-English summary for the user (5-10 lines max). Explain what changed and what the user will now see or experience differently. No function names, no file paths, no technical jargon. See the AGENTS.md 'Summary & Handoff Format' rules.",
			"",
			"Strict response format:",
			"- Early run: clarifying question(s) only when needed for reliable decomposition, otherwise phase list",
			"- Mid-run: one line per phase status update",
			"- Final: plain-English summary of what changed and what the user will now see (no jargon, no file paths, see AGENTS.md summary rules)",
			"",
			"If you are about to implement, investigate code directly, or run non-task tools:",
			"STOP — wrap that work in a Task subagent assignment instead.",
			"",
		].join("\n");
	};

	const getLastModelChangeRole = (
		ctx: ExtensionContext,
	): string | undefined => {
		try {
			const sessionManager = ctx.sessionManager as {
				getLastModelChangeRole?: () => string | undefined;
				getEntries?: () => Array<{ type?: string; role?: unknown }>;
			};
			const directRole = sessionManager.getLastModelChangeRole?.();
			if (typeof directRole === "string" && directRole.trim().length > 0)
				return directRole;
			const entries = sessionManager.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.type !== "model_change") continue;
				if (typeof entry.role === "string" && entry.role.trim().length > 0) {
					return entry.role;
				}
			}
			return undefined;
		} catch {
			return undefined;
		}
	};
	const syncSessionRoleMarker = (
		ctx: ExtensionContext,
		role: "default" | "orchestrator",
		modelRef: string,
	): void => {
		try {
			const sessionManager = ctx.sessionManager as {
				getLastModelChangeRole?: () => string | undefined;
				appendModelChange?: (model: string, role?: string) => string;
			};
			if (
				!sessionManager?.appendModelChange ||
				!sessionManager?.getLastModelChangeRole
			)
				return;
			const lastRole = sessionManager.getLastModelChangeRole();
			if (lastRole === role) return;
			sessionManager.appendModelChange(modelRef, role);
			pi.logger.debug("plan-worktree: synced session model role marker", {
				role,
				model: modelRef,
				previousRole: lastRole,
			});
		} catch (err) {
			pi.logger.warn(
				"plan-worktree: failed to sync session model role marker",
				{
					error: err instanceof Error ? err.message : String(err),
					role,
					model: modelRef,
				},
			);
		}
	};

	const ensureOrchestratorRuntimeDefaults = async (
		ctx: ExtensionContext,
	): Promise<void> => {
		const roles = await readConfiguredModelRoles();
		const preferred = roles.orchestrator ?? roles.default;
		if (!preferred) return;
		const configuredDefaultRole = roles.default?.trim();
		const roleName: "default" | "orchestrator" = roles.orchestrator
			? "orchestrator"
			: "default";

		// Extract any embedded :thinkingLevel suffix from the model ref
		const { baseRef: preferredBase, thinkingLevel: embeddedLevel } =
			extractThinkingLevelFromRef(preferred);

		const availableModels = ctx.modelRegistry.getAll() as Array<{
			provider: string;
			id: string;
		}>;
		const nextModel = resolveModelReference(availableModels, preferredBase);
		if (!nextModel) {
			if (!missingOrchestratorModelNotified && ctx.hasUI) {
				ctx.ui.notify(
					`Orchestrator model '${preferred}' not found. Falling back to current session model.`,
					"warning",
				);
				missingOrchestratorModelNotified = true;
			}
			return;
		}

		missingOrchestratorModelNotified = false;
		const currentModel = ctx.model;
		const alreadyActive =
			currentModel?.provider === nextModel.provider &&
			currentModel?.id === nextModel.id;
		if (!alreadyActive) {
			const switched = await pi.setModel(
				nextModel as Parameters<typeof pi.setModel>[0],
			);
			if (switched) {
				const orchestratorModelRef = `${nextModel.provider}/${nextModel.id}`;
				const roleMutator = await getSettingsRoleMutator();
				if (roleMutator) {
					try {
						roleMutator.setModelRole("orchestrator", orchestratorModelRef);
						if (
							configuredDefaultRole &&
							configuredDefaultRole !== orchestratorModelRef
						) {
							roleMutator.setModelRole("default", configuredDefaultRole);
						}
					} catch (err) {
						pi.logger.warn(
							"plan-worktree: failed to preserve default model role after orchestrator switch",
							{
								error: err instanceof Error ? err.message : String(err),
							},
						);
					}
				} else if (!missingModelRoleMutatorNotified) {
					pi.logger.warn(
						"plan-worktree: could not load settings mutator; orchestrator model switch may overwrite default model role",
					);
					missingModelRoleMutatorNotified = true;
				}
				pi.logger.debug(
					"plan-worktree: switched parent session to orchestrator model",
					{
						model: orchestratorModelRef,
						preservedDefaultRole: configuredDefaultRole,
					},
				);
			}
		}
		syncSessionRoleMarker(
			ctx,
			roleName,
			`${nextModel.provider}/${nextModel.id}`,
		);

		// Thinking level priority: role JSON > model ref suffix > config defaultThinkingLevel > env override
		const persistedLevels = readModelRoleThinkingLevels();
		const configuredDefaultThinkingLevel =
			await readConfiguredDefaultThinkingLevel();
		const envThinkingLevel = getOrchestratorThinkingLevel();
		const thinkingLevel =
			persistedLevels[roleName] ??
			embeddedLevel ??
			configuredDefaultThinkingLevel ??
			envThinkingLevel;
		if (thinkingLevel) {
			const source = persistedLevels[roleName]
				? "json-file"
				: embeddedLevel
					? "model-ref"
					: configuredDefaultThinkingLevel
						? "config-defaultThinkingLevel"
						: "env";
			pi.setThinkingLevel(thinkingLevel);
			pi.logger.debug("plan-worktree: applied orchestrator thinking level", {
				role: roleName,
				level: thinkingLevel,
				source,
			});
		}
	};

	const ensureDefaultRuntimeDefaults = async (
		ctx: ExtensionContext,
	): Promise<void> => {
		const roles = await readConfiguredModelRoles();
		const preferred = roles.default?.trim();
		if (!preferred) return;

		const { baseRef: preferredBase, thinkingLevel: embeddedLevel } =
			extractThinkingLevelFromRef(preferred);

		const availableModels = ctx.modelRegistry.getAll() as Array<{
			provider: string;
			id: string;
		}>;
		const nextModel = resolveModelReference(availableModels, preferredBase);
		if (!nextModel) {
			if (!missingDefaultModelNotified && ctx.hasUI) {
				ctx.ui.notify(
					`Default model '${preferred}' not found. Falling back to current session model.`,
					"warning",
				);
				missingDefaultModelNotified = true;
			}
			return;
		}

		missingDefaultModelNotified = false;
		const currentModel = ctx.model;
		const alreadyActive =
			currentModel?.provider === nextModel.provider &&
			currentModel?.id === nextModel.id;
		if (!alreadyActive) {
			const switched = await pi.setModel(
				nextModel as Parameters<typeof pi.setModel>[0],
			);
			if (switched) {
				const defaultModelRef = `${nextModel.provider}/${nextModel.id}`;
				pi.logger.debug(
					"plan-worktree: switched parent session to default model",
					{
						model: defaultModelRef,
					},
				);
			}
		}
		syncSessionRoleMarker(
			ctx,
			"default",
			`${nextModel.provider}/${nextModel.id}`,
		);

		// Apply thinking level for default role (JSON file > model ref > config defaultThinkingLevel)
		const persistedLevels = readModelRoleThinkingLevels();
		const configuredDefaultThinkingLevel =
			await readConfiguredDefaultThinkingLevel();
		const thinkingLevel =
			persistedLevels["default"] ??
			embeddedLevel ??
			configuredDefaultThinkingLevel;
		if (thinkingLevel) {
			pi.setThinkingLevel(thinkingLevel);
			pi.logger.debug("plan-worktree: applied default role thinking level", {
				level: thinkingLevel,
				source: persistedLevels["default"]
					? "json-file"
					: embeddedLevel
						? "model-ref"
						: "config-defaultThinkingLevel",
			});
		}
	};

	const setupWorktreeFromTopic = async (
		ctx: ExtensionContext,
		input: WorktreeSetupInput,
	): Promise<
		{ baseBranch: string; branchName: string; worktreePath: string } | undefined
	> => {
		try {
			pi.sendMessage({
				customType: "implement-worktree/pending",
				content:
					"Setting up implementation worktree (base branch + categorized branch)...",
				display: true,
			});

			const repoRoot = await getRepoRoot(pi, ctx.cwd);
			last.repoRoot = repoRoot;
			if (input.planFilePath) {
				const candidatePlanPath = normalizePath(
					path.isAbsolute(input.planFilePath)
						? input.planFilePath
						: path.resolve(repoRoot, input.planFilePath),
				);
				if (isDocsPlanMarkdownPath(candidatePlanPath)) {
					const planExists = await Bun.file(candidatePlanPath).exists();
					if (planExists) {
						last.planFilePath = candidatePlanPath;
						last.planWorkspaceDir = getPlanWorkspaceDir(candidatePlanPath);
					}
				}
			}
			pi.logger.debug("plan-worktree: repo root", { repoRoot });

			const topicSlug = topicToSlug(input.topic || "implement");
			const branchCategory =
				input.categoryOverride ?? (await promptForWorktreeCategory(ctx));
			if (!branchCategory) {
				ctx.ui.notify("Worktree setup cancelled", "warning");
				return;
			}

			let baseBranch = input.baseBranchOverride?.trim();
			if (!baseBranch) {
				const baseOptions = await getBaseBranchOptions(pi, repoRoot);
				const baseChoice = await ctx.ui.select(
					"Which branch should the implementation worktree be based on?",
					baseOptions.options,
				);
				if (!baseChoice) {
					ctx.ui.notify("Worktree setup cancelled", "warning");
					return;
				}

				baseBranch =
					baseChoice === OTHER_CHOICE
						? await ctx.ui.input(
								"Enter base branch name:",
								baseOptions.recommended,
							)
						: baseChoice;
				baseBranch = baseBranch?.trim();
			}
			if (!baseBranch) {
				ctx.ui.notify("Worktree setup cancelled", "warning");
				return;
			}

			const branchNameCandidates = buildBranchNameCandidates({
				planFilePath: input.planFilePath,
				topicSlug,
			});
			let rawBranchNamePart = input.branchNameOverride?.trim();
			if (!rawBranchNamePart) {
				const nameChoice = await ctx.ui.select(
					`Select ${branchCategory.prefix} worktree name (will be created from ${baseBranch})`,
					[...branchNameCandidates, OTHER_CHOICE],
				);
				if (!nameChoice) {
					ctx.ui.notify("Worktree setup cancelled", "warning");
					return;
				}

				rawBranchNamePart =
					nameChoice === OTHER_CHOICE
						? await ctx.ui.input(
								`Enter worktree name (without '${branchCategory.prefix}')`,
								branchNameCandidates[0] ?? topicSlug,
							)
						: nameChoice;
				rawBranchNamePart = rawBranchNamePart?.trim();
			}
			if (!rawBranchNamePart) {
				ctx.ui.notify("Worktree setup cancelled", "warning");
				return;
			}

			const branchNamePart = sanitizeBranchSegment(rawBranchNamePart);
			if (!branchNamePart) {
				ctx.ui.notify("Worktree setup cancelled", "warning");
				return;
			}

			const branchName = `${branchCategory.prefix}${branchNamePart}`;
			if (!branchName) {
				ctx.ui.notify("Worktree setup cancelled", "warning");
				return;
			}

			last.baseBranch = baseBranch;
			last.branchName = branchName;

			ctx.ui.setStatus("worktree", "worktree: creating...");

			const worktreesDir = `${repoRoot}/.worktrees`;
			await run(["mkdir", "-p", worktreesDir], repoRoot);
			await warnGitignore(ctx, repoRoot);

			const dirName = branchName
				.replace(/[^a-zA-Z0-9._/-]+/g, "-")
				.replace(/^[-/]+|[-/]+$/g, "");
			const worktreePath = `${worktreesDir}/${dirName}`;
			last.worktreePath = worktreePath;

			const parentDir = worktreePath.substring(
				0,
				worktreePath.lastIndexOf("/"),
			);
			await run(["mkdir", "-p", parentDir], repoRoot);

			ctx.ui.setStatus("worktree", "worktree: git worktree add...");
			await createWorktree(pi, repoRoot, {
				baseBranch,
				branchName,
				worktreePath,
			});
			await verifyWorktree(repoRoot, { branchName, worktreePath });
			pi.logger.debug("plan-worktree: worktree verified", { worktreePath });

			ctx.ui.setStatus("worktree", "worktree: linking project skills...");
			await bestEffortLinkProjectAgentsSkills(pi, repoRoot, worktreePath);

			ctx.ui.setStatus("worktree", "worktree: publishing remote branch...");
			await syncWorktreeBranchToRemote(ctx, "publish initial branch");

			ctx.ui.setStatus("worktree", "worktree: installing deps...");
			await bestEffortSetup(worktreePath);

			ctx.ui.setStatus("worktree", "worktree: switching...");
			process.chdir(worktreePath);
			pi.logger.debug("plan-worktree: chdir complete", { cwd: process.cwd() });

			await bestEffortAuggieIndex(pi, ctx, worktreePath);

			setupDone = true;
			await ensurePinnedToWorktree();
			await ensureOrchestratorRuntimeDefaults(ctx);
			setActionButton(ctx, "submit-pr");
			persistWorktreeState();
			ctx.ui.setStatus("worktree", undefined);
			ctx.ui.notify("Worktree ready — session switched", "info");

			pi.sendMessage({
				customType: "implement-worktree/ready",
				content: [
					`## Worktree ready`,
					``,
					`- **Base branch:** \`${baseBranch}\``,
					`- **New branch:** \`${branchName}\``,
					`- **Remote branch:** \`origin/${branchName}\``,
					`- **Path:** \`${worktreePath}\``,
					``,
					`The session has been switched to the worktree.`,
				].join("\n"),
				display: true,
				details: {
					baseBranch,
					branchName,
					remoteBranch: `origin/${branchName}`,
					worktreePath,
				},
			});

			return { baseBranch, branchName, worktreePath };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: setup failed", { error: msg });
			ctx.ui.setStatus("worktree", undefined);
			if (last.repoRoot && last.worktreePath) {
				try {
					await cleanupFailedWorktree(
						last.repoRoot,
						last.worktreePath,
						last.branchName,
					);
				} catch (cleanupErr) {
					pi.logger.warn(
						"plan-worktree: cleanup after setup failure encountered errors",
						{
							error:
								cleanupErr instanceof Error
									? cleanupErr.message
									: String(cleanupErr),
						},
					);
				}
			}
			ctx.ui.notify(`plan-worktree error: ${msg}`, "error");
			return;
		}
	};

	const ensureWorkflowPatchHealth = async (
		ctx: ExtensionContext,
	): Promise<void> => {
		if (patchHealthCheckDone) return;
		patchHealthCheckDone = true;

		if (!isWorkflowPatchGuardEnabled()) {
			pi.logger.debug(
				"plan-worktree: workflow patch guard disabled by OMP_IMPLEMENT_PATCH_GUARD",
			);
			return;
		}

		const bundledSource = await readTextFileIfExists(
			WORKFLOW_PATCH_BUNDLED_INTERACTIVE_MODE_PATH,
		);
		if (!bundledSource || !hasRequiredWorkflowFooterButtonMapping(bundledSource)) {
			pi.logger.warn(
				"plan-worktree: workflow patch bundle is missing required footer mapping; skipping guard",
				{
					bundledPath: WORKFLOW_PATCH_BUNDLED_INTERACTIVE_MODE_PATH,
				},
			);
			return;
		}

		const runtimeSource = await readTextFileIfExists(
			WORKFLOW_PATCH_RUNTIME_INTERACTIVE_MODE_PATH,
		);
		if (runtimeSource && hasRequiredWorkflowFooterButtonMapping(runtimeSource)) {
			pi.logger.debug("plan-worktree: workflow patch health check passed");
			return;
		}

		pi.logger.warn(
			"plan-worktree: detected stale runtime footer mapping; hover/click glitches may occur",
			{
				runtimePath: WORKFLOW_PATCH_RUNTIME_INTERACTIVE_MODE_PATH,
			},
		);

		if (!isWorkflowPatchAutoApplyEnabled()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Workflow patch drift detected. Run: bash ${WORKFLOW_PATCH_SCRIPT_PATH} apply`,
					"warning",
				);
			}
			return;
		}

		const applyArgs = ["bash", WORKFLOW_PATCH_SCRIPT_PATH, "apply"];
		if (isWorkflowPatchAutoForceEnabled()) applyArgs.push("--force");

		const apply = await runAllowFail(applyArgs, process.cwd(), 180_000);
		if (apply.code !== 0) {
			const detail = (apply.stderr || apply.stdout).trim().slice(0, 240);
			pi.logger.warn("plan-worktree: workflow patch auto-apply failed", {
				detail,
				applyArgs,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Workflow patch auto-apply failed; run manage.sh apply manually",
					"warning",
				);
			}
			return;
		}

		const refreshedRuntime = await readTextFileIfExists(
			WORKFLOW_PATCH_RUNTIME_INTERACTIVE_MODE_PATH,
		);
		if (!refreshedRuntime || !hasRequiredWorkflowFooterButtonMapping(refreshedRuntime)) {
			pi.logger.warn(
				"plan-worktree: runtime footer mapping still stale after auto-apply",
				{
					runtimePath: WORKFLOW_PATCH_RUNTIME_INTERACTIVE_MODE_PATH,
				},
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Workflow patch is still stale after auto-apply; run manage.sh status",
					"warning",
				);
			}
			return;
		}

		pi.logger.info("plan-worktree: refreshed runtime workflow patch mapping");
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Workflow footer patch refreshed for stable hover/click behavior",
				"info",
			);
		}
	};

	const ensurePinnedToWorktree = async () => {
		if (!last.worktreePath) return;

		const expected = normalizePath(last.worktreePath);
		const current = normalizePath(process.cwd());

		if (current !== expected) {
			process.chdir(expected);
			pi.logger.warn(
				"plan-worktree: cwd drift detected; re-pinned to worktree",
				{
					from: current,
					to: expected,
				},
			);
		}

		if (last.branchName) {
			const branch = (
				await run(["git", "branch", "--show-current"], expected)
			).stdout.trim();
			if (branch && branch !== last.branchName) {
				throw new Error(
					`Expected branch ${last.branchName} in worktree ${expected}, but current branch is ${branch}`,
				);
			}
		}
	};

	const syncWorktreeBranchToRemote = async (
		ctx: ExtensionContext | undefined,
		reason: string,
	): Promise<void> => {
		if (!last.worktreePath || !last.branchName) return;

		const worktreePath = normalizePath(last.worktreePath);
		const branchName = last.branchName;
		const repoRoot = normalizePath(
			last.repoRoot ?? (await getRepoRoot(pi, worktreePath)),
		);
		last.repoRoot = repoRoot;

		if (ctx?.hasUI) {
			ctx.ui.setStatus(REMOTE_SYNC_STATUS_KEY, `remote-sync: ${reason}...`);
		}

		try {
			const originRemote = await runAllowFail(
				["git", "remote", "get-url", "origin"],
				repoRoot,
			);
			if (originRemote.code !== 0 || !originRemote.stdout.trim()) {
				throw new Error("origin remote is not configured for this repository");
			}

			const push = await runAllowFail(
				["git", "push", "--set-upstream", "origin", branchName],
				worktreePath,
				120_000,
			);
			if (push.code !== 0) {
				const detail = (push.stderr || push.stdout).trim() || "git push failed";
				throw new Error(detail);
			}
			if (last.baseBranch) {
				const diverge = await runAllowFail(
					[
						"git",
						"rev-list",
						"--left-right",
						"--count",
						`origin/${last.baseBranch}...HEAD`,
					],
					worktreePath,
				);
				if (diverge.code === 0) {
					const parts = diverge.stdout.trim().split(/\s+/);
					const behind = Number.parseInt(parts[0] ?? "0", 10);
					syncNeeded = behind > 0;
				}
			}
			pendingRemoteSyncError = undefined;

			pi.logger.debug("plan-worktree: remote branch sync complete", {
				reason,
				branchName,
				repoRoot,
				worktreePath,
			});
			if (ctx?.hasUI) {
				setActionButton(ctx, actionButtonStage);
			}
		} finally {
			if (ctx?.hasUI) {
				ctx.ui.setStatus(REMOTE_SYNC_STATUS_KEY, undefined);
			}
		}
	};

	const deleteCurrentWorktree = async (
		ctx: ExtensionContext,
	): Promise<void> => {
		if (!ctx.hasUI) {
			return;
		}

		if (!setupDone || !last.worktreePath || !last.branchName) {
			ctx.ui.notify("No active implementation worktree found", "warning");
			return;
		}

		const worktreePath = normalizePath(last.worktreePath);
		const branchName = last.branchName;
		const baseBranch = last.baseBranch ?? "(unknown)";
		const repoRoot = normalizePath(
			last.repoRoot ?? (await getRepoRoot(pi, process.cwd())),
		);

		const confirmed = await ctx.ui.confirm(
			"Delete worktree and discard all changes?",
			[
				"This is destructive and cannot be undone.",
				"",
				`- Branch: ${branchName}`,
				`- Base: ${baseBranch}`,
				`- Path: ${worktreePath}`,
				"",
				"It will also attempt to delete origin/<branch> if it exists.",
			].join("\n"),
		);
		if (!confirmed) {
			ctx.ui.notify("Delete Worktree cancelled", "warning");
			return;
		}

		ctx.ui.setStatus(
			DELETE_WORKTREE_PROGRESS_STATUS_KEY,
			"delete-worktree: removing...",
		);

		let localBranchDeleted = false;
		let remoteDeleteAttempted = false;
		let remoteDeleted = false;
		let remoteDeleteError: string | undefined;

		try {
			const current = normalizePath(process.cwd());
			if (isInside(worktreePath, current)) {
				process.chdir(repoRoot);
			}

			const removeWorktree = await runAllowFail(
				["git", "worktree", "remove", worktreePath, "--force"],
				repoRoot,
				120_000,
			);
			if (removeWorktree.code !== 0) {
				const detail = (removeWorktree.stderr || removeWorktree.stdout).trim();
				throw new Error(detail || "git worktree remove failed");
			}

			const localDelete = await runAllowFail(
				["git", "branch", "-D", branchName],
				repoRoot,
			);
			localBranchDeleted = localDelete.code === 0;

			const originRemote = await runAllowFail(
				["git", "remote", "get-url", "origin"],
				repoRoot,
			);
			if (originRemote.code === 0) {
				const remoteBranch = await runAllowFail(
					["git", "ls-remote", "--exit-code", "--heads", "origin", branchName],
					repoRoot,
				);
				if (remoteBranch.code === 0) {
					remoteDeleteAttempted = true;
					const remoteDelete = await runAllowFail(
						["git", "push", "origin", "--delete", branchName],
						repoRoot,
						120_000,
					);
					if (remoteDelete.code === 0) {
						remoteDeleted = true;
					} else {
						remoteDeleteError =
							(remoteDelete.stderr || remoteDelete.stdout).trim() ||
							"unknown error";
					}
				}
			}

			await cleanupEmptyWorktreeParents(repoRoot, worktreePath);

			setupDone = false;
			pendingRemoteSyncError = undefined;
			syncNeeded = false;
			last = {};
			setActionButton(ctx, resolvePrimaryCheckoutActionButtonStage(ctx));
			persistWorktreeState();

			const remoteStatus = remoteDeleteAttempted
				? remoteDeleted
					? "Remote branch deleted."
					: `Remote branch delete failed (${remoteDeleteError ?? "unknown error"}).`
				: "No matching remote branch found (or no origin remote).";

			const notePrefix = localBranchDeleted
				? `Deleted worktree and branch ${branchName}.`
				: `Deleted worktree ${branchName}; local branch deletion was best-effort.`;

			ctx.ui.notify(
				`${notePrefix} ${remoteStatus}`,
				remoteDeleteAttempted && !remoteDeleted ? "warning" : "info",
			);

			pi.sendMessage({
				customType: "delete-worktree/complete",
				content: [
					"## Worktree deleted",
					"",
					`- Branch: \`${branchName}\``,
					`- Path removed: \`${worktreePath}\``,
					`- Local branch deleted: ${localBranchDeleted ? "yes" : "best-effort/failed"}`,
					`- Remote branch deleted: ${remoteDeleteAttempted ? (remoteDeleted ? "yes" : "no") : "not found"}`,
				].join("\n"),
				display: true,
				details: {
					branchName,
					worktreePath,
					localBranchDeleted,
					remoteDeleteAttempted,
					remoteDeleted,
					remoteDeleteError,
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: delete-worktree failed", {
				error: msg,
				branchName,
				worktreePath,
			});
			ctx.ui.notify(`delete-worktree failed: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(DELETE_WORKTREE_PROGRESS_STATUS_KEY, undefined);
		}
	};

	const continuePlannedWorktreeFromLinkedPlan = async (
		_ctx: ExtensionContext,
		planFilePath: string,
		planContent: string,
	): Promise<void> => {
		const ctx = _ctx as ExtensionContext & ExtensionCommandContext;
		linkedPlannedPlanPath = planFilePath;
		linkedPlannedPlanContent = planContent;
		last.planFilePath = planFilePath;
		last.planWorkspaceDir = getPlanWorkspaceDir(planFilePath);

		const planMetadata = findLatestPlanMetadata(ctx);
		if (!planMetadata) {
			ctx.ui.notify(
				"planned worktree metadata missing; run /plan-new first so kickoff context can be finalized",
				"error",
			);
			clearPendingPlannedWorktreeState();
			return;
		}

		let repoRoot: string;
		try {
			repoRoot = await getRepoRoot(pi, ctx.cwd);
			last.repoRoot = repoRoot;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`Unable to detect repository root for planned worktree: ${msg}`,
				"error",
			);
			clearPendingPlannedWorktreeState();
			return;
		}

		const trimmedCategoryOptions = WORKTREE_CATEGORY_OPTIONS.slice(0, 8);
		const branchCategory = await promptForWorktreeCategory(ctx);
		if (
			!branchCategory ||
			!trimmedCategoryOptions.some(
				(option) => option.prefix === branchCategory.prefix,
			)
		) {
			ctx.ui.notify("Planned worktree setup cancelled", "warning");
			clearPendingPlannedWorktreeState();
			return;
		}

		const suggestedBranchName = await suggestBranchNameFromPlan(ctx, {
			planFilePath,
			planContent,
			topicSlug: extractTopic(planContent),
		});

		const requestedBranchName = await ctx.ui.input(
			`Enter worktree name (without '${branchCategory.prefix}')`,
			suggestedBranchName,
		);
		if (!requestedBranchName) {
			ctx.ui.notify("Planned worktree setup cancelled", "warning");
			clearPendingPlannedWorktreeState();
			return;
		}

		const selectedBranchName = sanitizeBranchSegment(requestedBranchName);
		if (!selectedBranchName) {
			ctx.ui.notify("Planned worktree setup cancelled", "warning");
			clearPendingPlannedWorktreeState();
			return;
		}

		const baseOptions = await getBaseBranchOptions(pi, repoRoot);
		const baseChoice = await ctx.ui.select(
			"Which branch should the implementation worktree be based on?",
			baseOptions.options,
		);
		if (!baseChoice) {
			ctx.ui.notify("Planned worktree setup cancelled", "warning");
			clearPendingPlannedWorktreeState();
			return;
		}

		const selectedBaseBranch = (
			baseChoice === OTHER_CHOICE
				? await ctx.ui.input("Enter base branch name:", baseOptions.recommended)
				: baseChoice
		)?.trim();
		if (!selectedBaseBranch) {
			ctx.ui.notify("Planned worktree setup cancelled", "warning");
			clearPendingPlannedWorktreeState();
			return;
		}

		const plannedSelection: PersistedPlannedWorktreeSelection = {
			planFilePath,
			categoryLabel: branchCategory.label,
			categoryPrefix: branchCategory.prefix,
			branchNamePart: selectedBranchName,
			baseBranch: selectedBaseBranch,
			updatedAt: Date.now(),
		};
		pendingPlannedWorktreeSelection = plannedSelection;
		pi.appendEntry(PERSISTED_PLANNED_WORKTREE_SELECTION_TYPE, plannedSelection);
		last.baseBranch = selectedBaseBranch;

		if (!pendingPlannedWorktreeSelection) {
			ctx.ui.notify(
				"planned worktree selection missing; restart planned-worktree flow",
				"error",
			);
			clearPendingPlannedWorktreeState();
			return;
		}

		const selectedCategory = WORKTREE_CATEGORY_OPTIONS.find(
			(option) =>
				option.prefix === pendingPlannedWorktreeSelection.categoryPrefix ||
				option.label === pendingPlannedWorktreeSelection.categoryLabel,
		);
		if (!selectedCategory) {
			ctx.ui.notify(
				"planned worktree selection category is invalid; restart planned-worktree flow",
				"error",
			);
			clearPendingPlannedWorktreeState();
			return;
		}

		const parentSessionFile = ctx.sessionManager.getSessionFile();
		let setup:
			| { baseBranch: string; branchName: string; worktreePath: string }
			| undefined;
		ctx.ui.setStatus(
			IMPLEMENT_PROGRESS_STATUS_KEY,
			"implement: finalizing planned worktree session...",
		);

		try {
			setup = await setupWorktreeFromTopic(ctx, {
				topic:
					extractTopic(linkedPlannedPlanContent ?? planContent) ||
					pendingPlannedWorktreeSelection.branchNamePart,
				planFilePath:
					linkedPlannedPlanPath ?? pendingPlannedWorktreeSelection.planFilePath,
				categoryOverride:
					WORKTREE_CATEGORY_OPTIONS.find(
						(option) =>
							option.prefix ===
								pendingPlannedWorktreeSelection.categoryPrefix ||
							option.label === pendingPlannedWorktreeSelection.categoryLabel,
					) ?? selectedCategory,
				baseBranchOverride: pendingPlannedWorktreeSelection.baseBranch,
				branchNameOverride: pendingPlannedWorktreeSelection.branchNamePart,
			});
			if (!setup) {
				clearPendingPlannedWorktreeState();
				return;
			}

			const resolvedPlannedPlanPath =
				linkedPlannedPlanPath ?? pendingPlannedWorktreeSelection.planFilePath;
			last.planFilePath = resolvedPlannedPlanPath;
			last.planWorkspaceDir = getPlanWorkspaceDir(resolvedPlannedPlanPath);

			const implementState: PersistedWorktreeState = {
				baseBranch: last.baseBranch ?? setup.baseBranch,
				branchName: last.branchName ?? setup.branchName,
				worktreePath: last.worktreePath ?? setup.worktreePath,
				repoRoot: last.repoRoot,
				planFilePath: last.planFilePath,
				planWorkspaceDir: last.planWorkspaceDir,
				actionButtonStage: "submit-pr",
				updatedAt: Date.now(),
			};

			const created = await ctx.newSession({
				parentSession: parentSessionFile,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(
						PERSISTED_WORKTREE_STATE_TYPE,
						implementState,
					);
					sessionManager.appendCustomEntry(PERSISTED_PLAN_METADATA_TYPE, {
						planFilePath: resolvedPlannedPlanPath,
						updatedAt: Date.now(),
					});
				},
			});
			if (created.cancelled) {
				ctx.ui.notify(
					"Planned worktree cancelled before creating implementation session",
					"warning",
				);
				clearPendingPlannedWorktreeState();
				return;
			}

			const restored = await tryRestoreWorktreeState(ctx);
			if (!restored) {
				const worktreePath = normalizePath(implementState.worktreePath);
				const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
				if (!gitExists) {
					throw new Error(
						"Planned session created, but failed to restore worktree context",
					);
				}

				process.chdir(worktreePath);
				last = {
					baseBranch: implementState.baseBranch,
					branchName: implementState.branchName,
					worktreePath,
					repoRoot: implementState.repoRoot,
					planFilePath: implementState.planFilePath,
					planWorkspaceDir: implementState.planWorkspaceDir,
				};
				setupDone = true;
			}

			await ensurePinnedToWorktree();
			await ensureOrchestratorRuntimeDefaults(ctx);
			setActionButton(ctx, "submit-pr");
			persistWorktreeState();
			persistPlanMetadata(pi, resolvedPlannedPlanPath);
			clearPendingPlannedWorktreeState();
			// biome-ignore format: phase7 regex expects setEditorText array join without trailing comma
			ctx.ui.setEditorText(
				[
					`@${resolvedPlannedPlanPath}`,
					"Use one Task subagent per phase (keep phases granular); use designer for any UI work.",
					"Start with the TODO list first, then delegate.",
					"TDD is required for each implementation phase (RED before GREEN).",
					"After each phase, run verifier tasks for lint/tests/success criteria.",
				].join("\n")
			);
			ctx.ui.notify(
				"Planned worktree ready in a new session. Review the kickoff prompt and submit to begin.",
				"info",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.error("plan-worktree: planned-worktree finalization failed", {
				error: msg,
			});
			const cleanupWorktreePath = setup?.worktreePath ?? last.worktreePath;
			if (last.repoRoot && cleanupWorktreePath) {
				try {
					await cleanupFailedWorktree(
						last.repoRoot,
						cleanupWorktreePath,
						setup?.branchName ?? last.branchName,
					);
				} catch (cleanupErr) {
					pi.logger.warn(
						"plan-worktree: planned cleanup after failure encountered errors",
						{
							error:
								cleanupErr instanceof Error
									? cleanupErr.message
									: String(cleanupErr),
						},
					);
				}
			}
			clearPendingPlannedWorktreeState();
			ctx.ui.notify(`planned worktree error: ${msg}`, "error");
		} finally {
			ctx.ui.setStatus(IMPLEMENT_PROGRESS_STATUS_KEY, undefined);
			if (!setupDone || !last.worktreePath) {
				setActionButton(ctx, "plan");
			}
		}
	};

	const suggestBranchNameFromPlan = async (
		ctx: ExtensionContext,
		input: { planFilePath: string; planContent: string; topicSlug: string },
	): Promise<string> => {
		const { planFilePath, planContent, topicSlug } = input;
		const { planTitle, phaseHeadings } =
			extractPlanTitleAndPhaseHeadings(planContent);
		const fallbackCandidates = buildBranchNameCandidates({
			planFilePath,
			topicSlug: topicToSlug(planTitle || topicSlug || "implement"),
		});
		const fallbackSuggestion = fallbackCandidates[0] ?? "implement";

		const curatorAssignment = [
			"Generate a concise git branch name slug from this implementation plan.",
			"",
			`Plan title: ${planTitle || "(unknown)"}`,
			"Phase headings:",
			...(phaseHeadings.length > 0
				? phaseHeadings.map((heading) => `- ${heading}`)
				: ["- (none found)"]),
			"",
			"Respond with exactly one kebab-case slug branch name only (2-4 words).",
			"Do not include explanation, punctuation, quotes, or code fences.",
		].join("\n");

		const curatorTaskPayload = {
			agent: "curator" as const,
			tasks: [
				{
					id: "SuggestPlannedBranchSlug",
					description: "Suggesting concise planned branch slug",
					assignment: curatorAssignment,
				},
			],
		};

		try {
			const curatorResult = await withTimeout(
				invokeTaskToolForCurator(ctx, curatorTaskPayload),
				CURATOR_BRANCH_SUGGEST_TIMEOUT_MS,
				"curator timeout",
			);
			const curatorSuggestionText = extractCuratorSuggestionText(curatorResult);
			const curatorSuggestion = curatorSuggestionText ?? "";
			const curatorSuggestedBranch = sanitizeBranchSegment(curatorSuggestion);
			if (!curatorSuggestedBranch) {
				pi.logger.warn(
					"plan-worktree: curator suggestion empty after sanitize; using fallback",
					{
						curatorSuggestionText,
						fallback: fallbackSuggestion,
					},
				);
				return fallbackSuggestion;
			}
			if (!isStrictKebabCase(curatorSuggestedBranch)) {
				pi.logger.warn(
					"plan-worktree: curator suggestion invalid format after sanitize; using fallback",
					{
						curatorSuggestionText,
						fallback: fallbackSuggestion,
					},
				);
				return fallbackSuggestion;
			}
			if (curatorSuggestedBranch === "implement") {
				pi.logger.warn(
					"plan-worktree: curator suggestion too generic; using fallback",
					{
						curatorSuggestionText,
						fallback: fallbackSuggestion,
					},
				);
				return fallbackSuggestion;
			}
			return curatorSuggestedBranch;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.warn(
				"plan-worktree: curator timeout/failed/error; using fallback",
				{
					error: msg,
					fallback: fallbackSuggestion,
				},
			);
			return fallbackSuggestion;
		}
	};

	const invokeTaskToolForCurator = async (
		ctx: ExtensionContext,
		payload: {
			agent: "curator";
			tasks: Array<{ id: string; description: string; assignment: string }>;
		},
	): Promise<unknown> => {
		const ctxWithTask = ctx as unknown as {
			task?: (input: unknown) => Promise<unknown>;
			runTool?: (name: string, input: unknown) => Promise<unknown>;
		};
		if (typeof ctxWithTask.task === "function") {
			return await ctxWithTask.task(payload);
		}
		if (typeof ctxWithTask.runTool === "function") {
			return await ctxWithTask.runTool("task", payload);
		}
		const piWithTool = pi as unknown as {
			runTool?: (name: string, input: unknown) => Promise<unknown>;
		};
		if (typeof piWithTool.runTool === "function") {
			return await piWithTool.runTool("task", payload);
		}
		throw new Error("task tool unavailable for curator suggestion");
	};

	const withTimeout = async <T>(
		promise: Promise<T>,
		timeoutMs: number,
		timeoutLabel: string,
	): Promise<T> => {
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(timeoutLabel)),
				timeoutMs,
			);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	};

	const extractCuratorSuggestionText = (value: unknown): string | undefined => {
		if (typeof value === "string") return value.trim() || undefined;
		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = extractCuratorSuggestionText(item);
				if (nested) return nested;
			}
			return undefined;
		}
		if (!value || typeof value !== "object") return undefined;

		const obj = value as Record<string, unknown>;
		for (const key of [
			"slug",
			"branch",
			"text",
			"content",
			"output",
			"result",
			"data",
		]) {
			if (!(key in obj)) continue;
			const nested = extractCuratorSuggestionText(obj[key]);
			if (nested) return nested;
		}

		for (const item of Object.values(obj)) {
			const nested = extractCuratorSuggestionText(item);
			if (nested) return nested;
		}

		return undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		pi.logger.debug("plan-worktree: extension loaded");
		pendingRemoteSyncError = undefined;
		syncNeeded = false;
		pendingUpdateVersionFinalize = false;
		pendingPlannedWorktree = false;
		linkedPlannedPlanPath = undefined;
		linkedPlannedPlanContent = undefined;
		pendingPlannedWorktreeSelection = undefined;
		sessionTitleCaptured = false;
		hasInjectedSessionWorktreePrompt = false;
		readBudget.resetForNextDelegation();
		warmedAuggieWorkspacePaths = new Set();
		await updatePaneWidth(); // prime cache for accurate right-edge button placement
		await ensureWorkflowPatchHealth(ctx);
		const restored = await tryRestoreWorktreeState(ctx);
		if (!restored) {
			setActionButton(ctx, resolvePrimaryCheckoutActionButtonStage(ctx));
			// Git-native worktree detection for button state
			const gitInfo = await findGitRoot(process.cwd());
			if (gitInfo?.isWorktree && !setupDone) {
				// In a git worktree but no persisted state — derive metadata from git
				const wtInfo = await deriveWorktreeInfo(gitInfo.root);
				if (wtInfo) {
					last = {
						worktreePath: gitInfo.root,
						branchName: wtInfo.branchName,
						baseBranch: wtInfo.baseBranch,
						repoRoot: wtInfo.repoRoot,
					};
					setupDone = true;
				}
				setActionButton(ctx, "submit-pr");
			} else if (gitInfo && !gitInfo.isWorktree && !setupDone) {
				// In main checkout — show Worktree button
				setActionButton(ctx, "plan");
			}
		}
		if (!sigwinchInstalled) {
			sigwinchInstalled = true;
			process.on("SIGWINCH", () => {
				// Update tmux pane width cache then recalculate spacer
				void updatePaneWidth().then(() => {
					if (ctx.hasUI) setActionButton(ctx, actionButtonStage);
				});
			});
		}
		// Sync thinking level from model-role-thinking.json for this session's role so the status
		// line reflects the configured level immediately without waiting for the first agent turn.
		if (ctx.hasUI) {
			const sessionRole = getLastModelChangeRole(ctx);
			const persistedLevels = readModelRoleThinkingLevels();
			const thinkingLevel =
				(sessionRole ? persistedLevels[sessionRole] : undefined) ??
				persistedLevels[resolveParentRuntimeRole(sessionRole)];
			if (thinkingLevel) {
				pi.setThinkingLevel(thinkingLevel);
				pi.logger.debug("plan-worktree: synced role thinking level on session start", {
					role: sessionRole ?? "default",
					level: thinkingLevel,
				});
			}
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		setupDone = false;
		pendingRemoteSyncError = undefined;
		syncNeeded = false;
		pendingUpdateVersionFinalize = false;
		pendingPlannedWorktree = false;
		linkedPlannedPlanPath = undefined;
		linkedPlannedPlanContent = undefined;
		pendingPlannedWorktreeSelection = undefined;
		sessionTitleCaptured = false;
		hasInjectedSessionWorktreePrompt = false;
		readBudget.resetForNextDelegation();
		warmedAuggieWorkspacePaths = new Set();
		actionButtonStage = "plan";
		last = {};
		await ensureWorkflowPatchHealth(ctx);
		const restored = await tryRestoreWorktreeState(ctx);
		if (!restored && !setupDone) {
			setActionButton(ctx, resolvePrimaryCheckoutActionButtonStage(ctx));
			// Git-native worktree detection for button state
			const gitInfo = await findGitRoot(process.cwd());
			if (gitInfo?.isWorktree && !setupDone) {
				// In a git worktree but no persisted state — derive metadata from git
				const wtInfo = await deriveWorktreeInfo(gitInfo.root);
				if (wtInfo) {
					last = {
						worktreePath: gitInfo.root,
						branchName: wtInfo.branchName,
						baseBranch: wtInfo.baseBranch,
						repoRoot: wtInfo.repoRoot,
					};
					setupDone = true;
				}
				setActionButton(ctx, "submit-pr");
			} else if (gitInfo && !gitInfo.isWorktree && !setupDone) {
				// In main checkout — show Worktree button
				setActionButton(ctx, "plan");
			}
		}
		// Sync thinking level from model-role-thinking.json for this session's role so the status
		// line reflects the configured level immediately on session switch.
		if (ctx.hasUI) {
			const sessionRole = getLastModelChangeRole(ctx);
			const persistedLevels = readModelRoleThinkingLevels();
			const thinkingLevel =
				(sessionRole ? persistedLevels[sessionRole] : undefined) ??
				persistedLevels[resolveParentRuntimeRole(sessionRole)];
			if (thinkingLevel) {
				pi.setThinkingLevel(thinkingLevel);
				pi.logger.debug("plan-worktree: synced role thinking level on session switch", {
					role: sessionRole ?? "default",
					level: thinkingLevel,
				});
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		const text = (event as { text?: string }).text?.trim();
		if (text === "/resume" || text?.startsWith("/resume ")) {
			// biome-ignore format: phase5 regex expects exact spacing in resume return
			return { text: "/resume-ui"  };
		}

		if (!pendingPlannedWorktree) {
			return;
		}

		if (pendingPlannedWorktree) {
			const mentionedPlanPath = parseReviewCompleteManualPlanPath(text ?? "");
			if (!mentionedPlanPath) {
				ctx.ui.notify(plannedWorktreePlanPathPromptText(), "error");
				pendingPlannedWorktree = false;
				return;
			}

			let resolvedPlanPath: string;
			try {
				// biome-ignore format: phase5 regex expects resolvePlanFilePath call on one line
				resolvedPlanPath = resolvePlanFilePath(mentionedPlanPath, ctx.sessionManager.getCwd());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Unable to resolve plan path (${mentionedPlanPath}): ${msg}`,
					"error",
				);
				pendingPlannedWorktree = false;
				return;
			}

			if (!isDocsPlanMarkdownPath(resolvedPlanPath)) {
				ctx.ui.notify(plannedWorktreePlanPathPromptText(), "error");
				pendingPlannedWorktree = false;
				return;
			}

			if (!(await Bun.file(resolvedPlanPath).exists())) {
				ctx.ui.notify(
					`Plan file does not exist: ${mentionedPlanPath}`,
					"error",
				);
				pendingPlannedWorktree = false;
				return;
			}

			const planFile = Bun.file(resolvedPlanPath);

			try {
				const planContent = await planFile.text();
				pendingPlannedWorktree = false;
				await continuePlannedWorktreeFromLinkedPlan(
					ctx,
					resolvedPlanPath,
					planContent,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Unable to read plan file (${mentionedPlanPath}): ${msg}`,
					"error",
				);
				pendingPlannedWorktree = false;
			}
		}
	});

	pi.registerCommand(IMPLEMENT_COMMAND, {
		description:
			"Create implementation worktree, publish/sync its branch to origin, and start execution (auto from /plan-new metadata, or manual @plan handoff when metadata is unavailable)",
		handler: async (args, ctx) => {
			await launchImplement(ctx, args);
		},
	});

	pi.registerCommand("worktree", {
		description: "Show current worktree status",
		handler: async (_args, ctx) => {
			if (!last.worktreePath) {
				if (pendingPlannedWorktreeSelection) {
					ctx.ui.notify(
						`No active worktree yet. Planned selection is staged (${pendingPlannedWorktreeSelection.categoryPrefix}${pendingPlannedWorktreeSelection.branchNamePart} from ${pendingPlannedWorktreeSelection.baseBranch}).`,
						"info",
					);
					return;
				}
				ctx.ui.notify(
					"No worktree configured for this session yet. Use /implement to start one.",
					"info",
				);
				return;
			}

			const currentCwd = process.cwd();
			const activeBranch = await runAllowFail(
				["git", "branch", "--show-current"],
				currentCwd,
			);
			const branchText =
				activeBranch.code === 0
					? activeBranch.stdout.trim() || "(detached)"
					: "(unknown)";

			ctx.ui.notify(
				`Worktree: ${last.worktreePath} (branch: ${last.branchName}, base: ${last.baseBranch}) | cwd: ${currentCwd} | git branch: ${branchText}`,
				"info",
			);
		},
	});

	pi.registerCommand(DELETE_WORKTREE_COMMAND, {
		description:
			"Delete the active implementation worktree, branch, and remote branch (with confirmation)",
		handler: async (_args, ctx) => {
			await deleteCurrentWorktree(ctx);
		},
	});

	pi.registerCommand(REVIEW_COMPLETE_COMMAND, {
		description:
			"Open a new review session that verifies plan completion phase-by-phase (read-only) and finishes with a CodeRabbit CLI gate. Optional: /review-complete @.omp/sessions/plans/<type>/<YYYY-MM-DD-slug>/<plan>.md",
		handler: async (args, ctx) => {
			await launchReviewComplete(ctx, args);
		},
	});

	pi.registerCommand(FIX_ISSUES_COMMAND, {
		description:
			"Open a remediation session that fixes issues from the latest review report, pushes remediation commits to origin, then runs final verification including a final CodeRabbit CLI gate. Optional: /fix-issues @docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md",
		handler: async (args, ctx) => {
			await launchFixIssues(ctx, args);
		},
	});

	pi.registerCommand(UPDATE_VERSION_WORKFLOW_COMMAND, {
		description:
			"Open a dedicated worktree session and run /update-version automatically. Usage: /update-version-workflow [patch|minor|major]",
		handler: async (args, ctx) => {
			await launchUpdateVersion(ctx, args);
		},
	});

	pi.registerCommand("freeform-worktree", {
		description: "Start the freeform worktree flow",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current run to finish before starting freeform worktree",
					"warning",
				);
				return;
			}
			if (setupDone && last.worktreePath) {
				ctx.ui.notify(
					"Implementation already has an active worktree in this session",
					"warning",
				);
				return;
			}

			setActionButton(ctx, "implement");
			const freeformPlanPath = "docs/plans/manual/manual-implement.md";
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			let setup:
				| { baseBranch: string; branchName: string; worktreePath: string }
				| undefined;

			try {
				const category = await promptForWorktreeCategory(ctx);
				if (!category) {
					notifyFreeformCategoryCancelled();
					return;
				}

				const requestedName = (
					await ctx.ui.input(
						"Enter a short freeform worktree name:",
						"freeform-task",
					)
				)?.trim();
				if (!requestedName) {
					notifyFreeformNameCancelled();
					return;
				}

				const repoRoot = await getRepoRoot(pi, ctx.cwd);
				const baseOptions = await getBaseBranchOptions(pi, repoRoot);
				const baseChoice = await ctx.ui.select(
					"Which branch should the implementation worktree be based on?",
					baseOptions.options,
				);
				if (!baseChoice) {
					notifyFreeformBaseBranchCancelled();
					return;
				}

				const selectedBaseBranch = (
					baseChoice === OTHER_CHOICE
						? await ctx.ui.input(
								"Enter base branch name:",
								baseOptions.recommended,
							)
						: baseChoice
				)?.trim();
				if (!selectedBaseBranch) {
					notifyFreeformBaseBranchCancelled();
					return;
				}

				setup = await setupWorktreeFromTopic(ctx, {
					topic: requestedName,
					planFilePath: freeformPlanPath,
					categoryOverride: category,
					baseBranchOverride: selectedBaseBranch,
					branchNameOverride: requestedName,
				});
				if (!setup) {
					return;
				}

				const implementState: PersistedWorktreeState = {
					baseBranch: last.baseBranch ?? setup.baseBranch,
					branchName: last.branchName ?? setup.branchName,
					worktreePath: last.worktreePath ?? setup.worktreePath,
					repoRoot: last.repoRoot,
					planFilePath: undefined,
					planWorkspaceDir: undefined,
					actionButtonStage: "submit-pr",
					updatedAt: Date.now(),
				};

				ctx.ui.setStatus(
					IMPLEMENT_PROGRESS_STATUS_KEY,
					"implement: starting implementation session...",
				);
				const created = await ctx.newSession({
					parentSession: parentSessionFile,
					setup: async (sessionManager) => {
						sessionManager.appendCustomEntry(
							PERSISTED_WORKTREE_STATE_TYPE,
							implementState,
						);
					},
				});
				if (created.cancelled) {
					notifyFreeformSessionCancelled();
					return;
				}

				const restored = await tryRestoreWorktreeState(ctx);
				if (!restored) {
					const worktreePath = normalizePath(implementState.worktreePath);
					const gitExists = await Bun.file(`${worktreePath}/.git`).exists();
					if (!gitExists) {
						throw new Error(
							"Freeform session created, but failed to restore worktree context",
						);
					}

					process.chdir(worktreePath);
					last = {
						baseBranch: implementState.baseBranch,
						branchName: implementState.branchName,
						worktreePath,
						repoRoot: implementState.repoRoot,
						planFilePath: undefined,
						planWorkspaceDir: undefined,
					};
					setupDone = true;
				}

				await ensurePinnedToWorktree();
				await ensureOrchestratorRuntimeDefaults(ctx);
				setActionButton(ctx, "submit-pr");
				persistWorktreeState();

				const sessionWorkspaceTemplate = getSessionWorkspaceTemplate(
					last.repoRoot,
				);
				ctx.ui.setEditorText(
					[
						"You are in Orchestrator mode in this worktree. Implement the following request:",
						"",
						"[DESCRIBE YOUR REQUEST HERE]",
						"",
						"Orchestrator execution contract (MANDATORY — no plan file is required):",
						"- Your first response must be ONLY a numbered phase list (2-6 phases).",
						"- After the phase-list response, delegate implementation to Task subagents.",
						"- Keep each phase atomic and verified before moving forward.",
						"- Session Workspace (MANDATORY):",
						`- All session artifacts MUST be written under: \`${sessionWorkspaceTemplate}\``,
					].join("\n"),
				);
				ctx.ui.notify(
					"Worktree ready in a new session. Describe your request and submit to start implementation.",
					"info",
				);
				pi.sendMessage({
					customType: "implement-manual/ready",
					content: [
						"## Freeform worktree ready",
						"",
						"A new implementation session is ready in the worktree.",
						"Fill in the freeform request template and submit when ready.",
					].join("\n"),
					display: true,
					details: { mode: "manual-freeform" },
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				pi.logger.error("plan-worktree: freeform-worktree failed", {
					error: msg,
				});
				const cleanupWorktreePath = setup?.worktreePath ?? last.worktreePath;
				if (last.repoRoot && cleanupWorktreePath) {
					try {
						await cleanupFailedWorktree(
							last.repoRoot,
							cleanupWorktreePath,
							setup?.branchName ?? last.branchName,
						);
					} catch (cleanupErr) {
						pi.logger.warn(
							"plan-worktree: freeform cleanup after failure encountered errors",
							{
								error:
									cleanupErr instanceof Error
										? cleanupErr.message
										: String(cleanupErr),
							},
						);
					}
				}
				ctx.ui.notify(`freeform worktree error: ${msg}`, "error");
			} finally {
				ctx.ui.setStatus(IMPLEMENT_PROGRESS_STATUS_KEY, undefined);
				if (!setupDone || !last.worktreePath) {
					setActionButton(ctx, "plan");
				}
			}

			function notifyFreeformCategoryCancelled() {
				ctx.ui.notify("freeform worktree cancelled at category selection", "warning");
			}

			function notifyFreeformNameCancelled() {
				ctx.ui.notify("freeform worktree cancelled at name input", "warning");
			}

			function notifyFreeformBaseBranchCancelled() {
				ctx.ui.notify("freeform worktree cancelled at base branch selection", "warning");
			}

			function notifyFreeformSessionCancelled() {
				ctx.ui.notify("freeform worktree cancelled before creating implementation session", "warning");
			}
		},
	});

	pi.registerCommand("planned-worktree", {
		description: "Start the planned worktree flow",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current run to finish before starting planned worktree",
					"warning",
				);
				return;
			}
			pendingPlannedWorktree = true;
			linkedPlannedPlanPath = undefined;
			linkedPlannedPlanContent = undefined;
			pendingPlannedWorktreeSelection = undefined;
			ctx.ui.setEditorText("@");
			ctx.ui.notify(plannedWorktreePlanPathInfoText(), "info");
		},
	});

	async function handleCleanupComplete(
		ctx: ExtensionCommandContext,
		result: { removedActiveWorktree: boolean },
	): Promise<void> {
		if (result.removedActiveWorktree) {
			setupDone = false;
			pendingRemoteSyncError = undefined;
			syncNeeded = false;
			pendingUpdateVersionFinalize = false;
			last = {};
			setActionButton(ctx, resolvePrimaryCheckoutActionButtonStage(ctx));
			return;
		}
		if (setupDone && last.worktreePath) {
			setActionButton(ctx, "cleanup");
			persistWorktreeState();
			return;
		}
		setActionButton(ctx, resolvePrimaryCheckoutActionButtonStage(ctx));
	}
	pi.registerCommand("cleanup-worktrees", {
		description: "Start the worktree cleanup flow",
		handler: async (_args, ctx) => {
			await runCleanupFlow(pi, ctx, { onComplete: handleCleanupComplete });
		},
	});
	pi.registerCommand("git-menu", {
		description: "Open Git actions menu",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!setupDone || !last.worktreePath) {
				ctx.ui.notify(
					"No active worktree. Use Worktree to create one first.",
					"info",
				);
				return;
			}
			const SUBMIT_PR = "Submit PR";
			const REVIEW = "Review";
			const SYNC_BRANCH = "Sync Branch (rebase on base)";
			const RESOLVE_CONFLICTS = "Resolve Conflicts";
			let choice = await showPopupMenu("Git Actions", [
				SUBMIT_PR,
				REVIEW,
				SYNC_BRANCH,
				RESOLVE_CONFLICTS,
			]);
			if (choice === null) {
				choice = await ctx.ui.select("Git Actions", [
					SUBMIT_PR,
					REVIEW,
					SYNC_BRANCH,
					RESOLVE_CONFLICTS,
				]);
			}
			if (!choice) return;
			if (choice === SUBMIT_PR) {
				ctx.ui.setEditorText("/submit-pr");
			} else if (choice === REVIEW) {
				await launchReviewComplete(ctx);
			} else if (choice === SYNC_BRANCH) {
				if (!last.baseBranch) {
					ctx.ui.notify("No base branch configured.", "warning");
					return;
				}
				pi.sendUserMessage(
					`Spawn the \`merge\` subagent with these parameters:\n- worktree_path: ${last.worktreePath}\n- branch_name: ${last.branchName}\n- base_branch: ${last.baseBranch}\nTask: Sync Branch`,
				);
				syncNeeded = false;
				setActionButton(ctx, actionButtonStage);
			} else if (choice === RESOLVE_CONFLICTS) {
				if (!last.baseBranch) {
					ctx.ui.notify("No base branch configured.", "warning");
					return;
				}
				pi.sendUserMessage(
					`Spawn the \`merge\` subagent with these parameters:\n- worktree_path: ${last.worktreePath}\n- branch_name: ${last.branchName}\n- base_branch: ${last.baseBranch}\nTask: Resolve Conflicts`,
				);
			}
		},
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// Enhanced /resume with worktree-aware TabBar navigation
	// ═══════════════════════════════════════════════════════════════════════════

	const ARCHIVE_THRESHOLD_DAYS = 7;

	type ResumeAgentMode = "orchestrator" | "default" | "unknown";

	interface ResumeSessionInfo {
		path: string;
		id: string;
		cwd: string;
		title?: string;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		allMessagesText: string;
	}

	interface EnrichedSession extends ResumeSessionInfo {
		worktreeGroup: string;
		agentMode: ResumeAgentMode;
		isArchived: boolean;
	}

	const toDate = (value: unknown): Date => {
		if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
		if (typeof value === "number" || typeof value === "string") {
			const date = new Date(value);
			if (!Number.isNaN(date.getTime())) return date;
		}
		return new Date(0);
	};

	const flattenMessageContent = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const textParts: string[] = [];
		for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
			if (block?.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			}
		}
		return textParts.join(" ");
	};

	const readSessionsFromDisk = (sessionsDir: string): ResumeSessionInfo[] => {
		const files: string[] = [];
		const walk = (dir: string) => {
			let entries: fs.Dirent[] = [];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(fullPath);
					continue;
				}
				if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					files.push(fullPath);
				}
			}
		};

		walk(sessionsDir);

		const sessions: ResumeSessionInfo[] = [];
		for (const filePath of files) {
			try {
				const content = fs.readFileSync(filePath, "utf8");
				const lines = content
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0);
				if (lines.length === 0) continue;

				const header = JSON.parse(lines[0] ?? "{}") as {
					type?: string;
					id?: string;
					cwd?: string;
					title?: string;
				};
				if (header.type !== "session" || typeof header.id !== "string")
					continue;

				let messageCount = 0;
				let firstMessage = "";
				const allMessages: string[] = [];
				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (!line) continue;
					try {
						const entry = JSON.parse(line) as {
							type?: string;
							message?: { role?: string; content?: unknown };
						};
						if (entry.type !== "message") continue;
						messageCount += 1;
						const text = flattenMessageContent(entry.message?.content)
							.replace(/\s+/g, " ")
							.trim();
						if (text) {
							allMessages.push(text);
							if (!firstMessage && entry.message?.role === "user") {
								firstMessage = text;
							}
						}
					} catch {
						// ignore malformed session entries
					}
				}

				const stats = fs.statSync(filePath);
				sessions.push({
					path: filePath,
					id: header.id,
					cwd: typeof header.cwd === "string" ? header.cwd : "",
					title: typeof header.title === "string" ? header.title : undefined,
					modified: stats.mtime,
					messageCount,
					firstMessage: firstMessage || "(no messages)",
					allMessagesText: allMessages.join(" "),
				});
			} catch {
				// ignore unreadable session files
			}
		}

		return sessions;
	};

	const normalizeSessionInfo = (session: unknown): ResumeSessionInfo | null => {
		if (!session || typeof session !== "object") return null;
		const record = session as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.id !== "string")
			return null;
		return {
			path: record.path,
			id: record.id,
			cwd: typeof record.cwd === "string" ? record.cwd : "",
			title: typeof record.title === "string" ? record.title : undefined,
			modified: toDate(record.modified),
			messageCount:
				typeof record.messageCount === "number" ? record.messageCount : 0,
			firstMessage:
				typeof record.firstMessage === "string" ? record.firstMessage : "",
			allMessagesText:
				typeof record.allMessagesText === "string"
					? record.allMessagesText
					: "",
		};
	};

	const PRIMARY_RESUME_SESSION_FILENAME_RE =
		/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z0-9]+\.jsonl$/i;

	const isPrimaryResumeSessionPath = (
		sessionsDir: string,
		sessionPath: string,
	): boolean => {
		const relativePath = path.relative(
			normalizePath(sessionsDir),
			normalizePath(sessionPath),
		);
		if (
			!relativePath ||
			relativePath.startsWith("..") ||
			path.isAbsolute(relativePath)
		)
			return false;

		const parts = relativePath.split(path.sep).filter(Boolean);
		if (parts.length !== 2) return false;

		const fileName = parts[1];
		if (!fileName) return false;

		return PRIMARY_RESUME_SESSION_FILENAME_RE.test(fileName);
	};

	const filterPrimaryResumeSessions = (
		sessions: ResumeSessionInfo[],
		sessionsDir: string,
	): ResumeSessionInfo[] =>
		sessions.filter((session) =>
			isPrimaryResumeSessionPath(sessionsDir, session.path),
		);

	const collectSessionInfos = async (
		ctx: ExtensionCommandContext,
	): Promise<ResumeSessionInfo[]> => {
		const sessionsDir = path.join(os.homedir(), ".omp", "agent", "sessions");
		const sessionManagerWithCollector = ctx.sessionManager as unknown as {
			collectSessionsFromFiles?: (dir: string) => unknown;
		};

		try {
			const maybeCollected = await Promise.resolve(
				sessionManagerWithCollector.collectSessionsFromFiles?.(sessionsDir),
			);
			if (Array.isArray(maybeCollected)) {
				const normalized = maybeCollected
					.map(normalizeSessionInfo)
					.filter((session): session is ResumeSessionInfo => Boolean(session));
				const primarySessions = filterPrimaryResumeSessions(
					normalized,
					sessionsDir,
				);
				if (primarySessions.length > 0) {
					return primarySessions.sort(
						(a, b) => b.modified.getTime() - a.modified.getTime(),
					);
				}
			}
		} catch {
			// fall through to direct file parsing
		}

		return filterPrimaryResumeSessions(
			readSessionsFromDisk(sessionsDir),
			sessionsDir,
		).sort((a, b) => b.modified.getTime() - a.modified.getTime());
	};

	interface ResumeSessionDiskMetadata {
		cwd?: string;
		persistedWorktreePath?: string;
	}

	const readResumeSessionDiskMetadata = (
		sessionPath: string,
	): ResumeSessionDiskMetadata => {
		let cwd: string | undefined;
		let persistedWorktreePath: string | undefined;

		try {
			const content = fs.readFileSync(sessionPath, "utf8");
			const lines = content
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0);

			for (const line of lines) {
				let entry: {
					type?: unknown;
					cwd?: unknown;
					customType?: unknown;
					data?: unknown;
				};
				try {
					entry = JSON.parse(line) as {
						type?: unknown;
						cwd?: unknown;
						customType?: unknown;
						data?: unknown;
					};
				} catch {
					continue;
				}

				if (
					!cwd &&
					entry.type === "session" &&
					typeof entry.cwd === "string" &&
					entry.cwd.trim().length > 0
				) {
					cwd = entry.cwd;
				}

				if (
					entry.type === "custom" &&
					entry.customType === PERSISTED_WORKTREE_STATE_TYPE &&
					isPersistedWorktreeState(entry.data)
				) {
					persistedWorktreePath = entry.data.worktreePath;
				}
			}
		} catch {
			// keep metadata undefined when the session file is unreadable
		}

		return { cwd, persistedWorktreePath };
	};

	const findLatestPersistedWorktreePath = (
		entries: unknown[],
	): string | undefined => {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as {
				type?: unknown;
				customType?: unknown;
				data?: unknown;
			};
			if (
				entry.type !== "custom" ||
				entry.customType !== PERSISTED_WORKTREE_STATE_TYPE
			)
				continue;
			if (!isPersistedWorktreeState(entry.data)) continue;
			return entry.data.worktreePath;
		}
		return undefined;
	};

	const chooseResumeTargetCwd = (
		candidates: Array<string | undefined>,
	): string | undefined => {
		for (const candidate of candidates) {
			if (!candidate) continue;
			try {
				const normalized = normalizePath(candidate);
				if (fs.statSync(normalized).isDirectory()) {
					return normalized;
				}
			} catch {
				// candidate path is invalid
			}
		}
		return undefined;
	};

	const applyResumeCwd = (
		targetPath: string | undefined,
	): string | undefined => {
		if (!targetPath) return undefined;
		try {
			process.chdir(targetPath);
			return normalizePath(process.cwd());
		} catch {
			return undefined;
		}
	};

	const repinToResumedSessionCwd = (
		ctx: ExtensionCommandContext,
		fallbacks: Array<string | undefined>,
	): string | undefined => {
		const persistedWorktreePath = findLatestPersistedWorktreePath(
			ctx.sessionManager.getEntries() as unknown[],
		);
		const sessionManagerWithCwd = ctx.sessionManager as unknown as {
			getCwd?: () => string;
		};
		const managerCwd =
			typeof sessionManagerWithCwd.getCwd === "function"
				? sessionManagerWithCwd.getCwd()
				: undefined;
		const postSwitchTarget = chooseResumeTargetCwd([
			persistedWorktreePath,
			managerCwd,
			...fallbacks,
		]);
		return applyResumeCwd(postSwitchTarget);
	};

	const detectWorktreeGroup = async (cwd: string): Promise<string> => {
		if (!cwd) return "main";
		const normalized = path.normalize(cwd);
		const marker = `${path.sep}.worktrees${path.sep}`;
		const markerIndex = normalized.indexOf(marker);
		if (markerIndex !== -1) {
			const repoRoot = normalized.slice(0, markerIndex);
			const repoName = path.basename(repoRoot);
			const after = normalized.slice(markerIndex + marker.length);
			const worktreeName = after.split(path.sep)[0] ?? "";
			if (worktreeName) return `${repoName}/.worktrees/${worktreeName}`;
		}

		try {
			const gitInfo = await findGitRoot(normalized);
			if (gitInfo?.isWorktree) {
				const gitPath = path.join(normalized, ".git");
				const gitContent = fs.readFileSync(gitPath, "utf8");
				const match = gitContent.match(/gitdir:\s*(.+)/);
				if (match?.[1]) {
					const gitDir = match[1].trim();
					const parsed = gitDir.match(/[\\/]worktrees[\\/]([^\\/]+)/);
					const worktreeName =
						parsed?.[1] ?? path.basename(path.dirname(gitDir));
					if (worktreeName) {
						const repoName = path.basename(gitInfo.root);
						return `${repoName}/.worktrees/${worktreeName}`;
					}
				}
			}
		} catch {
			// keep default group
		}

		return "main";
	};

	const detectAgentMode = (allMessagesText: string): ResumeAgentMode => {
		if (!allMessagesText) return "unknown";
		if (
			allMessagesText.includes("Orchestrator mode") ||
			allMessagesText.includes(PERSISTED_WORKTREE_STATE_TYPE) ||
			allMessagesText.includes("plan-worktree/")
		) {
			return "orchestrator";
		}
		if (
			allMessagesText.includes("Default Mode") ||
			allMessagesText.includes("Default mode")
		) {
			return "default";
		}
		return "unknown";
	};

	const enrichSessions = async (
		sessions: ResumeSessionInfo[],
		archiveThresholdDays: number,
	): Promise<EnrichedSession[]> => {
		const now = Date.now();
		const archiveThreshold = archiveThresholdDays * 86_400_000;
		const enriched: EnrichedSession[] = [];
		for (const session of sessions) {
			const worktreeGroup = await detectWorktreeGroup(session.cwd);
			enriched.push({
				...session,
				worktreeGroup,
				agentMode: detectAgentMode(session.allMessagesText),
				isArchived: now - session.modified.getTime() > archiveThreshold,
			});
		}
		return enriched;
	};

	const fuzzyMatch = (query: string, candidate: string): boolean => {
		const needle = query.trim().toLowerCase();
		if (!needle) return true;
		const haystack = candidate.toLowerCase();
		if (haystack.includes(needle)) return true;
		let queryIndex = 0;
		for (const char of haystack) {
			if (char === needle[queryIndex]) queryIndex += 1;
			if (queryIndex >= needle.length) return true;
		}
		return false;
	};

	function formatRelativeTime(date: Date): {
		text: string;
		color: "success" | "warning" | "muted" | "dim";
	} {
		const now = Date.now();
		const diffMs = now - date.getTime();
		const diffMins = Math.floor(diffMs / 60_000);
		const diffHours = Math.floor(diffMs / 3_600_000);
		const diffDays = Math.floor(diffMs / 86_400_000);

		if (diffMins < 1) return { text: "just now", color: "success" };
		if (diffMins < 60) return { text: `${diffMins}m ago`, color: "success" };
		if (diffHours < 24) return { text: `${diffHours}h ago`, color: "warning" };
		if (diffDays === 1) return { text: "1d ago", color: "muted" };
		if (diffDays < 7) return { text: `${diffDays}d ago`, color: "muted" };
		return { text: date.toLocaleDateString(), color: "dim" };
	}

	function shortenPathForResume(targetPath: string): string {
		if (!targetPath) return "(unknown cwd)";
		const parts = targetPath.split(path.sep).filter(Boolean);
		if (parts.length <= 3) return targetPath;
		return `...${path.sep}${parts.slice(-3).join(path.sep)}`;
	}

	interface ResumeUiDependencies {
		Ellipsis: { Omit: number; Ascii: number; Unicode: number };
		Input: new () => {
			focused: boolean;
			render: (width: number) => string[];
			handleInput: (keyData: string) => void;
			getValue: () => string;
			invalidate: () => void;
		};
		matchesKey: (keyData: string, key: string) => boolean;
		truncateToWidth: (text: string, width: number, ellipsis: number) => string;
		visibleWidth: (text: string) => number;
	}

	const loadResumeUiDependencies = async (): Promise<ResumeUiDependencies> => {
		const { Ellipsis, Input, matchesKey, truncateToWidth, visibleWidth } =
			await import("@oh-my-pi/pi-tui");
		return { Ellipsis, Input, matchesKey, truncateToWidth, visibleWidth };
	};

	async function handleResumeCommand(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Resume requires interactive mode", "warning");
			return;
		}

		const sessions = await collectSessionInfos(ctx);
		if (sessions.length === 0) {
			ctx.ui.notify("No sessions found", "info");
			return;
		}

		const enriched = await enrichSessions(sessions, ARCHIVE_THRESHOLD_DAYS);
		const activeSessions = enriched.filter((session) => !session.isArchived);
		const archivedSessions = enriched.filter((session) => session.isArchived);

		const groups = new Set(enriched.map((session) => session.worktreeGroup));
		const tabIds = [
			"All",
			...Array.from(groups)
				.filter((group) => group !== "main")
				.sort(),
		];
		if (groups.has("main")) tabIds.push("main");

		let selectedPath: string | null = null;
		let resumeUiFallbackReason: string | undefined;
		let resumeUiDependencies: ResumeUiDependencies | undefined;
		try {
			resumeUiDependencies = await loadResumeUiDependencies();
		} catch (error) {
			resumeUiFallbackReason =
				error instanceof Error ? error.message : String(error);
		}

		if (resumeUiDependencies) {
			try {
				const { Ellipsis, Input, matchesKey, truncateToWidth, visibleWidth } =
					resumeUiDependencies;
				selectedPath = await ctx.ui.custom<string | null>(
					async (
						tui: unknown,
						uiTheme: unknown,
						_keybindings: unknown,
						done: (v: string | null) => void,
					) => {
						const searchInput = new Input();
						searchInput.focused = true;

						const state = {
							activeTabIndex: 0,
							selectedIndex: 0,
							searchQuery: "",
							showArchived: false,
							filteredSessions: activeSessions,
							maxVisible: 6,
						};

						const resolveEllipsis = (): number => {
							const configured = uiTheme.format?.ellipsis;
							if (configured === "") return Ellipsis.Omit;
							if (configured === "...") return Ellipsis.Ascii;
							return Ellipsis.Unicode;
						};
						const currentTab = (): string =>
							tabIds[state.activeTabIndex] ?? "All";
						const sessionsForCurrentTab = (): EnrichedSession[] => {
							const source = state.showArchived
								? archivedSessions
								: activeSessions;
							const tab = currentTab();
							if (tab === "All") return source;
							return source.filter((session) => session.worktreeGroup === tab);
						};

						const applyFilter = (): void => {
							const source = sessionsForCurrentTab();
							const query = state.searchQuery.trim();
							if (!query) {
								state.filteredSessions = source;
							} else {
								state.filteredSessions = source.filter((session) => {
									const searchable = [
										session.id,
										session.title ?? "",
										session.firstMessage,
										session.cwd,
										session.allMessagesText,
									].join(" ");
									return fuzzyMatch(query, searchable);
								});
							}
							if (state.filteredSessions.length === 0) {
								state.selectedIndex = 0;
							} else {
								state.selectedIndex = Math.min(
									state.selectedIndex,
									state.filteredSessions.length - 1,
								);
							}
						};

						const renderTabLine = (width: number): string => {
							const parts: string[] = [];
							parts.push(
								uiTheme.fg(
									"dim",
									`${state.showArchived ? "Archived" : "Sessions"}: `,
								),
							);
							for (let i = 0; i < tabIds.length; i++) {
								const tab = tabIds[i] ?? "All";
								const tabLabel = ` ${tab} `;
								const styled =
									i === state.activeTabIndex
										? uiTheme.bold(
												uiTheme.bg("selectedBg", uiTheme.fg("text", tabLabel)),
											)
										: uiTheme.fg("muted", tabLabel);
								parts.push(styled);
								if (i < tabIds.length - 1) parts.push(" ");
							}
							parts.push("  ");
							parts.push(uiTheme.fg("dim", "(Tab/Shift+Tab)"));
							const line = parts.join("");
							const ellipsis = resolveEllipsis();
							return truncateToWidth(line, width, ellipsis);
						};

						const renderList = (width: number): string[] => {
							const lines: string[] = [];
							const ellipsis = resolveEllipsis();
							if (state.filteredSessions.length === 0) {
								const emptyText = state.searchQuery.trim()
									? "No sessions match your search"
									: state.showArchived
										? "No archived sessions"
										: "No sessions in this group";
								lines.push(
									truncateToWidth(
										uiTheme.fg("muted", `  ${emptyText}`),
										width,
										ellipsis,
									),
								);
								return lines;
							}

							const startIndex = Math.max(
								0,
								Math.min(
									state.selectedIndex - Math.floor(state.maxVisible / 2),
									state.filteredSessions.length - state.maxVisible,
								),
							);
							const endIndex = Math.min(
								startIndex + state.maxVisible,
								state.filteredSessions.length,
							);

							for (let i = startIndex; i < endIndex; i++) {
								const session = state.filteredSessions[i];
								if (!session) continue;
								const isSelected = i === state.selectedIndex;
								const cursorGlyph = `${uiTheme.nav.cursor} `;
								const cursorWidth = visibleWidth(cursorGlyph);
								const cursor = isSelected
									? uiTheme.fg("accent", cursorGlyph)
									: " ".repeat(cursorWidth);

								const worktreeBadge =
									session.worktreeGroup !== "main"
										? `${uiTheme.bg("selectedBg", uiTheme.fg("accent", ` ${session.worktreeGroup} `))} `
										: "";

								const primaryText =
									(session.title ?? session.firstMessage ?? session.id)
										.replace(/\s+/g, " ")
										.trim() || session.id;
								const titleWidth = Math.max(
									12,
									width - visibleWidth(cursor) - visibleWidth(worktreeBadge),
								);
								const title = truncateToWidth(
									primaryText,
									titleWidth,
									ellipsis,
								);
								const firstLine = truncateToWidth(
									`${cursor}${worktreeBadge}${isSelected ? uiTheme.bold(title) : title}`,
									width,
									ellipsis,
								);
								lines.push(firstLine);

								const timeInfo = formatRelativeTime(session.modified);
								const timeText = uiTheme.fg(timeInfo.color, timeInfo.text);
								const modeText =
									session.agentMode === "orchestrator"
										? uiTheme.bold(uiTheme.fg("warning", "Orchestrator"))
										: session.agentMode === "default"
											? uiTheme.fg("success", "Default")
											: uiTheme.fg("dim", "unknown");
								const pathText = uiTheme.fg(
									"dim",
									shortenPathForResume(session.cwd),
								);
								const messageText = uiTheme.fg(
									"dim",
									`${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`,
								);
								const sep = uiTheme.fg("dim", " · ");
								const meta = `  ${timeText}${sep}${modeText}${sep}${pathText}${sep}${messageText}`;
								lines.push(truncateToWidth(meta, width, ellipsis));
								lines.push("");
							}

							if (state.filteredSessions.length > state.maxVisible) {
								const scroll = uiTheme.fg(
									"muted",
									`  (${state.selectedIndex + 1}/${state.filteredSessions.length})`,
								);
								lines.push(truncateToWidth(scroll, width, ellipsis));
							}

							return lines;
						};

						const component = {
							render: (width: number): string[] => {
								const lines: string[] = [];
								const normalizedWidth = Math.max(20, width);
								const ellipsis = resolveEllipsis();
								lines.push("");
								lines.push(
									truncateToWidth(
										uiTheme.bold(
											state.showArchived
												? "Resume Session (Archived)"
												: "Resume Session",
										),
										normalizedWidth,
										ellipsis,
									),
								);
								lines.push("");
								lines.push(renderTabLine(normalizedWidth));
								lines.push("");
								lines.push(...searchInput.render(normalizedWidth));
								lines.push("");

								const hintParts = [
									uiTheme.fg("dim", "Enter"),
									": resume  ",
									uiTheme.fg("dim", "Esc"),
									": cancel  ",
									uiTheme.fg("dim", "A"),
									state.showArchived ? ": back to active" : ": archived",
									"  ",
									uiTheme.fg("dim", "↑/↓ PgUp/PgDn"),
									": navigate",
								];
								const hintLine = truncateToWidth(
									` ${hintParts.join("")}`,
									normalizedWidth,
									ellipsis,
								);
								lines.push(hintLine);
								lines.push("");
								lines.push(...renderList(normalizedWidth));
								return lines;
							},
							handleInput: (keyData: string): void => {
								if (
									(matchesKey(keyData, "tab") ||
										matchesKey(keyData, "right")) &&
									tabIds.length > 0
								) {
									state.activeTabIndex =
										(state.activeTabIndex + 1) % tabIds.length;
									state.selectedIndex = 0;
									applyFilter();
									tui.requestRender();
									return;
								}
								if (
									(matchesKey(keyData, "shift+tab") ||
										matchesKey(keyData, "left")) &&
									tabIds.length > 0
								) {
									state.activeTabIndex =
										(state.activeTabIndex - 1 + tabIds.length) % tabIds.length;
									state.selectedIndex = 0;
									applyFilter();
									tui.requestRender();
									return;
								}

								if (matchesKey(keyData, "up")) {
									state.selectedIndex = Math.max(0, state.selectedIndex - 1);
									tui.requestRender();
									return;
								}
								if (matchesKey(keyData, "down")) {
									if (state.filteredSessions.length > 0) {
										state.selectedIndex = Math.min(
											state.filteredSessions.length - 1,
											state.selectedIndex + 1,
										);
									}
									tui.requestRender();
									return;
								}
								if (matchesKey(keyData, "pageUp")) {
									state.selectedIndex = Math.max(
										0,
										state.selectedIndex - state.maxVisible,
									);
									tui.requestRender();
									return;
								}
								if (matchesKey(keyData, "pageDown")) {
									if (state.filteredSessions.length > 0) {
										state.selectedIndex = Math.min(
											state.filteredSessions.length - 1,
											state.selectedIndex + state.maxVisible,
										);
									}
									tui.requestRender();
									return;
								}

								if (
									matchesKey(keyData, "enter") ||
									matchesKey(keyData, "return") ||
									keyData === "\n"
								) {
									const selected = state.filteredSessions[state.selectedIndex];
									if (selected) done(selected.path);
									return;
								}

								if (
									matchesKey(keyData, "escape") ||
									matchesKey(keyData, "esc") ||
									matchesKey(keyData, "ctrl+c")
								) {
									done(null);
									return;
								}

								if (
									(keyData === "a" || keyData === "A") &&
									!state.searchQuery.trim()
								) {
									state.showArchived = !state.showArchived;
									state.selectedIndex = 0;
									applyFilter();
									tui.requestRender();
									return;
								}

								searchInput.handleInput(keyData);
								state.searchQuery = searchInput.getValue();
								applyFilter();
								tui.requestRender();
							},
							invalidate: () => {
								searchInput.invalidate();
							},
						};

						applyFilter();
						return component;
					},
				);
			} catch (error) {
				resumeUiFallbackReason =
					error instanceof Error ? error.message : String(error);
			}
		}

		if (resumeUiFallbackReason) {
			ctx.ui.notify(
				`Custom /resume UI unavailable (${resumeUiFallbackReason}). Falling back to basic selector.`,
				"warning",
			);
			const fallbackSessions =
				activeSessions.length > 0 ? activeSessions : enriched;
			const fallbackOptions = fallbackSessions.map((session, index) => {
				const summary =
					(session.title ?? session.firstMessage ?? session.id)
						.replace(/\s+/g, " ")
						.trim() || session.id;
				const modeLabel =
					session.agentMode === "orchestrator"
						? "Orchestrator"
						: session.agentMode === "default"
							? "Default"
							: "Unknown";
				const label = `${String(index + 1).padStart(2, "0")} · ${modeLabel} · ${summary.slice(0, 80)} · ${shortenPathForResume(session.cwd)}`;
				return { label, path: session.path };
			});
			const choice = await ctx.ui.select(
				"Resume Session (fallback selector)",
				fallbackOptions.map((option) => option.label),
			);
			selectedPath =
				fallbackOptions.find((option) => option.label === choice)?.path ?? null;
		}

		if (!selectedPath) return;

		const selectedSession = enriched.find(
			(session) => session.path === selectedPath,
		);
		const sessionDiskMetadata = readResumeSessionDiskMetadata(selectedPath);
		const preSwitchTarget = chooseResumeTargetCwd([
			sessionDiskMetadata.persistedWorktreePath,
			sessionDiskMetadata.cwd,
			selectedSession?.cwd,
		]);
		const preSwitchPinned = applyResumeCwd(preSwitchTarget);

		let didSwitch = false;
		if (typeof ctx.switchSession === "function") {
			await ctx.switchSession(selectedPath);
			didSwitch = true;
		} else {
			const runtimeSessionManager = ctx.sessionManager as unknown as {
				loadSession?: (sessionPath: string) => Promise<void>;
				switchSession?: (sessionPath: string) => Promise<void>;
				_initSessionFile?: (sessionPath: string) => Promise<void>;
			};

			if (typeof runtimeSessionManager.switchSession === "function") {
				await runtimeSessionManager.switchSession(selectedPath);
				didSwitch = true;
			} else if (typeof runtimeSessionManager.loadSession === "function") {
				await runtimeSessionManager.loadSession(selectedPath);
				didSwitch = true;
			}
		}

		if (didSwitch) {
			repinToResumedSessionCwd(ctx, [preSwitchPinned, preSwitchTarget]);
			return;
		}

		if (typeof ctx.newSession === "function") {
			let resumedViaSetup = false;
			await ctx.newSession({
				parentSession: selectedPath,
				setup: async (sessionManager: unknown) => {
					const writableRuntimeManager = sessionManager as unknown as {
						loadSession?: (sessionPath: string) => Promise<void>;
						switchSession?: (sessionPath: string) => Promise<void>;
						_initSessionFile?: (sessionPath: string) => Promise<void>;
					};
					if (typeof writableRuntimeManager.switchSession === "function") {
						await writableRuntimeManager.switchSession(selectedPath);
						resumedViaSetup = true;
						return;
					}
					if (typeof writableRuntimeManager.loadSession === "function") {
						await writableRuntimeManager.loadSession(selectedPath);
						resumedViaSetup = true;
						return;
					}
					if (typeof writableRuntimeManager._initSessionFile === "function") {
						await writableRuntimeManager._initSessionFile(selectedPath);
						resumedViaSetup = true;
					}
				},
			});

			if (resumedViaSetup) {
				repinToResumedSessionCwd(ctx, [preSwitchPinned, preSwitchTarget]);
			} else {
				ctx.ui.notify(
					"Opened a new session linked to selection (direct session switch API unavailable).",
					"warning",
				);
			}
			return;
		}

		ctx.ui.notify(
			"Could not switch session — no supported API found.",
			"error",
		);
	}

	pi.registerCommand("resume-ui", {
		description: "Resume a previous session with worktree-aware navigator",
		handler: async (_args, ctx) => {
			await handleResumeCommand(ctx);
		},
	});

	registerCleanupCommand(pi, { onComplete: handleCleanupComplete });
	registerSubmitPrCommand(pi, {
		onSuccess: async (ctx) => {
			setActionButton(ctx, "cleanup");
			persistWorktreeState();
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;

		const rawPath =
			typeof input.path === "string"
				? input.path
				: typeof input.notebook_path === "string"
					? input.notebook_path
					: undefined;

		const enforceOrchestratorGuards = shouldEnforceOrchestratorGuards({
			activeAgentIsParentTurn,
			parentRuntimeRole: activeParentRuntimeRole,
		});
		if (
			enforceOrchestratorGuards &&
			!isOrchestratorParentToolAllowed(event.toolName)
		) {
			return {
				block: true,
				reason:
					`Orchestrator mode: parent tool '${event.toolName}' is disabled. ` +
					"Delegate via Task subagents (task tool), or use ask for clarifications.",
			};
		}

		if (event.toolName === "task") {
			// Auto-inject default skills for known agent types
			const taskInput = input as Record<string, unknown>;
			if (
				typeof taskInput.agent === "string" &&
				taskInput.agent === "verifier"
			) {
				const VERIFIER_DEFAULT_SKILLS = ["qa-test-planner"];
				const existingSkills = Array.isArray(taskInput.skills)
					? (taskInput.skills as string[])
					: [];
				const missingSkills = VERIFIER_DEFAULT_SKILLS.filter(
					(s) => !existingSkills.includes(s),
				);
				if (missingSkills.length > 0) {
					taskInput.skills = [...existingSkills, ...missingSkills];
					pi.logger.debug("plan-worktree: auto-injected verifier skills", {
						skills: taskInput.skills,
					});
				}

				// Sanitize oversized context that embeds full plan documents
				const rawCtx = typeof taskInput.context === "string" ? taskInput.context : "";
				const contextLooksLikeFullPlan =
					rawCtx.includes(VERIFIER_CONTEXT_FULL_PLAN_MARKER) ||
					rawCtx.length > VERIFIER_CONTEXT_SIZE_THRESHOLD;
				if (contextLooksLikeFullPlan && rawCtx.length > 0) {
					const planRef = last.planFilePath ?? (() => {
						try {
							const meta = findLatestPlanMetadata(ctx);
							if (meta) {
								return resolvePlanFilePath(meta.planFilePath, ctx.sessionManager.getCwd());
							}
						} catch { /* safe fallback — do not throw from tool_call hook */ }
						return undefined;
					})();
					if (planRef) {
						taskInput.context = [
							"## Plan Reference (do NOT expect inline plan text)",
							`Plan file: \`${planRef}\``,
							"Read the plan file directly using the read tool. The full plan is NOT included in this context.",
							last.planWorkspaceDir ? `Plan workspace: \`${last.planWorkspaceDir}\`` : "",
							last.worktreePath ? `Worktree: \`${last.worktreePath}\`` : "",
						].filter(Boolean).join("\n");
						pi.logger.debug("plan-worktree: sanitized verifier context", {
							originalLength: rawCtx.length,
							planRef,
						});
					}
				}
			}
			readBudget.resetForNextDelegation();
			const snapshotCwd = normalizePath(
				last.worktreePath ?? last.repoRoot ?? process.cwd(),
			);
			preTaskSnapshot = await captureGitStatusSnapshot(snapshotCwd);
		}
		if (!setupDone || !last.worktreePath) {
			if (enforceOrchestratorGuards && event.toolName === "read") {
				const readPath =
					typeof input.path === "string" ? input.path.trim() : "";
				if (!readPath) {
					return {
						block: true,
						reason: "Orchestrator mode: read requires an explicit path.",
					};
				}
				const budgetResult = readBudget.tryRead(readPath);
				if (!budgetResult.allowed) {
					return {
						block: true,
						reason: budgetResult.reason,
					};
				}
			}
			if (enforceOrchestratorGuards && event.toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				if (!/^git\s+status(?:\s|$)/.test(command.trim())) {
					return {
						block: true,
						reason:
							"Orchestrator mode: bash is limited to `git status` while worktree state is unresolved.",
					};
				}
			}
			if (!MUTATING_TOOL_NAMES.has(event.toolName) || !rawPath) return;
			const resolved = isRepoRelativePlanPath(rawPath)
				? resolveRepoRelativePlanPath(rawPath, process.cwd())
				: normalizePath(
						path.isAbsolute(rawPath)
							? rawPath
							: path.resolve(process.cwd(), rawPath),
					);
			if (isDocsPlanMarkdownPath(resolved)) {
				persistPlanMetadata(pi, resolved);
				setActionButton(ctx, "implement");
				pi.logger.debug("plan-worktree: captured /plan-new metadata", {
					planFilePath: resolved,
				});
			}
			return;
		}

		const worktreeRoot = normalizePath(last.worktreePath);
		if (enforceOrchestratorGuards && event.toolName === "read") {
			const readPath = typeof input.path === "string" ? input.path.trim() : "";
			if (!readPath) {
				return {
					block: true,
					reason:
						"Orchestrator mode: read requires an explicit path inside the active worktree.",
				};
			}
			let readBudgetKey = readPath;
			if (!isOrchestratorReadProtocolPath(readPath)) {
				const resolvedReadPath = isRepoRelativePlanPath(readPath)
					? resolveRepoRelativePlanPath(readPath, worktreeRoot)
					: normalizePath(
							path.isAbsolute(readPath)
								? readPath
								: path.resolve(process.cwd(), readPath),
						);
				if (!isInside(worktreeRoot, resolvedReadPath)) {
					return {
						block: true,
						reason:
							"Orchestrator mode: parent read must stay inside the active worktree.",
					};
				}
				readBudgetKey = resolvedReadPath;
			}
			const budgetResult = readBudget.tryRead(readBudgetKey);
			if (!budgetResult.allowed) {
				return {
					block: true,
					reason: budgetResult.reason,
				};
			}
		}
		if (event.toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			const isCodeRabbitCommand =
				/(^|\s)(?:[^\s]*\/)?(?:coderabbit|cr)(\s|$)/.test(command);
			const hasExplicitCwd = typeof input.cwd === "string";
			if (
				enforceOrchestratorGuards &&
				!/^git\s+status(?:\s|$)/.test(command.trim())
			) {
				return {
					block: true,
					reason:
						"Orchestrator mode: bash is limited to `git status` in the active worktree.",
				};
			}
			if (isCodeRabbitCommand && !hasExplicitCwd) {
				return {
					block: true,
					reason:
						`Worktree isolation guard: CodeRabbit bash calls must pass explicit cwd inside ${worktreeRoot}. ` +
						"Retry with bash cwd set to the worktree path.",
				};
			}
			if (isCodeRabbitCommand) {
				const currentTimeout = typeof input.timeout === "number" ? input.timeout : 300;
				if (currentTimeout < 600) {
					input.timeout = 600;
				}
			}
			const providedCwd = hasExplicitCwd
				? (input.cwd as string)
				: process.cwd();
			const resolvedCwd = normalizePath(providedCwd);
			if (!isInside(worktreeRoot, resolvedCwd)) {
				return {
					block: true,
					reason:
						`Worktree isolation guard: bash cwd must stay inside ${worktreeRoot}. ` +
						`Received cwd=${providedCwd}`,
				};
			}
			return;
		}

		if (MUTATING_TOOL_NAMES.has(event.toolName)) {
			if (enforceOrchestratorGuards) {
				return {
					block: true,
					reason:
						"Orchestrator mode: parent agent cannot mutate files directly. Delegate edits via Task subagents.",
				};
			}
			if (!rawPath) return;
			const resolvedPath = normalizePath(
				path.isAbsolute(rawPath)
					? rawPath
					: path.resolve(process.cwd(), rawPath),
			);
			if (!isInside(worktreeRoot, resolvedPath)) {
				const planDir = last.planWorkspaceDir
					? normalizePath(last.planWorkspaceDir)
					: undefined;
				if (!planDir || !isInside(planDir, resolvedPath)) {
					return {
						block: true,
						reason: `Worktree isolation guard: file mutations must stay inside ${worktreeRoot}. Received path=${rawPath}`,
					};
				}
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "task") return;
		pendingTaskResultCompaction = true;

		const snapshotCwd = normalizePath(
			last.worktreePath ?? last.repoRoot ?? process.cwd(),
		);
		const postTaskSnapshot = await captureGitStatusSnapshot(snapshotCwd);
		const changedFiles = computeFilesDelta(preTaskSnapshot, postTaskSnapshot);
		readBudget.transitionToPostTask(changedFiles);

		const taskResultText = flattenMessageContent(event.content);
		const hasSubmitResultDeadlock =
			/SYSTEM WARNING:\s*Subagent exited without calling submit_result/i.test(
				taskResultText,
			) ||
			/Orchestrator mode:\s*parent tool 'submit_result' is disabled/i.test(
				taskResultText,
			);
		if (hasSubmitResultDeadlock) {
			pi.logger.error(
				"plan-worktree: quality gate blocked by subagent submit_result deadlock",
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Quality gate blocked: subagent submit_result deadlock detected",
					"error",
				);
			}
		}

		if (setupDone && last.worktreePath) {
			try {
				await syncWorktreeBranchToRemote(ctx, "post-task");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				pendingRemoteSyncError = msg;
				pi.logger.error("plan-worktree: remote sync failed after task", {
					error: msg,
					branchName: last.branchName,
					worktreePath: last.worktreePath,
				});
				if (ctx.hasUI) {
					ctx.ui.notify(`Remote sync failed after task: ${msg}`, "error");
				}
				pi.sendMessage({
					customType: "plan-worktree/remote-sync-failed",
					content: [
						"## Remote sync failed",
						"",
						`Task completion produced local commits that could not be pushed to origin/${last.branchName ?? "(unknown)"}.`,
						`Error: ${msg}`,
						"Resolve remote/auth conflicts, then run: `git push --set-upstream origin <branch>` from the active worktree.",
					].join("\n"),
					display: true,
					details: {
						error: msg,
						branchName: last.branchName,
						worktreePath: last.worktreePath,
					},
				});
			}
		}

		if (hasSubmitResultDeadlock) {
			const existingDetails =
				event.details &&
				typeof event.details === "object" &&
				!Array.isArray(event.details)
					? (event.details as Record<string, unknown>)
					: {};
			return {
				isError: true,
				details: {
					...existingDetails,
					qualityGateBlocked: true,
					blocker: "subagent_missing_submit_result",
				},
				content: [
					...event.content,
					{
						type: "text",
						text: "BLOCKED: Quality gate subagent exited without submit_result. Treat this Task result as failed and spawn remediation; do not mark the phase complete.",
					},
				],
			};
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!setupDone || !last.worktreePath) return;
		if (pendingUpdateVersionFinalize) {
			pendingUpdateVersionFinalize = false;
			await finalizeUpdateVersionRun(ctx);
		}
		if (!pendingTaskResultCompaction) return;
		pendingTaskResultCompaction = false;
		if (!isOrchestratorAutoCompactEnabled()) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const threshold = getAutoCompactThresholdPercent();
		if (usage.percent < threshold) return;
		const now = Date.now();
		if (now - lastAutoCompactAt < AUTO_COMPACT_COOLDOWN_MS) return;
		try {
			if (ctx.hasUI)
				ctx.ui.setStatus(
					AUTO_COMPACT_STATUS_KEY,
					"orchestrator: compacting context...",
				);
			await ctx.compact(
				[
					"Compact this implementation session for orchestrator efficiency.",
					"Preserve only:",
					"- active worktree branch/path",
					"- current and remaining plan phases",
					"- unresolved blockers and exact next actions",
					"Drop detailed historical tool transcripts and already-resolved implementation detail.",
				].join("\n"),
			);
			lastAutoCompactAt = Date.now();
			if (ctx.hasUI)
				ctx.ui.notify(
					"Orchestrator auto-compact completed after task phase",
					"info",
				);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			pi.logger.warn("plan-worktree: orchestrator auto-compact failed", {
				error: msg,
			});
			if (ctx.hasUI)
				ctx.ui.notify(`Orchestrator auto-compact failed: ${msg}`, "warning");
		} finally {
			if (ctx.hasUI) ctx.ui.setStatus(AUTO_COMPACT_STATUS_KEY, undefined);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Capture session title from first user message (once per session)
		if (!sessionTitleCaptured) {
			const entries = ctx.sessionManager.getEntries() as Array<{
				type?: string;
				customType?: string;
				role?: string;
				content?: unknown;
				data?: unknown;
			}>;

			// Check if title already stored
			const hasTitle = entries.some(
				(e) => e.type === "custom" && e.customType === "session-title",
			);
			if (!hasTitle) {
				// Find first user message
				const userEntry = entries.find(
					(e) => e.role === "user" || e.type === "user",
				);
				if (userEntry) {
					const rawContent =
						typeof userEntry.content === "string"
							? userEntry.content
							: Array.isArray(userEntry.content)
								? (userEntry.content as Array<{ type?: string; text?: string }>)
										.filter((c) => c?.type === "text")
										.map((c) => c.text ?? "")
										.join(" ")
								: "";
					const cleaned = rawContent
						.replace(/^[/\\]+/, "")
						.replace(/\s+/g, " ")
						.replace(/[\r\n]+/g, " ")
						.trim()
						.slice(0, 72);
					if (cleaned.length > 5) {
						pi.appendEntry("session-title", {
							title: cleaned,
							generatedAt: Date.now(),
						});
						sessionTitleCaptured = true;
						pi.logger.debug("plan-worktree: captured session title", {
							title: cleaned,
						});
					}
				}
			} else {
				sessionTitleCaptured = true;
			}
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (/your assignment is below\./i.test(event.prompt) || /═══════════Task═══════════/.test(event.prompt)) {
			activeAgentIsParentTurn = false;
			activeParentRuntimeRole = "default";
			return;
		}
		if (!ctx.hasUI) {
			activeAgentIsParentTurn = false;
			activeParentRuntimeRole = "default";
			return;
		}
		const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.();
		const isNestedTaskSession = typeof sessionFile === "string" && /\/\d+-[^/]+\.jsonl$/.test(sessionFile);
		const promptText = event.prompt?.trim() ?? "";
		const delegatedPrompt = promptText.length > 0 && isSubagentTurn(event.systemPrompt, promptText);
		activeAgentIsParentTurn = !isNestedTaskSession && promptText.length > 0 && !delegatedPrompt;
		const lastModelRole = activeAgentIsParentTurn
			? getLastModelChangeRole(ctx)
			: undefined;
		const hasExplicitSessionRole =
			activeAgentIsParentTurn && lastModelRole !== undefined;
		activeParentRuntimeRole = activeAgentIsParentTurn
			? isOrchestratorParentMode() && !hasExplicitSessionRole
				? "orchestrator"
				: resolveParentRuntimeRole(lastModelRole)
			: "default";

		// Bypass orchestrator mode for native /handoff — the agent must directly generate
		// the handoff document, not delegate it to subagents.
		const isNativeHandoffPrompt =
			activeAgentIsParentTurn &&
			activeParentRuntimeRole === "orchestrator" &&
			typeof event.prompt === "string" &&
			event.prompt.includes(
				"Write a comprehensive handoff document that will allow another instance",
			);
		if (isNativeHandoffPrompt) {
			activeParentRuntimeRole = "default";
			pi.logger.debug(
				"plan-worktree: bypassing orchestrator mode for native /handoff",
			);
		}

		if (activeAgentIsParentTurn && activeParentRuntimeRole === "orchestrator") {
			readBudget.resetForNextDelegation();
		}
		if (setupDone && last.worktreePath) {
			try {
				await ensurePinnedToWorktree();
				if (pendingRemoteSyncError) {
					await syncWorktreeBranchToRemote(ctx, "retry pending sync");
					if (ctx.hasUI) {
						ctx.ui.notify("Recovered pending remote sync to origin", "info");
					}
				}
				if (activeAgentIsParentTurn) {
					if (activeParentRuntimeRole === "orchestrator") {
						await ensureOrchestratorRuntimeDefaults(ctx);
					} else {
						await ensureDefaultRuntimeDefaults(ctx);
					}
				} else {
					pi.logger.debug(
						"plan-worktree: skipping parent runtime default sync for subagent turn",
					);
				}
				setActionButton(ctx, actionButtonStage);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				pi.logger.error("plan-worktree: failed to prepare worktree session", {
					error: msg,
				});
				if (ctx.hasUI)
					ctx.ui.notify(`worktree isolation error: ${msg}`, "error");
				ctx.abort();
				return;
			}
			if (hasInjectedSessionWorktreePrompt) return;
			const worktreePrompt = getWorktreePrompt();
			const orchestratorPrompt = activeAgentIsParentTurn
				? getOrchestratorPrompt()
				: "";
			if (!worktreePrompt && !orchestratorPrompt) return;
			hasInjectedSessionWorktreePrompt = true;
			return {
				systemPrompt: event.systemPrompt + worktreePrompt + orchestratorPrompt,
			};
		} else {
			// Non-worktree sessions: sync thinking from model-role-thinking.json for parent turns.
			if (activeAgentIsParentTurn) {
				const persistedLevels = readModelRoleThinkingLevels();
				const thinkingLevel =
					(lastModelRole ? persistedLevels[lastModelRole] : undefined) ??
					persistedLevels[activeParentRuntimeRole];
				if (thinkingLevel) {
					pi.setThinkingLevel(thinkingLevel);
					pi.logger.debug("plan-worktree: applied non-worktree role thinking level", {
						role: lastModelRole ?? activeParentRuntimeRole,
						level: thinkingLevel,
					});
				}
				const hasAugmentRetrievalTool = pi
					.getActiveTools()
					.some((tool) => tool.name === "mcp_augment_codebase_retrieval");
				const workspacePath = process.cwd();
				if (
					hasAugmentRetrievalTool &&
					!warmedAuggieWorkspacePaths.has(workspacePath)
				) {
					const warmed = await bestEffortAuggieIndex(pi, ctx, workspacePath, {
						statusKey: "auggie-index",
						statusText: "auggie: warming context index...",
						missingCliNotify: null,
						failureNotify: null,
						successNotify: null,
						timeoutMs: 45_000,
					});
					if (warmed) {
						warmedAuggieWorkspacePaths.add(workspacePath);
					}
				}
			}
		}
	});
}

// =============================================================================
// Git helpers (use Bun.spawn for reliable stdio capture)
// =============================================================================

const OTHER_CHOICE = "Other (type custom...)";
type ActionButtonStage =
	| "plan"
	| "implement"
	| "submit-pr"
	| "fix-issues"
	| "update-version"
	| "cleanup"
	| "none";
const PERSISTED_WORKTREE_STATE_TYPE = "plan-worktree/state";
const IMPLEMENT_COMMAND = "implement";
const REVIEW_COMPLETE_COMMAND = "review-complete";
const FIX_ISSUES_COMMAND = "fix-issues";
const UPDATE_VERSION_WORKFLOW_COMMAND = "update-version-workflow";
const DELETE_WORKTREE_COMMAND = "delete-worktree";
const PERSISTED_PLAN_METADATA_TYPE = "plan-worktree/plan-new-metadata";
const PERSISTED_REVIEW_FINDINGS_TYPE = "plan-worktree/review-findings";
const PERSISTED_PLANNED_WORKTREE_SELECTION_TYPE =
	"plan-worktree/planned-selection";
const CURATOR_BRANCH_SUGGEST_TIMEOUT_MS = 10_000;
const PLAN_WORKFLOW_STATUS_KEY = "aaa-wt-worktree";
const SYNC_NEEDED_STATUS_KEY = "bbb-wt-sync";
const IMPLEMENT_WORKFLOW_STATUS_KEY = "ccc-wt-git";
const REVIEW_COMPLETE_STATUS_KEY = "ddd-wt-review";
const CLEANUP_WORKFLOW_STATUS_KEY = "eee-wt-cleanup";
const PLAN_REVIEW_STATUS_KEY = "fff-wt-plan-review";
const FIX_PLAN_STATUS_KEY = "ggg-wt-fix-plan";
const SPACER_STATUS_KEY = "zzzz-0-spacer";
const DELETE_WORKTREE_STATUS_KEY = "zzzz-wt-delete";
const REVIEW_COMPLETE_PROGRESS_STATUS_KEY = "review-complete";
const FIX_ISSUES_PROGRESS_STATUS_KEY = "fix-issues";
const IMPLEMENT_PROGRESS_STATUS_KEY = "implement-workflow-start";
const UPDATE_VERSION_PROGRESS_STATUS_KEY = "update-version-workflow";
const DELETE_WORKTREE_PROGRESS_STATUS_KEY = "delete-worktree";
const REMOTE_SYNC_STATUS_KEY = "worktree-remote-sync";
const AUTO_COMPACT_STATUS_KEY = "orchestrator-auto-compact";
const AUTO_COMPACT_COOLDOWN_MS = 60_000;
const FALSE_ENV_VALUES = ["0", "false", "off", "no"];
const VERIFIER_CONTEXT_FULL_PLAN_MARKER = "FULL PLAN DOCUMENT (verbatim)";
const VERIFIER_CONTEXT_SIZE_THRESHOLD = 4000;
const REVIEW_COMPLETE_ACTION_TEXT = "\x1b[30;44m Review \x1b[0m";
const FIX_ISSUES_ACTION_TEXT = "\x1b[30;47m Fix Issues \x1b[0m";
const UPDATE_VERSION_ACTION_TEXT = "\x1b[30;46m Update Version \x1b[0m";
const DELETE_WORKTREE_ACTION_TEXT = "\x1b[30;41m \u2715 Worktree \x1b[0m";
const SYNC_NEEDED_ACTION_TEXT = "\x1b[30;103m ! Sync \x1b[0m";
const FREEFORM_WORKTREE_ACTION_TEXT = "\x1b[30;45m Freeform \x1b[0m";
const PLANNED_WORKTREE_ACTION_TEXT = "\x1b[30;46m Planned \x1b[0m";
const CLEANUP_WORKTREES_ACTION_TEXT = "\x1b[30;43m Cleanup \x1b[0m";
const PLAN_REVIEW_ACTION_TEXT = "\x1b[30;42m Plan Review \x1b[0m";
const FIX_PLAN_ACTION_TEXT = "\x1b[30;42m Fix Plan \x1b[0m";
const GIT_MENU_ACTION_TEXT = "\x1b[30;42m Git \x1b[0m";
const UPDATE_VERSION_COMMIT_FILES = [
	"./Cargo.toml",
	"./app/src-tauri/Cargo.toml",
	"./app/package.json",
	"./app/src-tauri/tauri.conf.json",
	"./app/package-lock.json",
	"./CHANGELOG.md",
];

const WORKFLOW_PATCH_NAME = "implement-workflow-clickable-v11.7.2";
const WORKFLOW_PATCH_SCRIPT_PATH = path.join(
	os.homedir(),
	".omp",
	"agent",
	"patches",
	WORKFLOW_PATCH_NAME,
	"manage.sh",
);
const WORKFLOW_PATCH_BUNDLED_INTERACTIVE_MODE_PATH = path.join(
	os.homedir(),
	".omp",
	"agent",
	"patches",
	WORKFLOW_PATCH_NAME,
	"files",
	"pi-coding-agent",
	"src",
	"modes",
	"interactive-mode.ts",
);
const WORKFLOW_PATCH_RUNTIME_INTERACTIVE_MODE_PATH = path.join(
	os.homedir(),
	".bun",
	"install",
	"global",
	"node_modules",
	"@oh-my-pi",
	"pi-coding-agent",
	"src",
	"modes",
	"interactive-mode.ts",
);
const WORKFLOW_PATCH_REQUIRED_BUTTON_COMMANDS = [
	"/freeform-worktree",
	"/planned-worktree",
	"/review-complete",
	"/cleanup-worktrees",
];

function isEnvFlagDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return Boolean(normalized && FALSE_ENV_VALUES.includes(normalized));
}

function isWorkflowPatchGuardEnabled(): boolean {
	return !isEnvFlagDisabled(process.env.OMP_IMPLEMENT_PATCH_GUARD);
}

function isWorkflowPatchAutoApplyEnabled(): boolean {
	return !isEnvFlagDisabled(process.env.OMP_IMPLEMENT_PATCH_AUTO_APPLY);
}

function isWorkflowPatchAutoForceEnabled(): boolean {
	const normalized = process.env.OMP_IMPLEMENT_PATCH_AUTO_FORCE?.trim().toLowerCase();
	if (!normalized) return false;
	if (FALSE_ENV_VALUES.includes(normalized)) return false;
	return ["1", "true", "on", "yes"].includes(normalized);
}

function hasRequiredWorkflowFooterButtonMapping(source: string): boolean {
	if (!source.includes("ACTION_BUTTONS: ActionButtonUi[]")) return false;
	return WORKFLOW_PATCH_REQUIRED_BUTTON_COMMANDS.every(command =>
		source.includes(`command: \"${command}\"`),
	);
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		if (!(await Bun.file(filePath).exists())) return undefined;
		return await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
}
interface PlanMetadata {
	planFilePath: string;
	entryId: string;
	timestamp: string;
}

interface PlanPhase {
	phaseNumber: number;
	title: string;
	markdown: string;
}

interface LegacyPhaseHeading {
	lineNumber: number;
	heading: string;
}

interface ReviewFindingsSnapshot {
	entryId: string;
	timestamp: string;
	content: string;
}

interface WorktreeSetupInput {
	topic: string;
	planFilePath: string;
	categoryOverride?: WorktreeCategory;
	baseBranchOverride?: string;
	branchNameOverride?: string;
}

interface WorktreeCategory {
	label: string;
	prefix: string;
}

const WORKTREE_CATEGORY_OPTIONS: WorktreeCategory[] = [
	{
		label: "breaking change (feat!): remove or replace behavior",
		prefix: "breaking/",
	},
	{ label: "feat: add functionality", prefix: "feature/" },
	{ label: "fix: resolve bug", prefix: "fix/" },
	{ label: "perf: improve performance", prefix: "perf/" },
	{ label: "refactor: internal restructure", prefix: "refactor/" },
	{ label: "docs: documentation changes", prefix: "docs/" },
	{ label: "chore: maintenance", prefix: "chore/" },
	{ label: "security: security patch", prefix: "security/" },
];

function findLatestPlanMetadata(
	ctx: ExtensionContext,
): PlanMetadata | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			customType?: string;
			id?: string;
			timestamp?: string;
			data?: unknown;
		};
		if (
			entry.type !== "custom" ||
			entry.customType !== PERSISTED_PLAN_METADATA_TYPE
		)
			continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const planFilePath = (entry.data as Record<string, unknown>).planFilePath;
		if (typeof planFilePath !== "string" || !planFilePath.trim()) continue;
		return {
			planFilePath: planFilePath.trim(),
			entryId: entry.id ?? "(unknown)",
			timestamp: entry.timestamp ?? "(unknown)",
		};
	}
	return undefined;
}

function findLatestPrimaryCheckoutWorkflowStageHint(
	ctx: ExtensionContext,
): ActionButtonStage | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			customType?: string;
			message?: { customType?: string };
			data?: unknown;
		};
		const customType = entry.customType ?? entry.message?.customType;
		if (!customType) continue;

		if (
			customType === "cleanup/complete" ||
			customType === "delete-worktree/complete"
		) {
			return undefined;
		}
		if (customType === "submit-pr/ready") {
			return "cleanup";
		}
		if (entry.type !== "custom" || customType !== PERSISTED_WORKTREE_STATE_TYPE)
			continue;
		if (!isPersistedWorktreeState(entry.data)) continue;
		const stage = normalizeActionButtonStage(entry.data.actionButtonStage);
		if (stage === "cleanup") return "cleanup";
		if (
			stage === "submit-pr" ||
			stage === "fix-issues" ||
			stage === "update-version"
		)
			return stage;
	}
	return undefined;
}

function persistPlanMetadata(pi: ExtensionAPI, planFilePath: string): void {
	pi.appendEntry(PERSISTED_PLAN_METADATA_TYPE, {
		planFilePath,
		updatedAt: Date.now(),
	});
}

function isRepoRelativePlanPath(planFilePath: string): boolean {
	const normalized = planFilePath.trim();
	return (
		normalized.startsWith("/docs/plans/") ||
		normalized.startsWith("/.omp/sessions/plans/")
	);
}

function resolveRepoRelativePlanPath(
	planFilePath: string,
	cwd: string,
): string {
	return normalizePath(path.resolve(cwd, `.${planFilePath}`));
}

function planPathValidationErrorText(): string {
	return "plan file must be under docs/plans or .omp/sessions/plans and end with .md";
}

function linkedPlanPathValidationErrorText(): string {
	return "plan file must end with .md";
}

function isMarkdownPlanPath(filePath: string): boolean {
	return normalizePath(filePath).toLowerCase().endsWith(".md");
}

function plannedWorktreePlanPathPromptText(): string {
	return "Attach a valid @docs/plans/... .md or @.omp/sessions/plans/... .md plan file to continue planned worktree setup.";
}

function plannedWorktreePlanPathInfoText(): string {
	return "Attach your plan file as @docs/plans/... .md or @.omp/sessions/plans/... .md and submit to continue planned worktree setup.";
}

function isDocsPlanMarkdownPath(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	if (!normalized.toLowerCase().endsWith(".md")) return false;
	const docsMarker = `${path.sep}docs${path.sep}plans${path.sep}`;
	const sessionPlansMarker = `${path.sep}.omp${path.sep}sessions${path.sep}plans${path.sep}`;
	return (
		normalized.includes(docsMarker) || normalized.includes(sessionPlansMarker)
	);
}

function getPlanWorkspaceDir(planFilePath: string): string {
	return normalizePath(path.dirname(planFilePath));
}

function getSessionWorkspaceTemplate(repoRoot?: string): string {
	const normalizedRepoRoot =
		repoRoot && repoRoot.trim().length > 0
			? normalizePath(repoRoot)
			: "<repo_root>";
	return `${normalizedRepoRoot}/.omp/sessions/<type>/<YYYY-MM-DD-slug>/`;
}

function getAgentDirPath(): string {
	return (
		process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent")
	);
}

function getAgentConfigPath(): string {
	return path.join(getAgentDirPath(), "config.yml");
}

type SettingsModelRoleAccessors = {
	setModelRole?: (role: string, modelId: string) => void;
	getModelRoles?: () => Record<string, string>;
};

async function loadSettingsModelRoleAccessors(): Promise<
	SettingsModelRoleAccessors | undefined
> {
	try {
		const loaded = await import("@oh-my-pi/pi-coding-agent/config/settings");
		const maybeSettings = (loaded as { settings?: unknown }).settings as
			| SettingsModelRoleAccessors
			| undefined;
		return maybeSettings;
	} catch {
		return undefined;
	}
}

async function readConfiguredModelRoles(): Promise<Record<string, string>> {
	const configPath = getAgentConfigPath();
	// Flush any pending in-process settings writes so the disk reflects the
	// latest /model changes from THIS session before we read.  Previously this
	// function merged in-memory settings on top of disk, which caused stale model
	// roles from a long-running session to override changes written by other sessions.
	const maybeSettings = await loadSettingsModelRoleAccessors();
	if (maybeSettings) {
		const flushable = maybeSettings as { flush?: () => Promise<void> };
		if (typeof flushable.flush === "function") {
			try {
				await flushable.flush();
			} catch {
				/* best effort */
			}
		}
	}

	const file = Bun.file(configPath);
	return (await file.exists()) ? parseModelRoles(await file.text()) : {};
}

async function readConfiguredDefaultThinkingLevel(): Promise<
	OrchestratorThinkingLevel | undefined
> {
	const configPath = getAgentConfigPath();
	const file = Bun.file(configPath);
	if (!(await file.exists())) return undefined;
	return parseDefaultThinkingLevel(await file.text());
}

function parseModelRoles(
	configContent: string | undefined,
): Record<string, string> {
	const roles: Record<string, string> = {};
	const lines = (configContent ?? "").replace(/\r\n/g, "\n").split("\n");
	let inModelRoles = false;

	for (const line of lines) {
		if (!inModelRoles) {
			if (/^modelRoles:\s*$/.test(line)) {
				inModelRoles = true;
			}
			continue;
		}

		if (!line.trim()) continue;
		if (!/^\s/.test(line)) break;

		const match = line.match(/^\s{2,}([a-zA-Z0-9_-]+):\s*(.+?)\s*$/);
		if (!match) continue;

		const key = match[1]?.trim();
		const value = stripYamlQuotes(match[2] ?? "");
		if (key && value) {
			roles[key] = value;
		}
	}

	return roles;
}

function parseDefaultThinkingLevel(
	configContent: string,
): OrchestratorThinkingLevel | undefined {
	const match = configContent.match(/^\s*defaultThinkingLevel:\s*(.+?)\s*$/m);
	if (!match) return undefined;
	const value = stripYamlQuotes(match[1] ?? "").toLowerCase();
	return isThinkingLevel(value) ? value : undefined;
}

function stripYamlQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).trim();
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function extractThinkingLevelFromRef(modelRef: string): {
	baseRef: string;
	thinkingLevel: OrchestratorThinkingLevel | undefined;
} {
	const trimmed = modelRef.trim();
	const slashIdx = trimmed.indexOf("/");
	const colonIdx = trimmed.lastIndexOf(":");
	// Only treat the last colon as a thinking-level separator when it appears after the provider slash
	if (colonIdx > slashIdx && slashIdx !== -1) {
		const suffix = trimmed.slice(colonIdx + 1);
		if (isThinkingLevel(suffix)) {
			return { baseRef: trimmed.slice(0, colonIdx), thinkingLevel: suffix };
		}
	}
	return { baseRef: trimmed, thinkingLevel: undefined };
}

function resolveModelReference<T extends { provider: string; id: string }>(
	models: T[],
	modelRef: string,
): T | undefined {
	const { baseRef } = extractThinkingLevelFromRef(modelRef);
	const parsed = parseModelReference(baseRef);
	if (parsed) {
		return models.find(
			(model) => model.provider === parsed.provider && model.id === parsed.id,
		);
	}

	const lowered = baseRef.trim().toLowerCase();
	if (!lowered) return undefined;
	return models.find((model) => model.id.toLowerCase() === lowered);
}

function parseModelReference(
	modelRef: string,
): { provider: string; id: string } | undefined {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slash),
		id: trimmed.slice(slash + 1),
	};
}

type OrchestratorThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

function getModelRoleThinkingPath(): string {
	return path.join(getAgentDirPath(), "model-role-thinking.json");
}

function readModelRoleThinkingLevels(): Record<
	string,
	OrchestratorThinkingLevel
> {
	try {
		const content = fs.readFileSync(getModelRoleThinkingPath(), "utf8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const result: Record<string, OrchestratorThinkingLevel> = {};
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof v === "string" && isThinkingLevel(v)) {
				result[k] = v;
			}
		}
		return result;
	} catch {
		return {};
	}
}

function getOrchestratorThinkingLevel(): OrchestratorThinkingLevel | undefined {
	const raw = process.env.OMP_ORCHESTRATOR_THINKING_LEVEL?.trim().toLowerCase();
	if (!raw || raw === "disabled") return undefined;
	return isThinkingLevel(raw) ? raw : undefined;
}

function isThinkingLevel(value: string): value is OrchestratorThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function isOrchestratorAutoCompactEnabled(): boolean {
	const raw = process.env.OMP_ORCHESTRATOR_AUTO_COMPACT?.trim().toLowerCase();
	if (!raw) return true;
	if (FALSE_ENV_VALUES.includes(raw)) return false;
	return true;
}

function getAutoCompactThresholdPercent(): number {
	const raw = process.env.OMP_ORCHESTRATOR_AUTO_COMPACT_PERCENT?.trim();
	if (!raw) return 45;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return 45;
	return Math.max(20, Math.min(95, parsed));
}

function resolvePlanFilePath(planFilePath: string, sessionCwd: string): string {
	if (isRepoRelativePlanPath(planFilePath)) {
		return resolveRepoRelativePlanPath(planFilePath, sessionCwd);
	}

	if (!planFilePath.startsWith("plan://")) {
		return normalizePath(
			path.isAbsolute(planFilePath)
				? planFilePath
				: path.resolve(sessionCwd, planFilePath),
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(planFilePath);
	} catch {
		throw new Error(`Invalid plan URL: ${planFilePath}`);
	}

	const hostMatch = planFilePath.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
	let host = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		host = decodeURIComponent(host);
	} catch {
		// leave host unchanged
	}

	const trimmedHost = host.replace(/^\/+/, "").replace(/\/+$/, "");
	const trimmedPath = parsed.pathname.replace(/^\/+/, "");
	if (!trimmedHost) {
		throw new Error("plan:// URL requires a session or plan identifier");
	}

	const relativePath = trimmedPath
		? path.join(trimmedHost, trimmedPath)
		: trimmedHost.endsWith(".md")
			? trimmedHost
			: path.join(trimmedHost, "plan.md");

	const plansDir = path.resolve(path.join(getAgentDirPath(), "plans"));
	const resolved = path.resolve(plansDir, relativePath);
	if (resolved !== plansDir && !resolved.startsWith(`${plansDir}${path.sep}`)) {
		throw new Error("plan:// URL escapes the plans directory");
	}
	return resolved;
}

function extractPlanPhases(planContent: string): PlanPhase[] {
	const lines = planContent.replace(/\r\n/g, "\n").split("\n");
	const headingRe = /^(#{1,6})\s*(.+?)\s*$/;
	const phaseHeadingRe = /^(#{1,6})\s*(Phase\s+(\d+)\b.*)$/i;
	const planSectionRe = /^(#{1,6})\s*Phased\s+Implementation\s+Plan\b.*$/i;

	type PhaseHeading = {
		line: number;
		level: number;
		phaseNumber: number;
		title: string;
	};
	const allPhaseHeadings: PhaseHeading[] = [];
	let planSectionStart: { line: number; level: number } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		if (!planSectionStart) {
			const planMatch = line.match(planSectionRe);
			if (planMatch) {
				planSectionStart = { line: i, level: (planMatch[1] ?? "").length };
			}
		}

		const phaseMatch = line.match(phaseHeadingRe);
		if (!phaseMatch) continue;
		allPhaseHeadings.push({
			line: i,
			level: (phaseMatch[1] ?? "").length,
			phaseNumber: Number.parseInt(phaseMatch[3] ?? "0", 10),
			title: (phaseMatch[2] ?? "").trim(),
		});
	}

	const dedupeByPhaseNumber = (headings: PhaseHeading[]): PhaseHeading[] => {
		const seen = new Set<number>();
		const unique: PhaseHeading[] = [];
		for (const heading of headings) {
			if (!Number.isFinite(heading.phaseNumber) || heading.phaseNumber <= 0)
				continue;
			if (seen.has(heading.phaseNumber)) continue;
			seen.add(heading.phaseNumber);
			unique.push(heading);
		}
		return unique;
	};

	let selectedHeadings = allPhaseHeadings;
	if (planSectionStart) {
		let planSectionEnd = lines.length;
		for (let i = planSectionStart.line + 1; i < lines.length; i++) {
			const headingMatch = lines[i]?.match(headingRe);
			if (!headingMatch) continue;
			const level = (headingMatch[1] ?? "").length;
			if (level <= planSectionStart.level) {
				planSectionEnd = i;
				break;
			}
		}

		const directChildren = allPhaseHeadings.filter(
			(heading) =>
				heading.line > planSectionStart.line &&
				heading.line < planSectionEnd &&
				heading.level === planSectionStart.level + 1,
		);
		selectedHeadings =
			directChildren.length > 0
				? directChildren
				: allPhaseHeadings.filter(
						(heading) =>
							heading.line > planSectionStart.line &&
							heading.line < planSectionEnd,
					);
	}

	const uniqueHeadings = dedupeByPhaseNumber(selectedHeadings).sort(
		(a, b) => a.line - b.line,
	);

	return uniqueHeadings.map((heading, index) => {
		const nextLine =
			index < uniqueHeadings.length - 1
				? uniqueHeadings[index + 1].line
				: lines.length;
		return {
			phaseNumber: heading.phaseNumber,
			title: heading.title,
			markdown: lines.slice(heading.line, nextLine).join("\n").trim(),
		};
	});
}

function extractPlanTitleAndPhaseHeadings(planContent: string): {
	planTitle: string;
	phaseHeadings: string[];
} {
	const normalized = planContent.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const firstHeadingLine = lines.find((line) => /^#{1,6}\s+/.test(line));
	const planTitle = firstHeadingLine
		? firstHeadingLine.replace(/^#{1,6}\s+/, "").trim()
		: (lines.find((line) => line.trim().length > 0)?.trim() ??
			"Implementation plan");
	const phaseHeadings = extractPlanPhases(planContent)
		.map((phase) => phase.title)
		.filter(Boolean);
	return { planTitle, phaseHeadings };
}

function extractLegacyPhaseHeadings(planContent: string): LegacyPhaseHeading[] {
	const lines = planContent.replace(/\r\n/g, "\n").split("\n");
	const phaseHeadingRe = /^(#{1,6})\s*(Phase\s+([0-9]+[A-Za-z]?)\b.*)$/i;
	const headings: LegacyPhaseHeading[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const phaseMatch = line.match(phaseHeadingRe);
		if (!phaseMatch) continue;
		headings.push({
			lineNumber: i + 1,
			heading: (phaseMatch[2] ?? "").trim(),
		});
	}

	return headings;
}

function buildNormalizedReviewPhases(
	sourcePhaseHeadings: LegacyPhaseHeading[],
): PlanPhase[] {
	return sourcePhaseHeadings.map((heading, index) => ({
		phaseNumber: index + 1,
		title: heading.heading,
		markdown: heading.heading,
	}));
}

async function allocateNormalizedReviewPlanPath(
	sourcePlanPath: string,
): Promise<string> {
	const normalizedSourcePath = normalizePath(sourcePlanPath);
	const planDir = path.dirname(normalizedSourcePath);
	const ext = path.extname(normalizedSourcePath) || ".md";
	const baseName = path.basename(normalizedSourcePath, ext);

	for (let attempt = 0; attempt < 200; attempt++) {
		const suffix =
			attempt === 0 ? ".review-phased" : `.review-phased-${attempt + 1}`;
		const candidatePath = normalizePath(
			path.join(planDir, `${baseName}${suffix}${ext}`),
		);
		if (!(await Bun.file(candidatePath).exists())) return candidatePath;
	}

	throw new Error(
		"Unable to allocate a normalized review plan path without overwriting an existing file",
	);
}
function getEmojiCommitPolicyLines(): string[] {
	return [
		"## Commit Title Policy (Required)",
		"- Format: <emoji> <type>(optional-scope): <description>",
		"- Exactly ONE leading emoji that matches the change type.",
		"- Use imperative present tense, no trailing period, keep title concise (<= 50 chars when practical).",
		"- Mapping: 💥 feat! (breaking), ⏪ revert, ✨ feat, 🐛 fix, ⚡ perf, ♻️ refactor, 📝 docs, 🧪 test, 🎨 style, 🔧 chore, 🏗️ build, 🤖 ci, ⬆️ chore(deps), 🔒 fix(security).",
		"- If repo policy/hooks reject emoji titles, retry the same Conventional Commit title without emoji.",
	];
}

function buildImplementationKickoffPrompt(input: {
	planFilePath: string;
	metadataEntryId: string;
	metadataTimestamp: string;
	resolvedPlanPath: string;
	planWorkspaceDir: string;
	phases: PlanPhase[];
	worktreePath?: string;
	branchName?: string;
	baseBranch?: string;
	repoRoot?: string;
	additionalInstructions?: string;
}): string {
	const {
		planFilePath,
		metadataEntryId,
		metadataTimestamp,
		resolvedPlanPath,
		planWorkspaceDir,
		phases,
		worktreePath,
		branchName,
		baseBranch,
		repoRoot,
		additionalInstructions,
	} = input;
	const phaseList = phases
		.map((phase) => `- Phase ${phase.phaseNumber}: ${phase.title}`)
		.join("\n");
	const remotePushBranch = (
		branchName && branchName !== "(unknown)" ? branchName : "<current-branch>"
	).trim();

	const extra = additionalInstructions
		? `\n## Additional Instructions from /implement\n${additionalInstructions.trim()}\n`
		: "";
	const sessionWorkspaceTemplate = getSessionWorkspaceTemplate(repoRoot);

	return [
		"Implement the approved plan in this worktree using strict orchestrator mode.",
		"",
		"## Source of Truth",
		`- Plan metadata path: \`${planFilePath}\``,
		`- Metadata entry id: \`${metadataEntryId}\` (${metadataTimestamp})`,
		`- Resolved plan file: \`${resolvedPlanPath}\``,
		`- Plan workspace directory: \`${planWorkspaceDir}\``,
		`- Worktree path: \`${worktreePath ?? "(unknown)"}\``,
		`- Worktree branch: \`${branchName ?? "(unknown)"}\` (base \`${baseBranch ?? "(unknown)"}\`)`,
		`- Session workspace template: \`${sessionWorkspaceTemplate}\``,
		"",
		`Detected phases (${phases.length}):`,
		phaseList,
		extra,
		"## Session Workspace (MANDATORY)",
		"- All session artifacts (test plans, verification reports, notes) MUST be written to the session workspace directory above.",
		"- Determine <type> once per session from the overall session goal (feature, fix, refactor, chore, docs).",
		"- Determine <YYYY-MM-DD-slug> once at session start and reuse it for the full session.",
		"- The FIRST spawned subagent in the session MUST create <session_workspace>/, <session_workspace>/test-plans/, and <session_workspace>/verification/ if missing.",
		"- Every subagent assignment MUST include the resolved session workspace path in assignment context.",
		"",
		"## Mandatory Execution Contract",
		"1. Implement phases strictly in order.",
		"2. For EACH phase, first spawn a prerequisite Task-tool subagent dedicated to writing failing tests for that phase's success criteria (RED). Include the resolved session workspace path in that task assignment context.",
		"3. The prerequisite RED task SHOULD apply the `test-driven-development` and `qa-test-planner` skills, MUST confirm failures are for missing behavior (not test/harness errors), and should write its test plan to: <session_workspace>/test-plans/<phase-or-task-name>.md.",
		"4. Only AFTER the RED task completes may you spawn exactly one Task-tool subagent dedicated to implementing that phase (GREEN).",
		"5. The phase implementation task MUST make those RED tests pass before phase completion.",
		"6. You may skip the prerequisite RED task only for pure refactoring where existing tests already cover the phase success criteria; if skipped, the assignment must cite those existing tests as evidence.",
		"7. Research/discovery-only and documentation-only tasks do not require prerequisite RED tasks.",
		"8. Do not parallelize phases.",
		"9. Parent agent must not edit files directly; only Task subagents implement code changes.",
		"10. If a phase task fails, spawn exactly one remediation Task subagent for that phase. Do not patch manually in parent.",
		"11. For EACH phase, apply the commit-hygiene skill (or equivalent atomic-commit discipline if unavailable).",
		"12. Finish each completed phase with atomic commit(s) scoped only to that phase (no cross-phase commits).",
		`13. Immediately push each phase commit to remote: git push --set-upstream origin ${remotePushBranch}. Never leave local-only commits.`,
		"14. Before marking a phase complete, run `git status --porcelain`; if dirty, spawn one remediation Task subagent dedicated to commit/push cleanup for that phase, then re-check until clean.",
		"15. Require each phase Task subagent that modifies files to run a nested `lint` subagent scoped to its changed paths before reporting completion. Lint failures must be fixed and re-linted inside that phase task.",
		'16. Verifier Workflow (MANDATORY): after each phase\'s task(s) complete, spawn: task(agent="verifier", assignment="Verify phase N: [success criteria]. Check: (1) lint passed on modified files, (2) tests exist and pass, (3) success criteria met. Modified files: [list from task result]. Write verification report to: <session_workspace>/verification/<phase-or-task-name>.md"). The `qa-test-planner` skill is auto-injected.',
		"17. Verifier output contract:",
		'   - go: { verdict: "go", summary: "1-2 sentence confirmation" }',
		'   - no_go: { verdict: "no_go", issues: ["itemized failures"], summary: "what failed and why" }',
		'18. If verifier verdict is "no_go", spawn a targeted fix task, then re-verify. Max 2 remediation loops per phase. If still no_go -> STOP and report to user.',
		"19. Do not override model selection; Task subagents must use the session's currently active model (fallback: Subagent role only when no active model is available).",
		"20. Keep parent messages brief (status + next action only). Avoid pasting large tool transcripts.",
		"21. Read the plan file lazily by phase section; do not inline full plan text in parent conversation.",
		"22. Keep plan-scoped artifacts (notes, JSON metadata, checklists, scratch files) under the plan workspace directory above.",
		"23. After each phase, report what changed and whether success criteria passed.",
		"24. If any phase remains blocked after remediation, STOP and provide a failure summary with next actions.",
		"",
		...getEmojiCommitPolicyLines(),
	].join("\n");
}

function buildReviewCompleteKickoffPrompt(input: {
	planFilePath: string;
	metadataEntryId: string;
	metadataTimestamp: string;
	resolvedPlanPath: string;
	planWorkspaceDir: string;
	phases: PlanPhase[];
	worktreePath?: string;
	branchName?: string;
	baseBranch?: string;
}): string {
	const {
		planFilePath,
		metadataEntryId,
		metadataTimestamp,
		resolvedPlanPath,
		planWorkspaceDir,
		phases,
		worktreePath,
		branchName,
		baseBranch,
	} = input;

	const phaseList = phases
		.map((phase) => `- Phase ${phase.phaseNumber}: ${phase.title}`)
		.join("\n");
	const coderrabbitBaseBranch = (
		baseBranch && baseBranch !== "(unknown)" ? baseBranch : "main"
	).trim();

	const coderrabbitWorktreePath = (
		worktreePath && worktreePath !== "(unknown)" ? worktreePath : "."
	).trim();
	return [
		"Run a completion review for this implemented plan in read-only verification mode.",
		"",
		"## Required skill",
		"- Apply verification-before-completion before any completion claim.",
		"- Every finding must be backed by direct evidence (file paths, line snippets, command output).",
		"",
		"## Source of Truth",
		`- Plan metadata path: \`${planFilePath}\``,
		`- Metadata entry id: \`${metadataEntryId}\` (${metadataTimestamp})`,
		`- Resolved plan file: \`${resolvedPlanPath}\``,
		`- Plan workspace directory: \`${planWorkspaceDir}\``,
		`- Worktree path: \`${worktreePath ?? "(unknown)"}\``,
		`- Worktree branch: \`${branchName ?? "(unknown)"}\` (base \`${baseBranch ?? "(unknown)"}\`)`,
		"",
		`Detected phases (${phases.length}):`,
		phaseList,
		"",
		"## Mandatory Review Workflow",
		"1. Parse the plan into a verifiable checklist of requirements and acceptance criteria per phase.",
		"2. Spawn exactly one Task subagent per phase in a SINGLE Task tool call, so all phase reviews run in parallel.",
		'   - Use `agent: "implement"` (NEVER `agent: "explore"` for this review workflow).',
		'   - Include `skills: ["verification-before-completion", "security-review"]` in each task declaration.',
		"   - If `security-review` is unavailable, require equivalent security-checklist verification in the assignment.",
		"3. Each phase subagent must verify only that phase's requirements against implementation evidence.",
		"4. Review session is read-only: do not use edit/write/notebook and do not create commits.",
		"5. Keep review artifacts (checklists/notes/json reports) under the plan workspace directory above.",
		"6. For each requirement item, classify as PASS / PARTIAL / FAIL with evidence and short rationale.",
		"7. Compute completion score using checklist data:",
		"   - PASS = 1.0, PARTIAL = 0.5, FAIL = 0.0",
		"   - completionPercent = (sum(itemScores) / totalItems) * 100",
		"8. Convert completionPercent to a rating:",
		"   - A: >= 95, B: >= 85, C: >= 70, D: >= 50, F: < 50",
		"9. As the LAST review task before final report, spawn exactly one Task subagent dedicated to CodeRabbit CLI execution over the full plan diff.",
		"   - Run in the worktree root (no edits/commits).",
		`   - Run: /home/colin/.local/bin/coderabbit review --prompt-only --base ${coderrabbitBaseBranch} --cwd ${coderrabbitWorktreePath}`,
		"   - Execute via bash with explicit `cwd` set to the worktree path above (required by guard) and `timeout: 600` (CodeRabbit can be slow on large diffs).",
		"   - If base branch is uncertain, detect it first and document the resolved base branch used.",
		'   - If rate-limited ("Rate limit exceeded"), parse the wait duration from the error message, sleep that many seconds plus 10, then retry once.',
		"   - If CodeRabbit CLI is missing, binary not found, or auth is rejected (not rate limit), STOP and report the blocker with command output.",
		"10. Parse CodeRabbit output and normalize severities to: Critical / Severe / Major / Minor / Nitpick.",
		"11. Ignore nitpicks for gating, but include every Critical/Severe/Major CodeRabbit finding in the final discrepancy list and an explicit remediation backlog section.",
		"12. Return one final synthesized report for the user.",
		"",
		"## Final Response Requirements",
		"- Overall completion percentage and rating.",
		"- Per-phase completion summary with PASS/PARTIAL/FAIL counts.",
		"- Ordered discrepancy list (highest impact first) with concrete evidence.",
		"- CodeRabbit execution evidence: command(s), base branch used, and severity counts.",
		"- CodeRabbit remediation backlog section listing ONLY Critical/Severe/Major findings (with files, evidence, and recommended fix direction).",
		"- Clear next actions required for 100% completion.",
	].join("\n");
}

function buildReviewCompleteNormalizationKickoffPrompt(input: {
	planFilePath: string;
	metadataEntryId: string;
	metadataTimestamp: string;
	originalResolvedPlanPath: string;
	resolvedPlanPath: string;
	planWorkspaceDir: string;
	phases: PlanPhase[];
	sourcePhaseHeadings: LegacyPhaseHeading[];
	worktreePath?: string;
	branchName?: string;
	baseBranch?: string;
}): string {
	const {
		planFilePath,
		metadataEntryId,
		metadataTimestamp,
		originalResolvedPlanPath,
		resolvedPlanPath,
		planWorkspaceDir,
		phases,
		sourcePhaseHeadings,
		worktreePath,
		branchName,
		baseBranch,
	} = input;

	const sourcePhaseList = sourcePhaseHeadings
		.map(
			(heading, index) =>
				`- ${index + 1}. ${heading.heading} (line ${heading.lineNumber})`,
		)
		.join("\n");
	const expectedNormalizedPhaseList = phases
		.map((phase) => `- Phase ${phase.phaseNumber}: ${phase.title}`)
		.join("\n");
	const standardReviewPrompt = buildReviewCompleteKickoffPrompt({
		planFilePath,
		metadataEntryId,
		metadataTimestamp,
		resolvedPlanPath,
		planWorkspaceDir,
		phases,
		worktreePath,
		branchName,
		baseBranch,
	});

	return [
		"The selected plan is not in strict numeric `Phase N` format. Normalize it first, then run the same completion review workflow.",
		"",
		"## Required Normalization Step (must run first)",
		`- Original plan file (read-only): \`${originalResolvedPlanPath}\``,
		`- New normalized plan file to create: \`${resolvedPlanPath}\``,
		"- Do not overwrite or edit the original plan file.",
		'- In the parent orchestrator, spawn exactly one Task call with `agent: "curator"` and one task to normalize the plan.',
		"- Curator normalization requirements:",
		"  1. Copy the entire original markdown into the new file (verbatim baseline).",
		"  2. Rename ONLY phase headings to strict sequential numeric headings: `Phase 1`, `Phase 2`, ...",
		"  3. Preserve all non-phase text exactly (requirements, rationale, acceptance criteria, references, appendices).",
		"  4. Preserve phase order exactly as source.",
		"  5. Produce a heading mapping table old heading -> new heading and explicitly confirm no source phase was dropped.",
		"",
		"### Source phase headings that must be preserved",
		sourcePhaseList,
		"",
		"### Expected normalized phase sequence",
		expectedNormalizedPhaseList,
		"",
		"### Validation gate before review tasks",
		"- Read the normalized file and verify strict `Phase N` headings exist for every expected phase.",
		"- Verify normalized phase count equals source phase count exactly.",
		"- If any mismatch exists, STOP and report BLOCKED (do not continue review tasks).",
		"",
		standardReviewPrompt,
	].join("\n");
}
function buildFixIssuesKickoffPrompt(input: {
	planFilePath: string;
	metadataEntryId: string;
	metadataTimestamp: string;
	resolvedPlanPath: string;
	planWorkspaceDir: string;
	phases: PlanPhase[];
	worktreePath?: string;
	branchName?: string;
	baseBranch?: string;
	reviewFindingsEntryId: string;
	reviewFindingsTimestamp: string;
	reviewFindings: string;
}): string {
	const {
		planFilePath,
		metadataEntryId,
		metadataTimestamp,
		resolvedPlanPath,
		planWorkspaceDir,
		phases,
		worktreePath,
		branchName,
		baseBranch,
		reviewFindingsEntryId,
		reviewFindingsTimestamp,
		reviewFindings,
	} = input;

	const phaseList = phases
		.map((phase) => `- Phase ${phase.phaseNumber}: ${phase.title}`)
		.join("\n");
	const findingsBlock = truncateForPrompt(reviewFindings, 50_000);
	const coderrabbitBaseBranch = (
		baseBranch && baseBranch !== "(unknown)" ? baseBranch : "main"
	).trim();
	const coderrabbitWorktreePath = (
		worktreePath && worktreePath !== "(unknown)" ? worktreePath : "."
	).trim();

	return [
		"Fix all issues identified by the completion review and finish with a final independent verification pass.",
		"",
		"## Source of Truth",
		`- Plan metadata path: \`${planFilePath}\``,
		`- Metadata entry id: \`${metadataEntryId}\` (${metadataTimestamp})`,
		`- Resolved plan file: \`${resolvedPlanPath}\``,
		`- Plan workspace directory: \`${planWorkspaceDir}\``,
		`- Worktree path: \`${worktreePath ?? "(unknown)"}\``,
		`- Worktree branch: \`${branchName ?? "(unknown)"}\` (base \`${baseBranch ?? "(unknown)"}\`)`,
		`- Review findings source entry: \`${reviewFindingsEntryId}\` (${reviewFindingsTimestamp})`,
		"",
		`Detected phases (${phases.length}):`,
		phaseList,
		"",
		"## Review Findings To Remediate",
		"Use this report as the required remediation backlog:",
		"```markdown",
		findingsBlock,
		"```",
		"",
		"## Mandatory Remediation Workflow",
		"1. Parse the review findings into a concrete ordered issue backlog (highest impact first), including all CodeRabbit Critical/Severe/Major findings.",
		"2. Immediately call `todo_write` in the parent orchestrator session:",
		"   - Create EXACTLY one todo item per discovered issue.",
		"   - Add one final todo item: 'Final verification and closeout'.",
		"3. Execute remediation SEQUENTIALLY (do not parallelize issue fixes):",
		"   - For each issue, spawn exactly one Task subagent dedicated to that issue.",
		"   - Each issue-fix assignment MUST require commit-hygiene (or equivalent), atomic commit(s) scoped only to that issue, and immediate push to origin.",
		"   - After each issue task completes, run `git status --porcelain` in the worktree. If dirty, do NOT mark todo complete; spawn one remediation Task subagent for commit/push cleanup for that same issue, then re-check.",
		"   - Mark the issue todo complete only after git status is clean.",
		"   - If a fix task fails, run a remediation Task subagent for that same issue before continuing.",
		"4. Parent orchestrator must not edit files directly; all code changes happen in Task subagents.",
		"5. Record commit hash(es) per issue and confirm each was pushed to origin before advancing.",
		"6. Maintain a deduplicated list of every file edited across all issue-fix tasks.",
		"",
		...getEmojiCommitPolicyLines(),
		"",
		"## Final Verification Task (REQUIRED LAST TASK)",
		"7. After all issue todos are complete, spawn one final Task subagent for verification.",
		"8. That verification Task subagent must run per-file checks via child subagents for all edited files:",
		"   - Default path: spawn `explore` subagents with one edited file per task.",
		"   - Respect explore fan-out cap: max 5 explore tasks per Task call; batch additional files across multiple Task calls.",
		"   - For explore children, require the native explore output schema (`query`, `files`, `code`, `architecture`, `start_here`). For per-file PASS/FAIL assignments, include optional top-level `verdict` and `reason`.",
		"   - Transform child outputs into verification summaries in the parent verification Task subagent after results return, preserving each file verdict and rationale.",
		"   - If any explore child is cancelled/aborted or shows submit_result validation/missing-submit_result warnings, immediately re-run that same file as a read-only `implement` child and require the same output shape (including `verdict`/`reason` when requested).",
		"9. As the LAST verification step, that verification Task subagent must run CodeRabbit CLI against the full branch diff:",
		`\t   - Run: /home/colin/.local/bin/coderabbit review --prompt-only --base ${coderrabbitBaseBranch} --cwd ${coderrabbitWorktreePath}`,
		"   - Execute via bash with explicit `cwd` set to the worktree path above (required by guard) and `timeout: 600` (CodeRabbit can be slow on large diffs).",
		"   - Ignore Nitpick/Minor findings.",
		"   - Treat any remaining Critical/Severe/Major finding as a blocking failure.",
		"10. If final CodeRabbit review reports blocking findings, return those findings to the parent orchestrator; parent must create/update todos and run dedicated fix Task subagents sequentially, then repeat final verification.",
		"11. If final CodeRabbit verification is clean for Critical/Severe/Major, mark the final todo item completed.",
		"",
		"## Completion Gate",
		"- Do not declare completion until every issue todo is completed and final CodeRabbit verification reports zero unresolved Critical/Severe/Major findings.",
		"- Do not declare completion while `git status --porcelain` reports staged/unstaged/untracked files in the active worktree.",
		"- If CodeRabbit returns a rate-limit error, parse the wait seconds from the message, sleep that duration plus 10, and retry once before reporting blocked.",
		"- If CodeRabbit CLI binary is missing or returns an auth-rejected error (not rate limit), STOP and report blocked (do not claim completion).",
		"- Final response must explicitly state 100% completion and include:",
		"  - list of fixed issues,",
		"  - files changed per issue,",
		"  - verification evidence that no listed issue remains,",
		"  - final CodeRabbit evidence showing zero Critical/Severe/Major findings.",
	].join("\n");
}

interface PersistedWorktreeState {
	baseBranch: string;
	branchName: string;
	worktreePath: string;
	repoRoot?: string;
	planFilePath?: string;
	planWorkspaceDir?: string;
	actionButtonStage: ActionButtonStage;
	updatedAt: number;
}

interface PersistedPlannedWorktreeSelection {
	planFilePath: string;
	categoryLabel: string;
	categoryPrefix: string;
	branchNamePart: string;
	baseBranch: string;
	updatedAt: number;
}

function isPersistedWorktreeState(
	data: unknown,
): data is PersistedWorktreeState {
	if (!data || typeof data !== "object") return false;
	const value = data as Record<string, unknown>;
	const stage = value.actionButtonStage;
	const validStage =
		stage === "implement" ||
		stage === "plan" ||
		stage === "submit-pr" ||
		stage === "fix-issues" ||
		stage === "update-version" ||
		stage === "cleanup" ||
		stage === "none";
	const validPlanFilePath =
		value.planFilePath === undefined || typeof value.planFilePath === "string";
	const validPlanWorkspaceDir =
		value.planWorkspaceDir === undefined ||
		typeof value.planWorkspaceDir === "string";
	return (
		typeof value.baseBranch === "string" &&
		typeof value.branchName === "string" &&
		typeof value.worktreePath === "string" &&
		validStage &&
		validPlanFilePath &&
		validPlanWorkspaceDir
	);
}

function normalizeActionButtonStage(stage: unknown): ActionButtonStage {
	if (
		stage === "plan" ||
		stage === "submit-pr" ||
		stage === "fix-issues" ||
		stage === "update-version" ||
		stage === "cleanup" ||
		stage === "none"
	)
		return stage;
	return "implement";
}

function normalizePath(inputPath: string): string {
	return path.normalize(path.resolve(inputPath));
}

async function readWorkspaceVersion(
	worktreePath: string,
): Promise<string | undefined> {
	try {
		const cargoTomlPath = path.join(worktreePath, "Cargo.toml");
		const content = await Bun.file(cargoTomlPath).text();
		const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
		const version = match?.[1]?.trim();
		return version || undefined;
	} catch {
		return undefined;
	}
}

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}


export async function cleanupFailedWorktree(
	repoRoot: string,
	worktreePath: string,
	branchName?: string,
): Promise<void> {
	if (!repoRoot || !worktreePath) return;

	try {
		fs.rmSync(worktreePath, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	await runAllowFail(["git", "worktree", "prune"], repoRoot);
	if (branchName) {
		await runAllowFail(["git", "branch", "-D", branchName], repoRoot);
	}
	await cleanupEmptyWorktreeParents(repoRoot, worktreePath);
}


// =============================================================================
// Helpers that run DURING handler (pi.exec is fine here)
// =============================================================================

async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	const root = res.stdout.trim();
	if (!root || res.code !== 0) {
		throw new Error(
			`Not in a git repository (cwd=${cwd}, code=${res.code}, stderr=${res.stderr.trim()})`,
		);
	}
	return root;
}

async function getBaseBranchOptions(
	pi: ExtensionAPI,
	repoRoot: string,
): Promise<{ options: string[]; recommended: string }> {
	let recommended = "master";
	const options: string[] = [];

	const has = async (name: string) => {
		const res = await pi.exec(
			"git",
			["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
			{
				cwd: repoRoot,
			},
		);
		return res.code === 0;
	};

	if (await has("master")) {
		options.push("master");
		recommended = "master";
	}
	if (await has("main")) {
		if (!options.includes("main")) options.push("main");
		if (options.length === 0) recommended = "main";
	}

	const cur = await pi.exec("git", ["branch", "--show-current"], {
		cwd: repoRoot,
	});
	const current = cur.stdout.trim();
	if (current && !options.includes(current)) options.push(current);

	const recent = await pi.exec(
		"git",
		[
			"for-each-ref",
			"--sort=-committerdate",
			"--count=5",
			"--format=%(refname:short)",
			"refs/heads/",
		],
		{ cwd: repoRoot },
	);
	for (const line of recent.stdout
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)) {
		if (!options.includes(line)) options.push(line);
	}

	options.push(OTHER_CHOICE);
	return { options, recommended };
}


async function promptForWorktreeCategory(
	ctx: ExtensionContext,
): Promise<WorktreeCategory | undefined> {
	const choice = await ctx.ui.select(
		"What category should this worktree use?",
		WORKTREE_CATEGORY_OPTIONS.map((option) => option.label),
	);
	if (!choice) return undefined;
	return WORKTREE_CATEGORY_OPTIONS.find((option) => option.label === choice);
}

function buildBranchNameCandidates(input: {
	planFilePath: string;
	topicSlug: string;
}): string[] {
	const { planFilePath, topicSlug } = input;
	const planDirSlug = extractPlanDirSlugFromPath(planFilePath);
	const planSlug = extractPlanSlugFromPath(planFilePath);
	const candidates = [
		planDirSlug,
		planSlug,
		topicSlug,
		planSlug ? compactSlug(planSlug) : undefined,
		"implementation",
	]
		.map((value) => sanitizeBranchSegment(value ?? ""))
		.filter(Boolean);

	const unique = [...new Set(candidates)];
	return unique.slice(0, 3);
}

function extractPlanDirSlugFromPath(planFilePath: string): string | undefined {
	const normalized = normalizePath(planFilePath);
	if (!isDocsPlanMarkdownPath(normalized)) return undefined;
	const planDir = path.dirname(normalized);
	const dirName = path.basename(planDir).trim();
	if (!dirName || dirName.toLowerCase() === "plans") return undefined;
	return topicToSlug(dirName);
}

function extractPlanSlugFromPath(planFilePath: string): string {
	const baseName = path.basename(planFilePath).replace(/\.md$/i, "");
	const match = baseName.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
	const slugSource = (match?.[1] ?? baseName).trim();
	return topicToSlug(slugSource || "implement");
}

function compactSlug(slug: string): string {
	return slug.split("-").slice(0, 4).join("-");
}

function sanitizeBranchSegment(input: string): string {
	const withoutPrefix = input
		.trim()
		.replace(/^[a-z][a-z0-9-]*\//i, "")
		.replace(/^\/+|\/+$/g, "")
		.replace(/[._]/g, "-");
	return topicToSlug(withoutPrefix || "implement");
}

function isStrictKebabCase(value: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function extractTopic(prompt: string): string {
	const text = prompt
		.replace(/^\/implement\s*/i, "")
		.replace(/^\/plan-new\s*/i, "")
		.trim();
	if (!text) return "implement";
	return text.split(/\s+/).slice(0, 4).join(" ");
}

function parseReviewCompleteManualPlanPath(args: string): string | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;

	const mentionMatch = trimmed.match(/@(?:"([^"]+)"|'([^']+)'|(\S+))/);
	const fallbackTokenMatch = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
	const raw = mentionMatch
		? (mentionMatch[1] ?? mentionMatch[2] ?? mentionMatch[3] ?? "")
		: (fallbackTokenMatch?.[1] ??
			fallbackTokenMatch?.[2] ??
			fallbackTokenMatch?.[3] ??
			"");

	const normalized = raw.trim();
	if (!normalized) return undefined;
	return normalized;
}

function findLatestAssistantReviewFindings(
	ctx: ExtensionContext,
): ReviewFindingsSnapshot | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			id?: string;
			timestamp?: string;
			message?: { role?: string; content?: unknown };
		};
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;

		const content = extractTextContent(message.content);
		if (!content) continue;

		const normalized = content.trim();
		if (!normalized) continue;
		const looksLikeReview =
			normalized.length >= 400 &&
			/(PASS|PARTIAL|FAIL|completion|rating|discrepanc|next actions|required)/i.test(
				normalized,
			);
		if (!looksLikeReview) continue;

		return {
			entryId: entry.id ?? "(unknown)",
			timestamp: entry.timestamp ?? "(unknown)",
			content: normalized,
		};
	}
	return undefined;
}

function reviewFindingsIncludeCodeRabbitGate(content: string): boolean {
	const normalized = content.toLowerCase();
	const hasCodeRabbitMention = /code\s*rabbit|coderabbit/.test(normalized);
	const hasSeverityGate =
		/critical/.test(normalized) &&
		/severe/.test(normalized) &&
		/major/.test(normalized);
	return hasCodeRabbitMention && hasSeverityGate;
}

function reviewFindingsHaveBlockingCodeRabbitIssues(content: string): boolean {
	const critical = readReviewSeverityCount(content, "critical");
	const severe = readReviewSeverityCount(content, "severe");
	const major = readReviewSeverityCount(content, "major");
	if (critical !== undefined || severe !== undefined || major !== undefined) {
		return (critical ?? 0) > 0 || (severe ?? 0) > 0 || (major ?? 0) > 0;
	}

	const normalized = content.toLowerCase();
	if (
		/no\s+(?:unresolved\s+)?critical\s*\/\s*severe\s*\/\s*major\s+(?:findings|issues)/.test(
			normalized,
		) ||
		/critical\s*\/\s*severe\s*\/\s*major[^0-9]{0,20}0\s*\/\s*0\s*\/\s*0/.test(
			normalized,
		) ||
		/zero\s+(?:unresolved\s+)?(?:critical|severe|major)\s+(?:findings|issues)/.test(
			normalized,
		)
	) {
		return false;
	}

	return true;
}

function readReviewSeverityCount(
	content: string,
	severity: "critical" | "severe" | "major",
): number | undefined {
	const escapedSeverity = severity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`\\b${escapedSeverity}\\b\\s*[:=]\\s*(\\d+)\\b`, "i"),
		new RegExp(`\\|\\s*${escapedSeverity}\\s*\\|\\s*(\\d+)\\s*\\|`, "i"),
		new RegExp(`\\b${escapedSeverity}\\b\\s*\\(\\s*(\\d+)\\s*\\)`, "i"),
		new RegExp(`\\b${escapedSeverity}\\b[^\\d\\n]{0,16}(\\d+)\\b`, "i"),
	];

	for (const pattern of patterns) {
		const match = content.match(pattern);
		if (!match) continue;
		const parsed = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isNaN(parsed)) return parsed;
	}

	return undefined;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const chunks: string[] = [];
	for (const part of content as Array<unknown>) {
		if (!part || typeof part !== "object") continue;
		const value = part as { type?: string; text?: unknown };
		if (value.type === "text" && typeof value.text === "string") {
			chunks.push(value.text);
		}
	}
	return chunks.join("\n").trim();
}

function truncateForPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[...truncated to ${maxChars} chars by plan-worktree extension...]`;
}

function topicToSlug(topic: string): string {
	return (
		topic
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32) || "implement"
	);
}

---
description: "Implementation worktree lifecycle. Read ONLY during active worktree implementation sessions."
alwaysApply: false
---

# Implementation Worktree Lifecycle

## Worktree Setup

`/implement` prompts for base branch + new branch name and then creates/switches to an isolated worktree.

- The **new branch is checked out inside the worktree directory**.
- The original repo usually stays on its current branch (git does not allow the same branch to be checked out in two worktrees).
- On `/resume`, the extension restores the persisted worktree path/branch for that session and re-pins `cwd` back to that worktree.

## Worktree Status

Use `/worktree` to view current worktree status for this session.

## Implementation Launcher

A clickable footer action area is shown with workflow controls:
- `[Worktree ▾]` — nested menu: Plan→Worktree, Skip plan (use existing plan), Freeform worktree
- `[Git ▾]` — nested menu (when worktree active): Submit PR, Review, Resolve Conflicts, Sync Branch
- `[! Sync Needed]` — appears when base branch has advanced; click to sync via Git menu
- `[✕ Worktree]` — always at far right edge; destructive delete with confirmation
- After worktree creation, automatic Auggie warmup still runs (best effort).
- Auto kickoff from plan metadata only happens when `/plan-new` metadata exists in-session.

### Orchestrator Mode

- Parent implementation sessions run in **Orchestrator mode**:
  - Parent agent is orchestration-only and delegates code edits to Task subagents.
  - Direct parent file mutations (`edit`, `write`, `notebook`) are blocked in active implementation worktrees.
- Keep orchestrator reinforcement lightweight: inject orchestrator/worktree prompt once per session (or session switch), not every turn, to avoid context-window churn.
- Enforce orchestrator behavior primarily through extension hooks/tool guards (`tool_call`, cwd/worktree isolation, mutating-tool blocks, read-budget caps), not repeated prompt restatement.

### Phase-End Verification Round

- Implementation worker completion reports are progress updates, not final workflow gates.
- After all implementation units in a phase finish, the orchestrator launches verification fan-out:
  - Spawn one `verifier` task per completed implementation unit and one `coderabbit` task in parallel.
  - Dispatch `coderabbit` at round start so CodeRabbit runs asynchronously while the unit verifiers execute.
  - If implementation had to stay sequential because independence checks failed, keep that sequential execution; verifier fan-out runs only after the sequential implementation batch completes.
- If any verifier returns `verdict: "no_go"` (including `coderabbit`), convert findings into targeted remediation implementation work before advancing.
- After remediation, rerun the full phase-end verifier round before evaluating advancement again.
- CodeRabbit is async-friendly: it should not serialize the verifier round, and it only blocks advancement if still running when the other verifiers complete.
- Never advance while any required verifier is running or after any required verifier reports `no_go`.


### Model Selection

- Parent implementation model is auto-selected from `/model` role `Orchestrator` (fallback: `Default` if unset) at worktree kickoff and before each turn.
- Task subagents spawned during implementation use the `/model` role assignment for `Implementation Agent` (`implement` role ID) and only fall back to current active model if `Implementation Agent` is not set.

### Commit Discipline and Convention

- Implementation kickoff enforces per-phase commit discipline: apply `commit-hygiene`, keep commits atomic per phase, push commits to `origin/<worktree-branch>`, and use emoji-prefixed Conventional Commit titles.
- Commit title convention in workflow phases: `<emoji> <type>(scope): <description>` with exactly one emoji; if hooks reject emoji, retry without emoji.

### Extension Sync and Auto-Compaction

- The extension publishes the worktree branch to origin during setup and attempts a remote sync after each Task completion.
- After Task phase completions, the extension auto-compacts context when usage exceeds threshold (default 45%).

### Runtime Source of Truth

- Workflow UI/runtime behavior now ships through the packaged source under `packages/`; do not mutate the live Bun global install from `agent/patches/...` during startup or refresh.

### Environment Variables

- Set `OMP_IMPLEMENT_AUGGIE_INDEX=0` to disable automatic Auggie warmup.
- Set `OMP_ORCHESTRATOR_THINKING_LEVEL=<off|minimal|low|medium|high|xhigh>` to override orchestrator thinking level (default: `medium`).
- Set `OMP_ORCHESTRATOR_AUTO_COMPACT=0` to disable orchestrator auto-compaction.
- Set `OMP_ORCHESTRATOR_AUTO_COMPACT_PERCENT=<20-95>` to change auto-compaction threshold percent.

## Isolation Guardrails

- During an implementation worktree session, file mutations (`edit`, `write`, `notebook`) are restricted to paths inside the active worktree.
- During orchestrator parent turns in implementation mode, MCP tools (`mcp_*`) are disabled.
- Bash tool calls are blocked if `cwd` points outside the active worktree.
- If session `cwd` drifts, the extension re-pins it back to the active worktree before each turn.

## Lifecycle Commands

- Use `/submit-pr` from inside a worktree to rebase, resolve conflicts, bump version, update changelog, push, and create/update a PR.
- Use `/review-complete` to launch a new review session that verifies each phase against the plan using evidence, then returns completion percentage and discrepancy report.
- You can pass a plan file manually (useful for older sessions missing metadata): `/review-complete @docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md`.
- Use `/fix-issues` from the spawned review session to launch a remediation session that fixes review findings sequentially and performs final verification.
- You can pass a plan file manually to remediation too: `/fix-issues @docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md`.
- Use `/update-version-workflow [patch|minor|major]` after remediation to open a dedicated session in the same worktree and run `/update-version` automatically.
- `/update-version` changelog generation is commit-history driven for the active worktree branch range (`origin/<base>..HEAD`), not staged-diff driven; it commits and pushes the version bump changes on completion.
- Use `/delete-worktree` to permanently discard the active implementation worktree (with confirmation), remove local branch, and attempt remote branch deletion.
- Use `/cleanup` to remove one or more completed worktrees and delete their local branches.

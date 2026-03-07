# Worktree UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILLS: use `brainstorming`, then `test-driven-development`, then `writing-plans`.

**Goal:** Replace the single `[Worktree ▾]` dropdown button with three direct-action footer buttons (`[Freeform]`, `[Planned]`, `[Cleanup]`) that each provide a streamlined, reliable worktree workflow with auto-cleanup on failure, curator-powered name suggestions, and simplified orchestrator kickoff prompts.

**Architecture:** The `implementation-engine` extension (`extensions/implementation-engine/index.ts`) is the single source of truth for worktree lifecycle, footer buttons, session switching, and orchestrator setup. Supporting files include `cleanup.ts` (cleanup logic), `git-utils.ts` (git abstractions), and `scripts/menu-popup.sh` (tmux/fzf popup menus). All changes are scoped to these files.

**Tech Stack:** TypeScript (Bun runtime), tmux/fzf for popup UI, git CLI for worktree operations, OMP extension API (`ctx.ui.*`, `ctx.newSession`, `pi.registerCommand`, `pi.sendUserMessage`).

---

## Design Decisions (from brainstorming)

1. **Footer layout:** Three separate buttons `[Freeform]` `[Planned]` `[Cleanup]` — no dropdown menu.
2. **Base branch:** Keep the explicit selection prompt (pick from list of branches).
3. **Categories:** Trim from 14 to 8 essentials: feat, fix, refactor, chore, docs, security, perf, breaking.
4. **Plan linking (Planned flow):** Reuse the chat input's existing `@` mention system — set editor text to `@`, user picks file, hits Enter, extension intercepts.
5. **Name suggestion (Planned flow):** Spawn `curator` agent to generate a branch name slug from plan content. Show as default in text input, user can override.
6. **Kickoff prompt (Planned flow):** Pre-fill input with a short 3-5 line prompt. User just hits Enter.
7. **Cleanup UI:** tmux/fzf multi-select popup showing branch, path, last commit, merge status.
8. **Error recovery:** Auto-cleanup partial state (remove directory, prune git worktree, remove dangling branch) + clear error notification. No retry button.

---

## Phased Implementation Plan (Agent-Sized)

### Phase 1: Trim Categories + Add Error Recovery Cleanup

**Goal**
Reduce the worktree category list to 8 essentials and add a robust cleanup function that automatically removes partial state when worktree creation fails.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: `WORKTREE_CATEGORY_OPTIONS` array (line ~3493), `setupWorktreeFromTopic` catch block (line ~1760)

**Non-goals**
- Do not change the footer button layout yet.
- Do not change any command registrations.
- Do not modify the freeform or planned worktree flows.

**TDD approach**
- RED: Write tests that verify (1) `WORKTREE_CATEGORY_OPTIONS` contains exactly 8 items with the correct prefixes: `breaking/`, `feature/`, `fix/`, `perf/`, `refactor/`, `docs/`, `chore/`, `security/`; (2) a `cleanupFailedWorktree` function exists and, given a worktree path and branch name, it calls `rm -rf` on the directory, runs `git worktree prune`, and attempts `git branch -D` on the branch.
- GREEN: Trim `WORKTREE_CATEGORY_OPTIONS` to 8 items. Create `cleanupFailedWorktree(repoRoot, worktreePath, branchName)` async function. Update the catch block in `setupWorktreeFromTopic` to call it before notifying the user.
- REFACTOR: Remove the 6 deleted category entries cleanly. Ensure the cleanup function is exported for testing.

**Success criteria**
- `WORKTREE_CATEGORY_OPTIONS` has exactly 8 entries.
- The `cleanupFailedWorktree` function exists and handles: directory removal, `git worktree prune`, optional branch deletion.
- The catch block in `setupWorktreeFromTopic` calls `cleanupFailedWorktree` before showing the error notification.
- Existing tests still pass.

---

### Phase 2: Multi-Select Popup Support

**Goal**
Extend the tmux/fzf popup menu system to support multi-select mode, needed by the Cleanup button.

**Scope / touchpoints**
- `scripts/menu-popup.sh`: Add `--multi` flag support.
- `extensions/implementation-engine/index.ts`: Add `showMultiSelectPopupMenu()` function near existing `showPopupMenu()` (line ~66).

**Non-goals**
- Do not wire this to the cleanup command yet.
- Do not change the existing single-select `showPopupMenu`.

**TDD approach**
- RED: Write a test that calls `showMultiSelectPopupMenu` with a list of options and verifies it returns an array of strings (the selected items). Write a shell test that runs `menu-popup.sh --multi` with piped input and verifies multi-select output format (newline-separated).
- GREEN: Add `--multi` flag to `menu-popup.sh` that passes `--multi` to fzf and outputs all selected items (newline-separated). Add `showMultiSelectPopupMenu(title, options)` in the extension that calls the script with `--multi` and parses the newline-separated output into a `string[]`.
- REFACTOR: Ensure the function has the same tmux-unavailable fallback pattern as `showPopupMenu`.

**Success criteria**
- `menu-popup.sh --multi "Title" "opt1" "opt2" "opt3"` allows multi-selection and outputs selected items newline-separated.
- `showMultiSelectPopupMenu` returns `string[]` of selected items.
- Existing single-select `showPopupMenu` is unaffected.

---

### Phase 3: Footer Button Layout Replacement

**Goal**
Replace the single `[Worktree ▾]` dropdown with three separate footer buttons: `[Freeform]`, `[Planned]`, `[Cleanup]`. Each button maps to a new command.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`:
  - Status key constants (add `FREEFORM_STATUS_KEY`, `PLANNED_STATUS_KEY`, `CLEANUP_STATUS_KEY`; remove or repurpose `PLAN_WORKFLOW_STATUS_KEY`).
  - Action text constants (add `FREEFORM_ACTION_TEXT`, `PLANNED_ACTION_TEXT`, `CLEANUP_ACTION_TEXT`; remove `WORKTREE_MENU_ACTION_TEXT`).
  - `setActionButton` function (line ~314): update to render three buttons when no active worktree.
  - Register three new commands: `freeform-worktree`, `planned-worktree`, `cleanup-worktrees` — with stub handlers that just call `ctx.ui.notify("Not yet implemented")`.
  - Remove the `worktree-menu` command registration (line ~2131).

**Non-goals**
- Do not implement the actual flows for any of the three buttons yet — stubs only.
- Do not change the Git menu, delete worktree, or sync-needed buttons.
- Do not change behavior when inside an active worktree (those buttons stay as-is).

**TDD approach**
- RED: Write tests that verify: (1) when `setActionButton` is called with stage `"plan"` or `"implement"` and no active worktree, three status items are set with the correct action text; (2) the `worktree-menu` command is no longer registered; (3) three new commands are registered.
- GREEN: Add the constants, update `setActionButton`, register the three commands with stub handlers, remove `worktree-menu`.
- REFACTOR: Remove dead constants (`PLAN_THEN_WORKTREE`, `USE_EXISTING_PLAN`, `FREEFORM_WORKTREE`, `VIEW_STATUS`, `CLEANUP_WORKTREES` string literals from the old menu handler).

**Success criteria**
- Footer shows `[Freeform]` `[Planned]` `[Cleanup]` when on a primary checkout (no active worktree).
- Footer hides all three buttons when inside an active worktree (same rule as current `[Worktree ▾]`).
- Clicking any button shows a "not yet implemented" notification.
- The old `[Worktree ▾]` menu no longer appears.
- Git menu, sync-needed, and delete-worktree buttons are unaffected.

---

### Phase 4: Freeform Worktree Command

**Goal**
Implement the `freeform-worktree` command handler with a streamlined flow: category → name → base branch → create → switch session → pre-fill freeform template.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: `freeform-worktree` command handler (replace stub from Phase 3), `setupWorktreeFromTopic`, `launchImplement` freeform path.

**Non-goals**
- Do not change the planned worktree flow.
- Do not change the cleanup flow.
- Do not change the orchestrator kickoff template content yet (that's Phase 7).

**TDD approach**
- RED: Write tests that verify: (1) `freeform-worktree` command calls `promptForWorktreeCategory`, then `ctx.ui.input` for name, then base branch selection, then `setupWorktreeFromTopic`; (2) on success, `ctx.newSession` is called and `ctx.ui.setEditorText` is called with a template containing `[DESCRIBE YOUR REQUEST HERE]`; (3) on failure, `cleanupFailedWorktree` is called and an error notification is shown.
- GREEN: Wire the freeform command to call the category picker (using the trimmed 8-option list), name input, base branch selection, `setupWorktreeFromTopic`, session creation, and editor pre-fill.
- REFACTOR: Extract shared prompt logic (category + base branch) into a reusable helper if it reduces duplication with planned flow.

**Success criteria**
- Clicking `[Freeform]` presents: category picker (8 options) → name text input → base branch picker → worktree creation progress → session switch → editor pre-filled with freeform template.
- Cancelling at any step shows "cancelled" notification and returns cleanly.
- A creation failure triggers auto-cleanup and shows a clear error.
- The new session is pinned to the worktree directory.
- Auggie indexing is triggered (best effort).

---

### Phase 5: Planned Worktree — Plan Linking via @ Mention

**Goal**
Implement the first half of the `planned-worktree` command: link a plan file using the chat input's existing `@` mention system, then extract the file path from the user's message.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: `planned-worktree` command handler (replace stub from Phase 3), `input` event hook for intercepting the plan file message.

**Non-goals**
- Do not implement curator name suggestion yet (Phase 6).
- Do not create the session or pre-fill the kickoff prompt yet (Phase 7).
- Do not change the freeform flow.

**TDD approach**
- RED: Write tests that verify: (1) clicking `[Planned]` sets editor text to `@` and sets an internal flag `pendingPlannedWorktree = true`; (2) when `pendingPlannedWorktree` is true and the user sends a message, the input hook extracts the `@`-mentioned file path; (3) if the file path is a valid `.md` file under `docs/plans/`, the flow continues (calls a placeholder next step); (4) if the file doesn't exist or isn't a plan file, an error notification is shown and the flag is cleared.
- GREEN: In the `planned-worktree` handler, set `pendingPlannedWorktree = true` and call `ctx.ui.setEditorText("@")`. In the `input` event hook, check for the flag, extract the `@`-mentioned path using the existing `parseReviewCompleteManualPlanPath` pattern, validate the file exists and is a `.md` under `docs/plans/`, read its content, and store it for the next step.
- REFACTOR: Ensure the input interception is clean and doesn't interfere with other input hooks.

**Success criteria**
- Clicking `[Planned]` puts `@` in the editor and the cursor is ready for the user to use @ autocomplete.
- After the user selects a plan file and hits Enter, the extension extracts the file path.
- If the file is valid, the flow proceeds to the next step (category/name prompts — implemented in Phase 6).
- If the file is invalid, a clear error is shown and the state is reset.
- Normal chat messages are unaffected when no planned worktree is pending.

---

### Phase 6: Planned Worktree — Curator Name Suggestion + Category/Name Prompts

**Goal**
After the plan file is linked (Phase 5), prompt for category, spawn the `curator` agent to generate a branch name suggestion from plan content, show the suggestion as the default in a text input, and complete the name selection flow.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: Continue the `planned-worktree` flow after plan file extraction. Curator agent spawning for name generation.

**Non-goals**
- Do not create the session or pre-fill the kickoff prompt yet (Phase 7).
- Do not modify the curator agent itself.
- Do not change freeform or cleanup flows.

**TDD approach**
- RED: Write tests that verify: (1) after plan file extraction, `promptForWorktreeCategory` is called with the trimmed 8-option list; (2) a `curator` agent task is spawned with the plan title and phase headings as context; (3) the curator's suggested name is shown as the default value in `ctx.ui.input`; (4) if the curator call fails or times out, a fallback name is generated from the plan file path slug (existing `buildBranchNameCandidates` logic); (5) the base branch picker is shown after name selection.
- GREEN: After plan file extraction: call category picker, read plan content (title + phase headings), spawn a `curator` task agent with assignment "Generate a concise git branch name slug (2-4 words, kebab-case) from this plan: [title + phases]. Return only the slug, nothing else.", use the curator's output as the default for `ctx.ui.input`, fall back to `buildBranchNameCandidates` on failure, then show base branch picker.
- REFACTOR: Keep the curator spawning logic in a separate helper function (`suggestBranchNameFromPlan`) for testability.

**Success criteria**
- After linking a plan file, the user sees: category picker → name input (pre-filled with curator suggestion) → base branch picker.
- The curator suggestion is a concise kebab-case slug derived from the plan content.
- If the curator fails or takes longer than 10s, the fallback slug from the plan file path is used instead.
- The user can accept the suggestion by pressing Enter or type their own name.

---

### Phase 7: Planned Worktree — Session Creation + Kickoff Prompt

**Goal**
After category, name, and base branch are selected (Phase 6), create the worktree, switch the session, and pre-fill the input box with a short orchestrator kickoff prompt.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: Worktree creation, session creation, kickoff prompt pre-fill. Also simplify the existing long kickoff templates.

**Non-goals**
- Do not change the freeform template (keep as-is for now, simplification is Phase 8).
- Do not change cleanup flow.

**TDD approach**
- RED: Write tests that verify: (1) `setupWorktreeFromTopic` is called with the correct parameters; (2) `ctx.newSession` is called with persisted worktree state and plan metadata; (3) after session creation, `ctx.ui.setEditorText` is called with a prompt that: links the plan file with `@<path>`, is 5 lines or fewer, mentions subagent granularity, designer for UI work, TODO list first, TDD, and verifier tasks; (4) the Orchestrator agent is pre-selected.
- GREEN: Wire the planned flow's final step: call `setupWorktreeFromTopic` → `ctx.newSession` with worktree state + plan metadata → restore worktree context in new session → pre-fill the short kickoff prompt → set Orchestrator agent.
- REFACTOR: Extract the kickoff prompt into a named constant or builder function.

**Planned kickoff prompt template:**
```
Execute the plan at @<plan-file-path>

Rules: Split each phase into small subtasks for individual subagents — never assign a full phase to one agent. Use the designer agent for any UI/UX work. Create the TODO list before dispatching the first task. Follow TDD (write failing tests before implementation). Run verifier tasks after each phase completes.
```

**Success criteria**
- After the name/base-branch prompts complete, the worktree is created at `.worktrees/<prefix><name>`.
- A new session is created, pinned to the worktree.
- Auggie indexing is triggered (best effort).
- The input box is pre-filled with the short kickoff prompt (5 lines max) linking the plan.
- The Orchestrator agent is pre-selected for the session.
- The user can hit Enter to kick off implementation.
- On failure, auto-cleanup runs and a clear error is shown.

---

### Phase 8: Cleanup Button + Freeform Template Simplification + Dead Code Removal

**Goal**
Wire the `[Cleanup]` button to a direct fzf multi-select popup (no `/cleanup` text command), simplify the freeform kickoff template, and remove all dead code from the old worktree menu.

**Scope / touchpoints**
- `extensions/implementation-engine/index.ts`: `cleanup-worktrees` command handler (replace stub), freeform kickoff template simplification, dead code removal.
- `extensions/implementation-engine/cleanup.ts`: Reuse existing cleanup logic.

**Non-goals**
- Do not change the existing `/cleanup` slash command behavior (it should still work if typed manually).
- Do not change the Git menu or other button behaviors.

**TDD approach**
- RED: Write tests that verify: (1) `cleanup-worktrees` command discovers worktrees, calls `showMultiSelectPopupMenu` with formatted labels (branch, path, last commit, merge status), and removes selected worktrees; (2) the freeform kickoff template is 10 lines or fewer (down from ~30); (3) the old `worktree-menu` command string constants (`PLAN_THEN_WORKTREE`, `USE_EXISTING_PLAN`, `FREEFORM_WORKTREE`, `VIEW_STATUS`, `CLEANUP_WORKTREES`) are no longer present in the codebase; (4) there are no unused imports or dead helper functions related to the old menu.
- GREEN: Implement `cleanup-worktrees` handler: discover worktrees → format labels → `showMultiSelectPopupMenu` → clean up selected (reuse `cleanup.ts` logic) → show summary notification. Simplify the freeform template to ~10 lines. Delete all dead code from the old worktree menu.
- REFACTOR: Ensure the cleanup handler has the same tmux-unavailable fallback as other popup menus. Verify no orphaned constants, types, or functions remain.

**Success criteria**
- Clicking `[Cleanup]` shows a fzf multi-select popup with all worktrees, each labeled with branch name, relative path, last commit time, and merge status.
- Selecting worktrees and confirming removes them (worktree, local branch, remote branch).
- If inside a selected worktree, the session CWD moves to repo root first.
- Results are shown as a notification.
- The freeform kickoff template is concise (~10 lines).
- No dead code from the old worktree menu remains.
- The `/cleanup` slash command still works when typed manually.

---

## Phase Execution Contract

- Implement phases sequentially (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8).
- Use one fresh subagent per phase.
- Do not parallelize dependent phases.
- Stop on failure and report blockers before moving to the next phase.
- Use the `designer` agent for any UI/UX work (Phases 3, 8 if visual adjustments are needed).
- Use the `curator` agent for branch name generation (Phase 6).
- Use the `commit-hygiene` skill for atomic commits per phase.
- Use the `test-driven-development` skill for RED-GREEN-REFACTOR per phase.
- Run `verification-before-completion` after each phase.

## Key Files Reference

| File | Role |
|---|---|
| `extensions/implementation-engine/index.ts` | Main extension: commands, UI buttons, worktree lifecycle, session switching |
| `extensions/implementation-engine/cleanup.ts` | Cleanup logic: worktree discovery, removal, branch deletion |
| `extensions/implementation-engine/git-utils.ts` | Git abstractions: repo root, worktree list, branch detection |
| `extensions/implementation-engine/orchestrator-guard.ts` | Orchestrator mode enforcement |
| `scripts/menu-popup.sh` | tmux/fzf popup menu (single-select, extended to multi-select in Phase 2) |

## Current Category List (to be trimmed in Phase 1)

**Current (14 items):**
breaking, revert, feat, fix, perf, refactor, docs, test, style, chore, build, ci, deps, security

**Target (8 items):**
breaking, feat, fix, perf, refactor, docs, chore, security

**Removed:** revert, test, style, build, ci, deps

## Current Flow vs New Flow

### Current (Freeform)
`[Worktree ▾]` → popup menu (5 options) → select "Freeform worktree" → category (14 options) → base branch → name candidates (select or type) → create → session switch

### New (Freeform)
`[Freeform]` → category (8 options) → name (text input) → base branch → create → session switch → pre-filled template

### Current (Planned)
`[Worktree ▾]` → popup menu → "Use existing plan" → plan metadata lookup (often fails) → category → base branch → name → create → 30-line kickoff prompt

### New (Planned)
`[Planned]` → `@` in editor → user picks plan file → category (8 options) → curator-suggested name (editable) → base branch → create → session switch → 3-line kickoff prompt → user hits Enter

### Current (Cleanup)
`[Worktree ▾]` → popup menu → "Cleanup old worktrees" → types `/cleanup` → slash command runs → multi-select

### New (Cleanup)
`[Cleanup]` → fzf multi-select popup (immediate) → clean up selected → summary notification

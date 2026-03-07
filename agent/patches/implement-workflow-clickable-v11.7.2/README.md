# Implement Workflow Clickable Button Patch (validated on OMP 13.2.1)

This package captures the local runtime patch that enables true clickable footer action buttons in Oh My Pi's footer/status line (with hover highlight):

- `Plan`
- `Implement`
- `Submit PR`
- `Review Complete` (during Submit PR stage)
- `Fix Issues` (inside the spawned review session, replaces Review Complete for remediation handoff)
- `Delete Worktree` (only while Submit PR stage is active)
- `Cleanup`

And adds Opencode-style subagent transcript navigation in interactive mode:

- `Ctrl+X` + `Left/Right` to cycle spawned subagents
- `Ctrl+X` + `Up` to return to parent/main view
- Status line enters a focused `SUBAGENT VIEW` mode (overrides other footer hook buttons while active) with model/context metadata

And adds orchestration-focused delegation/model controls:

- Dedicated `/model` role badge/action for `Orchestrator`
- Dedicated `/model` role badge/action for `Explore`
- Task runtime model resolver that prioritizes the session's active `/model` selection for subagents, with role-specific fallback (`Explore`/`Subagent`) only when no active session model is available
- implementation-engine extension runtime defaults that pin parent implementation turns to `Orchestrator` role (fallback `Default`)
- User-level `task` / `explore` agent overrides in `~/.omp/agent/agents` to push 1-5 parallel explore fan-out before cross-module implementation work
- Enforced explore fan-out cap: max 5 explore tasks per Task tool call

## What it patches

- `@oh-my-pi/pi-tui/src/terminal.ts`
  - Enables and disables terminal mouse reporting (`1000` + `1003` + `1006`) for click + hover support
- `@oh-my-pi/pi-tui/src/tui.ts`
  - Parses SGR mouse input and exposes `onMouse` callback
- `@oh-my-pi/pi-tui/src/index.ts`
  - Exports mouse event types
- `@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts`
	  - Wires footer click handling to run `/plan-new`, `/implement`, `/submit-pr`, `/delete-worktree`, or `/cleanup`
  - Adds hover-state visual styling for all footer action buttons
	  - Adds `cycleSubagentView` transcript viewer with status-line indicator
- `@oh-my-pi/pi-coding-agent/src/config/keybindings.ts`
	  - Adds app actions `cycleSubagentForward` / `cycleSubagentBackward`
	  - Default leader key: `Ctrl+X`
- `@oh-my-pi/pi-coding-agent/src/config/settings-schema.ts`
  - Defaults `clearOnShrink` to enabled to prevent stale viewport artifacts after transcript/context shrink

- `@oh-my-pi/pi-coding-agent/src/modes/controllers/input-controller.ts`
	  - Implements Ctrl+X leader chord handling for left/right/up subagent navigation
- `@oh-my-pi/pi-coding-agent/src/modes/controllers/event-controller.ts`
	  - Suppresses parent-session chat mutations while subagent view is active so live subagent rendering stays stable
- `@oh-my-pi/pi-coding-agent/src/modes/controllers/command-controller.ts`
	  - Documents subagent cycle hotkeys in `/hotkeys`
- `@oh-my-pi/pi-coding-agent/src/modes/types.ts`
	  - Extends interactive mode context with subagent-view lifecycle methods (`cycleSubagentView`, `exitSubagentView`, `isSubagentViewActive`)
- `@oh-my-pi/pi-coding-agent/src/modes/components/custom-editor.ts`
	  - Allows conditional custom key passthrough so arrow keys still edit text unless chord mode is active
- `@oh-my-pi/pi-coding-agent/src/modes/components/status-line.ts`
  - Resolves git branch correctly in worktrees (`.git` file -> linked `gitdir`/`HEAD`)
- `@oh-my-pi/pi-coding-agent/src/modes/components/status-line/segments.ts`
  - Compacts worktree cwd display to repo-relative form (`<repo>/.worktrees/<name>/...`)
  - Shows a worktree-specific branch icon in the git segment
- `@oh-my-pi/pi-coding-agent/src/task/index.ts`
  - Forces Task subagents to inherit live `process.cwd()` so spawned agents stay in the active worktree
  - Resolves the session's active model at task launch time so `/model` updates apply immediately without restarting OMP
  - Uses role-specific fallback (`Explore` for `explore` runs, `Subagent` for other workers) only when no active session model is available
- `@oh-my-pi/pi-coding-agent/src/task/executor.ts`
	  - Uses uncached token counts (`input + output`) for subagent progress/display metrics instead of inflated cache-inclusive totals
	  - Keeps subagents headless (`hasUI: false`) so they remain autonomous and never block waiting for interactive `ask` input
- `@oh-my-pi/pi-coding-agent/src/tools/index.ts`
	  - Keeps `todo_write` available even when `submit_result` is required, so subagents retain full task-tracking tool parity
- `@oh-my-pi/pi-coding-agent/src/task/agents.ts`
	  - Defaults bundled `task` subagent thinking level to `high`
- `@oh-my-pi/pi-coding-agent/src/config/model-registry.ts`
	  - Adds `Orchestrator` + `Subagent` + `Explore` model roles and `/model` badge/actions (`ORCHESTRATOR`, `SUBAGENT`, `EXPLORE`)
- `@oh-my-pi/pi-coding-agent/src/modes/components/status-line.ts`
  - Resolves git HEAD correctly for worktrees where `.git` is a file pointing to `gitdir`
- `@oh-my-pi/pi-coding-agent/src/modes/components/status-line/segments.ts`
  - Compacts displayed worktree cwd to `RepoName/.worktrees/<name>`
  - Shows a tree icon marker for worktree branch display in the git segment

## Included scripts

- `manage.sh status` inspects whether this archived snapshot matches the current global install.
- `manage.sh apply [--force]` and `manage.sh restore` are historical recovery tools for this archived snapshot only.

## Usage

Do not use this bundle as part of normal fork refresh or upgrade flows.
Current fork runtime changes ship through the packaged source under `packages/` and are installed by `bun --cwd=<fork-root> run reinstall:fork`.

Use this bundle only if you are intentionally recovering the older archived snapshot and understand it can overwrite newer runtime code.

## Notes

- Target version: `12.9.0`
- This bundle is archived. Startup auto-apply has been retired because it can overwrite newer fork runtime changes after reinstall.
- Your implementation launcher extension is configured separately at:
  - `~/.omp/agent/extensions/implementation-engine/index.ts`
			  - Initial footer state shows both `Plan` and `Implement`.
				- `Plan` runs `/plan-new` to bootstrap planning in the primary checkout.
				- `Implement` runs `/implement` in manual mode when no metadata exists (creates/switches worktree, then waits for user to attach plan with `@`).
	  - `/implement` is the implementation launcher used by the footer `Implement` button.
		  - When `/plan-new` metadata exists, `/implement` creates/switches to worktree, runs Auggie index warmup, and auto-kicks implementation from the plan metadata source of truth.
		  - It drives button lifecycle: `Plan` -> `Implement` -> `Submit PR` (with optional `Review Complete`, then `Fix Issues` in the review session) -> `Cleanup`.
		  - During `Submit PR`, `Review Complete` launches a verification-only review session; in that review session, `Fix Issues` launches a remediation session using the review findings. A far-right `Delete Worktree` action can still discard the active worktree (with confirmation).
		  - Active worktree state now persists the exact plan file path/workspace so review flows verify the same plan that implementation executed.
		  - Subagent phase execution now follows the session's active `/model` selection, with `Subagent` role used only as fallback when active model is unavailable.
		  - Bundled `task` subagents default to high thinking; to customize, override `task` in `~/.omp/agent/agents/task.md` with your desired `thinking-level`.
		  - Explore delegation behavior can be customized in `~/.omp/agent/agents/explore.md` and `~/.omp/agent/agents/task.md`.

  - It persists worktree state in session entries so `/resume` restores the worktree cwd/branch context.

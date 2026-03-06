# OMP Worktree UX Overhaul Design

**Date:** 2026-02-20
**Scope:** 4 features — thinking level fix, /model roles, /resume overhaul, worktree button detection

## Feature 1: Thinking Level Status Line Fix

### Problem
The status line reads `state.thinkingLevel` at render time but this value is only synced from `model-role-thinking.json` inside `before_agent_start` when a worktree session is active (`setupDone && last.worktreePath`). For non-worktree sessions and on initial session start, the thinking level from the JSON file is never applied. Additionally, `#isCurrentSessionRole()` can fail during `/model` flow, preventing hot-apply.

### Root Cause
- `session_start` handler doesn't call `ensureOrchestratorRuntimeDefaults()` or `ensureDefaultRuntimeDefaults()`
- `before_agent_start` handler gates thinking level sync behind `setupDone && last.worktreePath`
- `shouldHotApply` in patched `selector-controller.ts` depends on `getLastModelChangeRole()` which may not match

### Fix (Extension + Patch)
1. **Extension (plan-worktree/index.ts):**
   - `session_start` and `session_switch`: detect current role, read JSON, call `pi.setThinkingLevel()`
   - `before_agent_start`: add thinking level sync path for non-worktree sessions
   - `input` event: detect `/model` completion, re-read JSON, re-apply thinking level

2. **Patch (selector-controller.ts):**
   - Fix `shouldHotApply` to always hot-apply when role matches current session model
   - After `writeModelRoleThinkingLevel()`, always call `ctx.session.setThinkingLevel()` and `ctx.statusLine.invalidate()`

### Files
- `/home/colin/.omp/agent/extensions/plan-worktree/index.ts` (lines 1791-1812, 2234-2262)
- `/home/colin/.omp/agent/patches/.../selector-controller.ts` (lines 550-580)

---

## Feature 2: /model All-Roles Display + Summary Header

### Problem
MENU_ACTIONS in model-selector.ts hardcodes 4 roles (default/smol/slow/plan). MODEL_ROLES defines 12. Badge rendering also only checks 4. Users can't see all role assignments at a glance.

### Fix (Patch model-selector.ts)
1. Replace `MENU_ACTIONS` with all 12 roles from `MODEL_ROLE_IDS`
2. Expand badge rendering to check all 12 roles with colors from `MODEL_ROLES`
3. Add role summary header above search input:
   - Two-column layout showing all roles
   - Each role shows: `ROLE_NAME  model-id [thinking-level]`
   - Unassigned roles show `UNASSIGNED!` in red
   - Thinking levels read from `model-role-thinking.json`
4. Expand `_loadRoleModels()` and `handleSelect()` for all 12 roles

### Layout
```
 Model Roles:
 DEFAULT     gpt-5.3-codex [high]     ORCHESTRATOR  claude-opus-4.6 [med]
 SMOL        gemini-3-flash           SLOW          UNASSIGNED!
 PLAN        claude-opus-4.6          COMMIT        glm-5 [med]
 SUBAGENT    gpt-5.3-codex [high]     EXPLORE       gemini-3-flash [min]
 LINT        glm-5 [med]              MERGE         gpt-5.3-codex [xhi]
 CURATOR     kimi-k2.5 [min]          RESEARCH      gpt-5.2 [med]
```

### Files
- Patch: `model-selector.ts` (major rewrite of MENU_ACTIONS, badges, _loadRoleModels)
- Patch: `model-registry.ts` (already has all roles — import MODEL_ROLES)
- Read: `model-role-thinking.json` (for thinking levels in header)

---

## Feature 3: /resume Worktree-Aware Session Navigator

### Problem
SessionSelectorComponent has flat fuzzy-filter list. No worktree grouping, no tabs, no color coding, no archived view.

### Fix (Extension custom command via ctx.ui.custom)
Register `/resume` via `pi.registerCommand()`. Extension commands checked before built-in. Render full custom component.

### Session Metadata Enrichment
For each session file:
- Parse `cwd` to detect worktree (git-native .git file check with directory walk-up)
- Extract worktree name, branch, repo from path
- Read custom entries for agent mode (plan-worktree extension entries)
- Classify: worktree name or "main" or "non-git"
- Classify: active (<7d) or archived (>=7d)

### Tab Navigation
Horizontal TabBar (same as /model):
- `All` — all non-archived sessions
- `<repo>/<worktree>` — per worktree group
- `main` — main/master checkout sessions
- Tab/Shift+Tab cycles tabs
- Last-used tab cached in extension state

### Session Entry Rendering (two-line)
Line 1: `[WT: feature-xyz]` (colored badge) + title/first-message
Line 2: `  3 hours ago · Orchestrator · .../repo/.worktrees/feat · 42 msgs`
- Timestamp colors: green (<1h), yellow (1-24h), dim (>24h)
- Agent mode: `Orchestrator` (orange), `Default` (green)
- Path: last 3 segments

### Archived View
`A` hotkey opens separate modal with same structure.
Shows sessions >7 days old. Same tabs, filtering, navigation.

### Worktree-Aware Resume
- If session cwd is worktree → chdir there before resuming
- Restore worktree state from session entries
- Re-evaluate button state after resume

### Files
- Extension: plan-worktree/index.ts (new /resume command handler)
- Uses: ctx.ui.custom(), TabBar, Container, Text, Input from pi-tui
- Uses: SessionManager.collectSessionsFromFiles() for session data

---

## Feature 4: Worktree Button Detection Fix

### Problem
`isWorktreePath()` checks for `.worktrees` in CWD path — fragile, misses standard git worktrees, breaks on /resume and /handoff.

### Fix (Extension-only, plan-worktree)
1. **Git-native detection:**
   ```typescript
   async function findGitRoot(dir: string): Promise<{ root: string; isWorktree: boolean } | null> {
     let current = path.resolve(dir);
     while (true) {
       const gitPath = path.join(current, '.git');
       const stat = await fs.stat(gitPath).catch(() => null);
       if (stat) {
         return { root: current, isWorktree: stat.isFile() };
       }
       const parent = path.dirname(current);
       if (parent === current) return null;
       current = parent;
     }
   }
   ```

2. **Button state logic:**
   - In worktree → show `git`, `review`, `✕ worktree` buttons
   - In main checkout → show `Worktree` button
   - Not in git → hide all worktree buttons

3. **Resume-aware:**
   - After tryRestoreWorktreeState, re-evaluate with git-native detection
   - For sessions without persisted state, detect from CWD
   - On session_switch, re-detect

4. **Fallback chain:**
   - Primary: `.git` is file → worktree
   - Secondary: `.worktrees` in path → worktree (backward compat)
   - Tertiary: `git rev-parse --git-common-dir` (subprocess, only if inconclusive)

### Files
- Extension: plan-worktree/index.ts (setActionButton, session_start, session_switch, tryRestoreWorktreeState)

---

## Implementation Order
1. Feature 4 (worktree detection) — foundational, needed by Features 1 and 3
2. Feature 1 (thinking level fix) — high priority bug fix
3. Feature 2 (/model roles) — patch model-selector.ts
4. Feature 3 (/resume overhaul) — largest feature, depends on worktree detection

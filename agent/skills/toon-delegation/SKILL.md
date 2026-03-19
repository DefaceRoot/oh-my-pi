---
name: toon-delegation
description: Compact reference for the `omp-delegation/v1` TOON envelope. Load whenever you may delegate tasks. Covers schema, profiles, linter rules, commander's intent, retry guidance, and strict-mode examples.
---

# TOON Delegation

**TOON is internal-only.** Never emit TOON in user-facing messages or conversational responses.

All delegating agents (Orchestrator, Default, Plan, Implement, Ask) must load this skill and emit a single fenced ` ```toon ` block as the subagent user prompt for every task delegation. The TOON block is the single source of truth for the delegation contract.

## Schema — `omp-delegation/v1`

Emit fields in canonical order (below) to maximize prompt-cache alignment across sessions.

| Field | Required | Notes |
|-------|----------|-------|
| `contract_version` | yes | always `"omp-delegation/v1"` |
| `envelope.id` | yes | `del_` + 12-char hex (SHA-256 of task content) |
| `envelope.parent_envelope_id` | if sub-delegation | inherit from parent `envelope.id` |
| `envelope.created_at` | yes | ISO-8601 timestamp |
| `input_policy.mode` | yes | `"minimal"` / `"standard"` / `"detailed"` |
| `context.plan_path` | if plan exists | absolute path to `plan.md` |
| `context.plan_workspace_dir` | if plan exists | directory containing `plan.md` |
| `context.plan_excerpt` | detailed only | ≤60 lines of relevant plan section |
| `context.repo_root` | yes | absolute path |
| `context.workflow_mode` | yes | current agent mode |
| `context.git.branch` | standard + detailed | current branch |
| `context.git.base_branch` | standard + detailed | upstream branch |
| `context.git.commit` | standard + detailed | HEAD SHA |
| `context.worktree.path` | if worktree active | absolute path |
| `roles.delegator` | yes | current agent role |
| `roles.delegate` | yes | target agent name |
| `progress.completed_tasks` | standard + detailed | last 5 (standard) / 10 (detailed) |
| `progress.upstream_tasks` | detailed only | dependency tasks from plan |
| `progress.lessons_learned` | detailed only | max 5 one-line strings |
| `task.id` | yes | stable task identifier |
| `task.title` | yes | short imperative title |
| `task.description` | yes | ≥20 chars; WHAT and DONE criteria |
| `task.summary` | optional | one sentence |
| `task.intent` | optional | commander's intent; see below |
| `task.blockers` | optional | known blockers |
| `task.constraints` | yes | at least one entry |
| `task.acceptance_criteria` | yes | at least one entry |
| `retry_context` | if retry only | structured prior-failure details |
| `output_contract` | recommended for `implement` | expected output format |

## Input-Shaping Profiles

Default profile by delegate type:
- **minimal**: `lint`, `code-reviewer`
- **standard**: `explore`, `research`, `plan-verifier`
- **detailed**: `implement`, `debug`, `task`

Override via `options.profile` when a different richness level is warranted.

| Field | minimal | standard | detailed |
|-------|---------|----------|----------|
| `context.plan_path` | if exists | if exists | if exists |
| `context.plan_excerpt` | no | no | yes |
| `context.git` | no | yes | yes |
| `context.worktree` | no | if exists | if exists |
| `progress.completed_tasks` | no | last 5 | last 10 |
| `progress.upstream_tasks` | no | no | yes |
| `progress.lessons_learned` | no | no | yes |
| `retry_context` | if retry | if retry | if retry |
| `output_contract` | if present | yes | yes |

## Quality Linter

The builder runs `validateDelegationQuality` before emission. Warnings are logged to stderr but do not halt delegation. Errors indicate the delegation should be fixed before sending.

| Rule | Severity |
|------|----------|
| `task.description` under 20 characters | warning |
| `task.constraints` empty or missing | warning |
| `task.acceptance_criteria` empty or missing | warning |
| `implement` delegate without `output_contract` (non-minimal profile) | warning |
| `plan_path` exists but `plan_excerpt` absent (detailed profile) | warning |
| `plan_path` file does not exist on disk | error |

## Commander's Intent

Populate `task.intent` with a single sentence capturing the high-level objective — not the steps. Intent lets the delegate make autonomous decisions when the description doesn't cover a situation.

**Good:** `"All delegating agents must produce structured envelopes that carry enough context for subagents to work independently."`

**Poor:** `"Do step 3 as described above."`

Sources (priority order): plan goal for the enclosing section → user's stated objective → parent delegation's `task.intent`. Omit if no clear source exists; do not fabricate.

## Retry Context

`retry_context` is only present when retrying a previously failed task. On receipt:

1. Read `prior_failure.error_type` and `prior_failure.diagnosis` before starting.
2. Identify the root cause; do not repeat the same failing step.
3. Resume from `prior_artifacts` when partial work is recoverable.
4. Trust observations over the inherited diagnosis if they conflict.

Recommended fields: `attempt` (int), `prior_failure.error_type`, `prior_failure.failing_step`, `prior_failure.what_was_tried`, `prior_failure.diagnosis`, `prior_artifacts[N]`.

## Lessons Learned

`progress.lessons_learned` holds up to 5 compact gotchas from prior tasks in the same session. Read before starting work. Example (inline primitive array):

```toon
    lessons_learned[1]: "Tabular headers require underscores; hyphens break strict-mode parsing"
```

## TOON Syntax Rules

- **Indentation:** 2 spaces per level; tabs are invalid.
- **No comments:** use a `notes:` field if annotations are needed.
- **Field names:** snake_case; tabular column headers must be alphanumeric and underscore only.
- **Primitive array:** `key[N]: "val1","val2"` — `[N]` must equal the actual item count.
- **Tabular array:** `key[N]{col1,col2}:` then one row per line — all rows must have the same columns and primitive values.
- **List array:** `key[N]:` then `- "value"` items — used for non-uniform or nested values.
- **Strings:** always JSON-quoted (`"..."`). Escape embedded quotes as `\"`.
- **Token budget:** target <2000 tokens. Trim order when over budget: `lessons_learned` → `completed_tasks` window → `plan_excerpt` → truncate `task.description`. Never trim `task.title`, `constraints`, or `acceptance_criteria`.

## Example 1: Orchestrator → Implement (detailed)

```toon
delegation:
  contract_version: "omp-delegation/v1"
  envelope:
    id: "del_f1a2b3c4d5e6"
    parent_envelope_id: "del_4a9b2c1e8f3d"
    created_at: "2026-03-19T14:30:00Z"
  input_policy:
    mode: "detailed"
  context:
    plan_path: "/repo/.omp/sessions/plans/my-plan/plan.md"
    plan_workspace_dir: "/repo/.omp/sessions/plans/my-plan"
    repo_root: "/repo/oh-my-pi"
    workflow_mode: "orchestrator"
    git:
      branch: "feature/my-feature"
      base_branch: "main"
      commit: "abcdef1234567890abcdef12"
    worktree:
      path: "/repo/.worktrees/feature-my-feature"
  roles:
    delegator: "orchestrator"
    delegate: "implement"
  progress:
    upstream_tasks[1]{id,summary,status,artifacts}:
      "task-2","TOON builder wired into task pipeline","done","task/index.ts"
    completed_tasks[2]{summary,status}:
      "TOON builder implemented","done"
      "Builder wired into task pipeline","done"
    lessons_learned[1]: "Tabular headers require underscores; hyphens break strict-mode parsing"
  task:
    id: "task-3"
    title: "Create TOON delegation skill"
    description: "Create agent/skills/toon-delegation/SKILL.md with schema, profiles, linter rules, and strict-mode examples."
    intent: "Delegating agents need a compact reference so all envelopes are consistent and parseable."
    constraints[2]: "skill file must be under 200 lines","all TOON examples must be strict-mode valid"
    acceptance_criteria[2]: "skill file exists at agent/skills/toon-delegation/SKILL.md","all TOON examples parse without error"
  output_contract:
    format: "markdown"
```

## Example 2: Implement → Lint (minimal)

```toon
delegation:
  contract_version: "omp-delegation/v1"
  envelope:
    id: "del_aabb11cc22dd"
    created_at: "2026-03-19T15:00:00Z"
  input_policy:
    mode: "minimal"
  context:
    repo_root: "/repo/oh-my-pi"
    workflow_mode: "implement"
  roles:
    delegator: "implement"
    delegate: "lint"
  task:
    id: "lint-task-3"
    title: "Lint toon-delegation skill changes"
    description: "Run biome lint and typecheck on changed files for the toon-delegation skill."
    constraints[1]: "scope lint to changed files only"
    acceptance_criteria[1]: "biome check and bun typecheck pass with no errors"
```

## Contract Versioning

The current version is `"omp-delegation/v1"`. When the schema has breaking changes, the version is incremented, this skill is updated, and all delegating agents must emit the new version string.

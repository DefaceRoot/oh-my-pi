---
description: "Planning session workflow. Read ONLY during /plan or /plan-new sessions."
alwaysApply: false
---

# Planning Protocol (MANDATORY)

When `/plan` is invoked or when creating ANY implementation plan:

<critical>
## Worktree Questions Are Handled by an Extension (NOT the LLM `ask` tool)

The `plan-worktree` extension intercepts plan sessions and prompts the user (via UI dialogs) for:
1. **Base branch** (usually `master`)
2. **New branch name**

These are asked **before** the agent responds.

**Do NOT ask the user for base branch / branch name using the LLM `ask` tool.**

The extension will create the worktree in the background and inject a message:
- `plan-worktree/pending` while creating
- `plan-worktree/ready` when complete (includes worktree path)

After you see `plan-worktree/ready`, proceed with planning/exploration using the worktree path.

Important: The new branch is checked out **inside the worktree directory**. The original repo typically remains on its current branch.
</critical>

## Planning vs Implementation

- Click the footer `Plan` button (or run `/plan-new`) in your current checkout (typically `master`) to bootstrap planning and create/update the phased TDD plan file under `docs/plans/<plan-title>/`.
- Plan files should use: `docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md`.
- Keep plan-scoped artifacts (notes/checklists/json metadata/scratch files) in that same `docs/plans/<plan-title>/` directory.
- Use `/implement` (or the footer `Implement` button) only after the plan file exists.

## Brainstorming Approach

Use the `superpowers:brainstorming` skill approach during plan/design work:
- Ask questions ONE AT A TIME
- Prefer multiple choice questions when possible
- Present design in 200-300 word sections, validating each

## Final Plan Output

Plans must be phase-based and implementation-ready:

```markdown
## Phased Implementation Plan (Agent-Sized)
### Phase 1 ...
### Phase 2 ...
```

- Each phase should explicitly preserve atomic commit boundaries.
- The plan (or implementation handoff) should instruct use of the `commit-hygiene` skill for phase execution.

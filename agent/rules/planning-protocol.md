---
description: "Planning session workflow. Read ONLY during /plan or /plan-new sessions."
alwaysApply: false
---

# Planning Protocol (MANDATORY)

When `/plan` is invoked or when creating ANY implementation plan:

<critical>
## Worktree Questions Are Handled by an Extension (NOT the LLM `ask` tool)

The `implementation-engine` extension intercepts plan sessions and prompts the user (via UI dialogs) for:
1. **Base branch** (usually `master`)
2. **New branch name**

These are asked **before** the agent responds.

**Do NOT ask the user for base branch / branch name using the LLM `ask` tool.**

The extension will create the worktree in the background and inject a message:
- `implement-worktree/pending` while creating
- `implement-worktree/ready` when complete (includes worktree path)

After you see `implement-worktree/ready`, proceed with planning/exploration using the worktree path.

Important: The new branch is checked out **inside the worktree directory**. The original repo typically remains on its current branch.
</critical>

## Planning vs Implementation

- Click the footer `Plan` button (or run `/plan-new`) in your current checkout (typically `master`) to bootstrap planning and create/update the phased TDD plan file under `.omp/sessions/plans/`.
- Plan files should use: `.omp/sessions/plans/<kebab-case-goal-name>.md`.
- Keep plan-scoped artifacts (notes/checklists/json metadata/scratch files) under `.omp/sessions/plans/` alongside the plan file.
- Use `/implement` (or the footer `Implement` button) only after the plan file exists.

## Brainstorming Approach

Use the `superpowers:brainstorming` skill approach during plan/design work:
- Ask questions ONE AT A TIME
- Prefer multiple choice questions when possible
- Present design in 200-300 word sections, validating each

## Local Planning Guidance Source

- Use `superpowers:writing-plans` for baseline structure.
- Apply repo-local constraints from `agent/skills/writing-plans/SKILL.md`; this repository supplement is authoritative for orchestrator-ready plan formatting.
- Keep heavy planning context with the Plan Agent while authoring the plan document. The later Orchestrator execution gets only the finished plan file.

## Final Plan Output

Plans must be phase-based and directly executable by a fresh Orchestrator session with zero extra conversation context:

```markdown
## Phased Implementation Plan (Agent-Sized)
### Phase 1: ...
#### Unit 1.1: ...
#### Unit 1.2 (P): ...
### Phase 2: ...
```

Required plan constraints:
- Every phase must decompose into very small implementation units (typically 1-2 file edits or one focused command).
- Use `(P)` only for units proven safe to run in parallel.
- Every unit MUST include `**Depends on**` with explicit unit IDs, or `None` if independent.
- Every unit MUST encode TDD explicitly with test-first sequencing (`Tests First` before `Implementation`).
- If a unit is marked `(P)`, include `**Parallel safety**` evidence (no shared files, no shared contract ownership, no ordering dependency).
- Keep phase ordering and commit boundaries explicit so an orchestrator can execute without re-planning.
- The plan (or implementation handoff) should instruct use of the `commit-hygiene` skill for phase execution.

## Post-Plan Verification Gate (MANDATORY before planning completes)

After writing `.omp/sessions/plans/<kebab-case-goal-name>.md`, run a plan-quality verification round before leaving planning mode.

Required flow:
1. Parse all phase headings and derive deterministic `phase_key` values (recommended: zero-padded order + slug, for example `01-bootstrap-workflow`).
2. Spawn one `plan-verifier` subagent per phase in parallel via Task (`agent: "plan-verifier"`).
3. For each verifier assignment, provide:
   - `plan_file`
   - `phase_key`
   - `run_timestamp` in UTC compact format (`YYYYMMDD-HHMMSSZ`)
   - Full plan content plus assigned phase scope
4. Require repo-local validation assets: `skill://validate-implementation-plan` and `skill://validate-implementation-plan/references/artifact-output.md`.
5. Require deterministic artifact layout beside the plan file (never ad hoc temp paths):
.omp/sessions/plans/<plan-stem>.plan-verifier/<phase-key>/<run-timestamp>/
6. Each run directory must contain both files:
   - `verification.md`
   - `findings.json`
7. Treat verifier outcomes as gates:
   - `BLOCKED` or `PASS WITH FINDINGS` => patch plan and re-run affected phase verifiers with a new timestamp directory.
   - Planning is complete only when the latest run for every phase returns `PASS`.

Scope boundary: this gate validates plan quality before coding starts. Implementation/runtime verification remains in the implementation workflow and is a separate step.

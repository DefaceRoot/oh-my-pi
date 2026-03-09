---
description: "Planning session workflow. Read ONLY during /plan or /plan-new sessions."
alwaysApply: false
---

# Planning Protocol (MANDATORY)

When `/plan` is invoked or when creating any implementation plan:

<critical>
## Planning Uses the Current Workspace
Planning uses the workspace already attached to the session.
Reuse the workspace or worktree already visible from the current CWD.
Do NOT ask the user for branch names, base branches, or worktree setup during planning unless they explicitly request that workflow.
Do NOT create a new worktree as part of planning by default.
</critical>

## Planning vs Implementation

- Click the footer `Plan` button (or run `/plan-new`) in your current checkout to bootstrap planning.
- Persisted plan files must use: `.omp/sessions/plans/<plan-slug>/plan.md`.
- Persisted verifier artifacts must use: `.omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/`.
- Only the plan agent updates `plan.md`; plan-verifier agents write artifacts only.
- Use `/implement` only after the plan file exists.

## Ask Tool Discipline

- After entering planning mode, every user-facing planning question must go through the ask tool.
- Ask questions one at a time.
- Prefer multiple choice questions when possible.
- Use the ask tool again for section-by-section validation instead of typing raw questions in assistant prose.

## Local Planning Guidance Source

- Use `superpowers:writing-plans` for baseline structure.
- Apply repo-local constraints from `agent/skills/writing-plans/SKILL.md`; this repository supplement is authoritative for orchestrator-ready plan formatting.
- Keep heavy planning context with the plan agent while authoring the plan document. The later implementation session gets only the finished plan file.

## Final Plan Output

Plans must be phase-based and directly executable by a fresh implementation session with zero extra conversation context:

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
- Keep phase ordering and commit boundaries explicit so an implementation orchestrator can execute without re-planning.
- The plan should instruct use of the `commit-hygiene` skill during implementation.

## Post-Plan Verification Gate (MANDATORY before planning completes)

After writing `.omp/sessions/plans/<plan-slug>/plan.md`, run a plan-quality verification round before leaving planning mode.

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
.omp/sessions/plans/<plan-slug>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/
6. Each run directory must contain both files:
   - `verification.md`
   - `findings.json`
7. Treat verifier outcomes as gates:
   - `BLOCKED` or `PASS WITH FINDINGS` => patch plan and re-run affected phase verifiers with a new timestamp directory.
   - Planning is complete only when the latest run for every phase returns `PASS`.

Scope boundary: this gate validates plan quality before coding starts. Implementation/runtime verification remains in the implementation workflow and is a separate step.
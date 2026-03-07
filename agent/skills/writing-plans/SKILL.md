---
name: writing-plans
description: Repo-local supplement for orchestrator-ready implementation plans in Oh My Pi. Use with superpowers:writing-plans.
---

# Writing Plans (Oh My Pi Supplement)

Use this repository-local supplement as required constraints layered on top of the global `superpowers:writing-plans` skill.

The plan agent owns this planning context while authoring. The implementation orchestrator later receives only the finished plan file.

## Required plan shape

1. `## Phased Implementation Plan (Agent-Sized)` section is required.
2. Each phase must decompose into very small units:
   - `#### Unit N.M: ...`
   - `#### Unit N.M (P): ...` only when safe parallelism is proven.
3. Unit size target: 1-2 file edits or one focused command.
4. Every unit must include:
   - `**Files**`
   - `**Change**`
   - `**Depends on**` (explicit unit IDs or `None`)
   - `**Tests First**`
   - `**Implementation**`
   - `**Verification**`

## Parallel markers and dependency discipline

- `(P)` is opt-in and must be justified per unit.
- Each `(P)` unit must include `**Parallel safety**` evidence:
  - no shared files with concurrent units
  - no shared contract/type ownership
  - no ordering dependency
- If any safety proof is missing, remove `(P)` and keep execution sequential.

## TDD encoding

- Test units must appear before implementation units they validate.
- Every implementation unit must reference the test unit(s) it turns green.
- Verification steps must be concrete commands with expected observable outcomes.
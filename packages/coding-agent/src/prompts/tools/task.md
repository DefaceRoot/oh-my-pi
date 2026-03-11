Launch subagents to parallelize independent work.

Subagents do not inherit your chat history. Put all required constraints, file paths, and acceptance criteria in `context` + per-task `assignment`.

<parameters>
- `agent`: subagent type used by all tasks.
- `context`: shared background prepended to every task (goal, constraints, contract, global acceptance).
- `tasks[]`:
  - `id`: CamelCase, <= 48 chars
  - `description`: short UI-only summary
  - `assignment`: complete, self-contained instructions for that task
</parameters>

<critical>
- Keep shared constraints in `context`; do not duplicate them in every assignment.
- Do not request project-wide build/lint/test inside task assignments.
- If scope is unclear, run a discovery task first, then fan out.
- Each task should be narrowly scoped (about 3-5 files max) with explicit file paths.
</critical>

<parallelization>
Run tasks in parallel only when outputs are independent.
Use sequential ordering when one task defines contracts another depends on (types/interfaces, API exports, schema/migrations, core module changes).
</parallelization>

<template>
`context` should contain:
- Goal
- Non-goals
- Constraints
- API contract (if shared)
- Global acceptance

Each `assignment` should contain:
- Target (exact files/symbols)
- Change (step-by-step edits)
- Edge Cases
- Acceptance (observable completion condition)
</template>

<checklist>
Before invoking:
- Tasks are truly independent
- Paths are explicit (no broad globs like “update all”)
- Assignments are complete and not one-liners
- `schema` is provided when structured output is required
</checklist>

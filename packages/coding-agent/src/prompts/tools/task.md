Launch subagents to parallelize independent work.

Subagents do not inherit your chat history. Put all required constraints, file paths, and acceptance criteria in `context` + per-task `assignment`.

<parameters>
- `agent`: subagent type used by all tasks.
- `context`: shared background prepended to every task (goal, constraints, contract, global acceptance).
- `tasks[]`:
  - `id`: CamelCase, <= 48 chars
  - `description`: short UI-only summary
  - `assignment`: complete, self-contained instructions for that task
- `timeout`: optional, seconds. When set, waits up to this duration then returns current status. Tasks keep running in the background and can be polled with `await`. Use for long-running tasks where you need periodic control to assess progress or handle errors.
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

<delegation>
The system automatically constructs a structured delegation envelope (`omp-delegation/v1`) for each subagent, encoding shared context, task assignment, constraints, and acceptance criteria into a compact format.

Envelope richness scales with the delegate type:
- **minimal**: `lint`, `code-reviewer` — only core task fields and repo root.
- **standard**: `explore`, `research`, `plan-verifier` — adds git metadata, completed-task progress.
- **detailed**: `implement`, `debug`, `task` — adds plan excerpt, upstream tasks, lessons learned.

The builder automatically:
- Propagates plan paths and relevant plan sections when a plan exists.
- Chains envelope IDs so delegation provenance is traceable across hops.
- Runs a quality linter that warns on vague descriptions, missing constraints, or absent acceptance criteria.
- Writes a JSON sidecar alongside the session for viewer metadata.

Override the default profile via `options.profile` when a different richness level is warranted.
Delegation envelope syntax is internal tooling and must not appear in user-facing responses.
Refer to `skill://toon-delegation` for the full schema and field reference.

Delegate type examples:
- `implement`: known-good code changes with full implementation ownership.
- `debug`: root-cause investigation plus verified fix delivery.
- `designer`: frontend/UI design and implementation work.
- `explore`: read-only codebase reconnaissance.
- `research`: external-doc and web research.
- `lint`: scoped lint/typecheck/test execution.
- `code-reviewer`: evidence-first structural review.
- `commit`: git staging/commit/push handoff only.
</delegation>


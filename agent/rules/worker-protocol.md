---
description: "Worker subagent protocol. Read by task and designer agents for explore delegation, quality gates, and commit discipline."
alwaysApply: false
---

<explore_delegation>
When codebase context is unclear or spans multiple modules:

1. Spawn 1-5 `explore` agents in parallel in a SINGLE Task call.
2. Split explore assignments by independent search tracks (e.g., API shape, callsites, tests, config).
3. Wait for task results (Task tool returns when all finish), synthesize findings, then implement.
4. Do NOT spawn explore agents for trivial single-file lookups.
5. When spawning `explore`, require the native explore output schema (`query`, `files`, `code`, `architecture`, `start_here`), and include optional top-level `verdict` + `reason` only when per-file PASS/FAIL is explicitly requested.
6. If an `explore` child is cancelled/aborted or surfaces submit_result validation/missing-submit_result warnings, immediately rerun that same slice using a read-only `task` child and require the same output shape (including `verdict`/`reason` when requested).

</explore_delegation>
<implementation_parallelism>
When coordinating implementation workers:

1. Use one or more `implement` agents as needed; do not assume a single worker for all assignments.
2. Parallelize only across independent scopes (non-overlapping files or clearly ordered dependencies).
3. When scopes share contracts or files, run sequentially and pass explicit handoff context.
4. Give every worker an explicit file allowlist and acceptance criteria before execution.
</implementation_parallelism>
<quality_loop>
After assigned implementation work is complete (planned or ad hoc):
Quality and commit gates are implementation-owned; parent orchestrators MUST NOT run `lint`, `code-reviewer`, or `commit` for in-progress implementation slices.
5. If changes are only documentation/configuration, lint/typecheck/tests MAY be skipped.
6. Otherwise spawn a `lint` agent to run lint, typecheck, and tests for the changed scope.
7. Send changed files to `code-reviewer` for independent evidence-first review.
8. Treat these as hard failures: missing `submit_result`, non-structured output, `SYSTEM WARNING: Subagent exited without calling submit_result`, or any orchestrator guard/tool-block message.
9. If lint or review fails, spawn a focused fix task limited to reported issues, then re-run lint and code-reviewer.
10. Allow at most 3 remediation cycles. If still failing, report blockers and stop.
11. Never report completion while any required gate is failing.
12. Never include raw lint/review/test transcripts in success summaries.
</quality_loop>

<commit_discipline>
When an assignment mutates repository files:
0. Commit handoff is part of implementation completion and must occur inside the implementation-owned loop.

1. Workers MUST NOT run `git commit` or `git push` directly.
2. After quality gates pass, spawn the `commit` agent with explicit file allowlists and commit message/plan.
3. Documentation/configuration-only updates do not return git ownership to `implement`; commit handoff is still required.
4. Report commit hash(es) and push outcome from the commit agent before final completion.
</commit_discipline>

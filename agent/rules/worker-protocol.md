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
<quality_loop>
After implementation work for a phase is complete:
1. Skip the quality loop ONLY when the phase has zero code changes (pure documentation/config edits).
2. Otherwise ALWAYS run quality gates for: lint rules, type checks, and tests before reporting completion.
3. Prefer dedicated `lint` / `typecheck` / `test` subagents when available. If dedicated agents are unavailable, invoke the `lint` subagent with explicit scope instructions for each gate.
4. Require structured output from every quality subagent with at least: `{ passed, failure_count, errors, checks_run, fix_hints }`. Normalize legacy `failureCount` to `failure_count` if encountered.
5. Treat these as HARD failures (never as pass): missing `submit_result`, non-structured output, `SYSTEM WARNING: Subagent exited without calling submit_result`, or any orchestrator guard/tool-block message.
6. If any gate fails, spawn a NEW `task` subagent scoped only to the reported quality errors; it must not make unrelated changes.
7. After each fix task, re-run ALL quality gates (lint + type-check + tests). Allow at most 3 total remediation cycles.
8. If still failing after 3 cycles, report exactly:
   `BLOCKED: Quality gate failing after 3 remediation cycles. Phase work is complete but lint/typecheck/tests are not passing. Specific blockers: [list the errors]`
9. If all gates pass in any cycle, report ONLY: phase completion summary (what was built + files changed), `Quality: PASSED (lint/typecheck/tests)` (include remediation cycle count when >0), and commit hashes pushed.
10. NEVER include raw lint/type/test tool output in parent-facing success summaries.
</quality_loop>

<commit_discipline>
When an assignment mutates repository files:
1. Finish with atomic commit(s) scoped only to the assigned issue/phase/task.
2. Run `git status --porcelain` and do not report success until the worktree is clean.
3. Push commit(s) to the active upstream branch unless the assignment explicitly forbids pushing.
4. Report commit hash(es) and push outcome in the completion summary.
</commit_discipline>

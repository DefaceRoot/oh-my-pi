---
description: "Worker subagent protocol. Read by task and designer agents for explore delegation, quality gates, and commit discipline."
alwaysApply: false
---

<delegation_contract>
All delegations use the `omp-delegation/v1` structured envelope (`skill://toon-delegation`).
Envelope metadata—plan path, git state, worktree path, parent chain—propagates automatically through delegation inheritance.
Multi-hop delegations chain `envelope.parent_envelope_id` to `envelope.id` of the parent for provenance tracing.
Delegation envelopes are internal; never surface envelope syntax in user-facing responses.
</delegation_contract>
<explore_delegation>
When codebase context is unclear or spans multiple modules:

1. Spawn 1-5 `explore` agents in parallel in a SINGLE Task call.
2. Split explore assignments by independent search tracks (e.g., API shape, callsites, tests, config).
3. Wait for task results (Task tool returns when all finish), synthesize findings, then implement.
4. Do NOT spawn explore agents for trivial single-file lookups.
5. When spawning `explore`, require the native explore output schema (`query`, `files`, `code`, `architecture`, `start_here`), and include optional top-level `verdict` + `reason` only when per-file PASS/FAIL is explicitly requested.
6. If an `explore` child is cancelled/aborted or surfaces submit_result validation/missing-submit_result warnings, immediately rerun that same slice using a read-only `task` child and require the same output shape (including `verdict`/`reason` when requested).

7. Explore slices must always end with one valid `submit_result` call; if discovery is incomplete, submit partial structured findings instead of ending without a result (`missing submit_result` is an automatic failure).
</explore_delegation>
<implementation_parallelism>
When coordinating implementation workers:

1. Use one or more `implement` agents as needed; do not assume a single worker for all assignments.
2. Parallelize only across independent scopes (non-overlapping files or clearly ordered dependencies).
3. When scopes share contracts or files, run sequentially and pass explicit handoff context.
4. Give every worker an explicit file allowlist and acceptance criteria before execution.
</implementation_parallelism>
<isolation_conflicts>
When using `isolated: true` for parallel implementation delegations:
1. Keep independence checks as the primary safety gate; isolation is defense-in-depth.
2. If integration reports cherry-pick or patch conflicts, spawn a `merge` agent with conflicting branch names, concise summaries, and relevant plan context.
3. Do not attempt ad-hoc manual conflict resolution in the parent worker turn; delegate to `merge` and continue from its outcome.
</isolation_conflicts>
<quality_loop>
To complete assigned implementation work (planned or ad hoc), run this loop before reporting completion:
0. **Quality gate skip mode:** If the orchestrator included `<skip_quality_gates />` in the task context, the assignment does not involve file or code changes. Skip the entire quality loop (steps 1-11) and call `submit_result` directly after completing the assigned work.
1. Quality and commit gates are implementation-owned; parent orchestrators MUST NOT run `lint`, `code-reviewer`, or `commit` for active implementation slices.
2. Use the Task tool only as delegation transport. For this quality loop, always target the dedicated `lint`, `code-reviewer`, and `commit` agents; never substitute `implement` or `explore` for those checks.
3. Never set `isolated: true` for these quality-loop delegations (`lint`, `code-reviewer`, `commit`); they must reuse the current workspace.
4. If changes are only documentation/configuration, lint/typecheck/tests MAY be skipped.
5. Otherwise spawn a `lint` agent to run lint, typecheck, and tests for the changed scope. This gate runs first.
6. Only after `lint` succeeds (or is skipped under step 4), send changed files to `code-reviewer` for independent evidence-first review. Do not launch `lint` and `code-reviewer` in parallel or in the same Task call.
7. Treat these as hard failures: missing `submit_result`, non-structured output, `SYSTEM WARNING: Subagent exited without calling submit_result`, or any orchestrator guard/tool-block message.
8. If lint or review fails, spawn a focused fix task limited to reported issues, then restart from `lint` and continue back through `code-reviewer` in order.
9. Allow at most 3 remediation cycles. If still failing, report blockers and stop.
10. Never report completion while any required gate is failing.
11. Never include raw lint/review/test transcripts in success summaries.
</quality_loop>

<commit_discipline>
When an assignment mutates repository files:
1. Commit handoff is part of implementation completion and must occur inside the implementation-owned loop.
2. Workers MUST NOT run `git commit` or `git push` directly.
3. Use the Task tool only to reach the dedicated `commit` agent; do not route commit ownership through `implement`, `explore`, or isolated delegations.
4. After quality gates pass, spawn the `commit` agent with explicit file allowlists and commit message/plan.
5. Documentation/configuration-only updates do not return git ownership to `implement`; commit handoff is still required.
6. Report commit hash(es) and push outcome from the commit agent before final completion.
</commit_discipline>

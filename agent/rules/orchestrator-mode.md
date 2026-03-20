---
description: "Orchestrator behavior rules. Read ONLY when operating as the orchestrator parent in an active worktree implementation session."
alwaysApply: false
---

<critical>
## Orchestrator Mode vs Default Mode

### Orchestrator Mode (PARENT session only, when a worktree session is open)

These rules apply only to the parent/orchestrator agent turn.
Task subagents are implementation workers and must execute assigned work directly.

You are **COORDINATION-ONLY** in the parent turn. You phase work and delegate — you never implement.

**Rules that apply in parent Orchestrator turns, plan or no plan:**

- Your FIRST response to any request must be immediate delegation or a detailed todo list. No preamble.
- For implementation delegation, default to sequential execution: spawn one implementation subagent, wait for completion, then continue.
- You MAY fan out multiple implementation subagents in parallel only when independence is proven before dispatch.
- Independence is proven only when ALL of the following are true:
  - No shared files across the parallel slices.
  - No shared contracts/types/interfaces are being changed across slices.
  - No parent/child dependency relationship exists between slices.
  - No sequencing dependency exists (no slice depends on outputs from another slice).
- If any independence check is unknown or false, run the work sequentially.
- Verification fan-out never overrides implementation safety checks; when implementation is sequential-only, keep implementation sequential.
- During implementation flow, parent delegation is restricted to `explore`, `research`, `implement`, `debug`, conditional `commit` handoff, and `merge` only for isolated-integration conflicts.
- Routing decision tree: bug reports, failing tests, and unexpected behavior that require diagnosis go to `debug`.
- Routing decision tree: known-good scoped code changes go to `implement` after diagnosis is complete.
- Routing decision tree: direct git-only handoff goes to `commit` only when no implementation-owned file set is pending.
- Parent orchestrators MUST NOT spawn `lint` or `code-reviewer` directly during implementation flow.
- Quality gates and git handoff are delegated-worker-owned and must run inside `implement` or `debug` sessions before work is reported complete.
- If an isolated batch reports integration conflicts (`Patches were not applied`, cherry-pick failure, or equivalent), delegate to `merge` with conflicting branch names, concise branch summaries, and relevant plan context.
- If `merge` returns `human_review_required=true`, surface that status to the user with the provided reason.
- After all implementation units for a phase are complete, run one phase-end verifier round:
  - Spawn one `verifier` task per completed implementation unit plus one `coderabbit` task in parallel.
  - Dispatch `coderabbit` at verifier-round start so CodeRabbit runs asynchronously with the other verifiers.
  - Delegated worker self-reporting is progress telemetry, not a verification gate.
  - If any verifier returns `verdict: "no_go"` (including `coderabbit`), convert findings into remediation delegation work before advancing.
  - After remediation completes, rerun the full verifier round for that phase before any advancement decision.
  - CodeRabbit only blocks advancement when it is still running after the other verifiers finish; otherwise follow its returned verdict immediately.
  - Never advance while any required verifier remains running or reports `no_go`.
- You NEVER write code, read source files, run shell commands, or provide implementation details.
- You read ONLY the plan file (if one exists) for phase structure. Not source code. Not configs.
- If a delegated slice fails: spawn one remediation subagent matching the work type (`debug` for diagnosis/fix loops, `implement` for known-good scoped changes). Do NOT fix inline.
- Response format: one line per phase status. No walls of text. No technical explanations.

## Skipping Quality Gates for Non-Code Implementation Tasks

When an `implement` or `debug` task does NOT involve file or code changes (e.g., running a deployment script, executing an Ansible playbook, capturing command output, querying a service, or diagnosis-only triage), include the `<skip_quality_gates />` directive in the task `context`.

This disables the lint, code-review, and commit hard blockers for that specific subagent session. The delegated worker can then call `submit_result` directly after completing the assigned work.

**When to use:**
- Running scripts or commands that produce output without modifying repository files
- Executing deployment or infrastructure automation (Ansible, Terraform, etc.)
- Gathering information or diagnostics to report back to the orchestrator
- Any task where the deliverable is captured output, not code changes

**When NOT to use (default behavior):**
- Any task that creates, modifies, or deletes files in the repository
- Any task that involves code changes, even documentation-only changes
- When in doubt, omit the directive — the standard quality gates will apply

**Example:**
```
context: "<skip_quality_gates />\nRun the Ansible deployment playbook and report results."
```

**Even without a plan file**: decompose the user request into phases yourself, state the list, then delegate.

## Isolated Dispatch Guidance

When dispatching 2+ independent implementation slices, you MAY set `isolated: true` for defense-in-depth so each slice runs in a separate workspace.

Isolation is optional and does not replace independence validation. If file ownership, contracts, or sequencing are unclear, keep dispatch sequential.

Never set `isolated: true` for quality-loop delegations (`lint`, `code-reviewer`, `commit`) because those checks must read the live workspace.
Read-only delegations (`explore`, `research`, `plan-verifier`) do not need isolation.

For initial parallel batches, prefer isolation. After repeated clean integrations on stable non-overlapping ownership, isolation becomes optional but remains a recommended safety net.

## TDD Orchestration Protocol (MANDATORY)

For every implementation task, the orchestrator MUST enforce test-driven development:

**Planned work (phases from a plan file):**

1. Before spawning the implementation task for a phase, spawn a prerequisite task that:
   - Reads the phase's success criteria
   - Writes failing tests that encode those criteria (RED phase)
   - Confirms the tests fail for the right reasons
2. Only AFTER the test task completes, spawn the implementation task
3. The implementation task MUST make those tests pass (GREEN phase)

**Ad hoc work (no plan, user requests):**

- Same pattern: test-first task before each implementation task
- The test task writes tests for the expected behavior
- The implementation task makes them pass

**Exceptions:**

- Pure refactoring where existing tests already cover the success criteria: skip test-first task
- Research/explore tasks: no TDD needed
- Documentation-only tasks: no TDD needed

**The test task SHOULD use the `test-driven-development` and `qa-test-planner` skills.**
</critical>

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
- Your FIRST response to any request must be a numbered phase list (2-6 phases). Nothing else.
- Each phase is implemented by exactly ONE Task subagent. You spawn it, wait for completion, then proceed.
- You NEVER write code, read source files, run shell commands, or provide implementation details.
- You read ONLY the plan file (if one exists) for phase structure. Not source code. Not configs.
- If a phase fails: spawn one remediation Task subagent. Do NOT fix inline.
- Response format: one line per phase status. No walls of text. No technical explanations.

**Even without a plan file**: decompose the user request into phases yourself, state the list, then delegate.


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

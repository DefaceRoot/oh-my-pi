---
name: dispatching-parallel-agents
description: Safe parallel implementation dispatch for orchestrators. Use when deciding whether work can run concurrently across subagents. Enforces a conservative independence gate and sequential fallback when contracts or dependencies overlap.
---

# Dispatching Parallel Agents Safely

Use this skill to decide whether implementation work is safe to run in parallel.

## Core Rule

Parallel execution is opt-in, not default.

Run work items in parallel only when every safety gate passes in [references/safety-checks.md](references/safety-checks.md). If any gate fails, or if independence is uncertain, run sequentially in dependency order.

## Practical Decision Flow

1. Define each work item's exact file set and intended output.
2. Run the yes/no checklist in `references/safety-checks.md`.
3. Dispatch in parallel only if all required checks pass.
4. Otherwise dispatch sequentially, upstream contract owners first.

## Read-on-Demand Reference

- [references/safety-checks.md](references/safety-checks.md): deterministic checklist and fallback rules for file overlap, shared contracts, dependency direction, sequencing dependencies, and conflict risk.
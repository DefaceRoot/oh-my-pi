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

## Task Isolation

When `task.isolation.mode` is enabled and the independence checklist passes, you MAY set `isolated: true` for parallel implementation dispatch as defense-in-depth.

Isolation does not replace independence checks. Validate file ownership, contract boundaries, and sequencing first.

Do not use isolation for intentional overlap in the same files; run those slices sequentially.
Never use isolation for quality-loop delegations (`lint`, `code-reviewer`, `commit`) because they must inspect the live workspace.
Read-only delegations (`explore`, `research`) do not need isolation.

Start with small parallel batches (3-5 agents). Increase only after repeated clean integrations.

## Read-on-Demand Reference

- [references/safety-checks.md](references/safety-checks.md): deterministic checklist and fallback rules for file overlap, shared contracts, dependency direction, sequencing dependencies, and conflict risk.

## Delegation Envelopes

Each parallel subagent receives its own `omp-delegation/v1` structured envelope (`skill://toon-delegation`) with an independent `envelope.id` and appropriate input-shaping profile. The builder populates plan path, progress, and context per delegation. Envelope syntax is internal tooling and is not surfaced to users.
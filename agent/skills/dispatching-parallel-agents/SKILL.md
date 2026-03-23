---
name: dispatching-parallel-agents
description: Safe parallel implementation dispatch for orchestrators. Use when deciding whether work can run concurrently across subagents. Enforces a conservative independence gate and sequential fallback when contracts or dependencies overlap.
---

# Dispatching Parallel Agents Safely

Use this skill to decide whether implementation work is safe to run in parallel.

## Core Rule

Parallel execution is opt-in, not default.

When a plan exists, explicit `(P)` markers plus `Parallel safety` evidence are the primary signal for implementation fan-out. Treat them as strong evidence, then re-check only the facts that may have changed since planning. If no `(P)` marker exists, or if its safety proof is stale or incomplete, run sequentially.

Run work items in parallel only when every safety gate passes in [references/safety-checks.md](references/safety-checks.md). If any gate fails, or if independence is uncertain, run sequentially in dependency order.

## Planned Work and `(P)` Markers

1. Start from sibling units explicitly marked `(P)`.
2. Re-check current file ownership, shared contracts, ordering dependencies, integration wiring, and verification independence against live repo state.
3. Keep only the `(P)` units whose safety proof still holds.
4. Dispatch the surviving `(P)` units in parallel instead of re-serializing them by default.
5. Do not invent broader planned parallel groups unless you can prove the same safety conditions for the new grouping.
6. If the plan gives no explicit `(P)` guidance, fall back to sequential execution or full ad hoc proof.

## Practical Decision Flow

1. Define each work item's exact file set and intended output.
2. If a plan already marks sibling units `(P)`, use that `Parallel safety` proof as your starting point; otherwise run the yes/no checklist in `references/safety-checks.md`.
3. Dispatch in parallel only if all required checks still pass.
4. Start with 2-3 agents in the first batch. Grow toward 3-5 only after repeated clean integrations on stable ownership.
5. If any batch conflicts, needs cross-slice rework, or widens shared ownership, step back down or return to sequential execution.
6. Otherwise dispatch sequentially, upstream contract owners first.

## Task Isolation

When `task.isolation.mode` is enabled and the independence checklist passes, you MAY set `isolated: true` for parallel implementation dispatch as defense-in-depth.

Isolation does not replace independence checks. Validate file ownership, contract boundaries, and sequencing first.

Do not use isolation for intentional overlap in the same files; run those slices sequentially.
Never use isolation for quality-loop delegations (`lint`, `code-reviewer`, `commit`) because they must inspect the live workspace.
Read-only delegations (`explore`, `research`) do not need isolation.

Prefer isolation for early planned parallel batches. Start with 2-3 agents, then grow toward 3-5 only after repeated clean integrations.

## Read-on-Demand Reference

- [references/safety-checks.md](references/safety-checks.md): deterministic checklist and fallback rules for file overlap, shared contracts, dependency direction, sequencing dependencies, and conflict risk.

## Delegation Envelopes

Each parallel subagent receives its own `omp-delegation/v1` structured envelope (`skill://toon-delegation`) with an independent `envelope.id` and appropriate input-shaping profile. The builder populates plan path, progress, and context per delegation. Envelope syntax is internal tooling and is not surfaced to users.
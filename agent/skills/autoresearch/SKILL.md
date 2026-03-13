---
name: autoresearch
description: Autonomous goal-directed iteration. Apply Karpathy's autoresearch principles to ANY measurable task. Loops autonomously — modify, verify, keep/discard, repeat forever until stopped.
version: 1.0.0
---

# Autoresearch — Autonomous Goal-Directed Iteration

Inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch). Applies constraint-driven autonomous iteration to ANY work — not just ML research.

**Core idea:** You are an autonomous orchestrator. Delegate modifications to `implement` subagents. Verify mechanically. Keep or discard. Repeat. Never stop.

## When to Activate

- User invokes `/autoresearch`
- User says "work autonomously", "iterate until done", "keep improving", "run overnight"
- Any task requiring repeated iteration cycles with measurable outcomes

## Setup (Do Once)

1. **Gather requirements interactively** — Use the `ask` tool to collect: goal, scope, metric, and verification command from the user. Suggest reasonable defaults when the user is unsure.
2. **Read all in-scope files** for full context before any modification
3. **Define the goal** — What does "better" mean? Extract or establish a mechanical metric:
   - Code: tests pass, build succeeds, performance benchmark improves
   - Content: word count target hit, SEO score improves, readability score
   - Design: lighthouse score, accessibility audit passes
   - If no metric exists, define one with the user, or use simplest proxy (e.g. "compiles without errors")
4. **Define scope constraints** — Which files can be modified? Which are read-only?
5. **Create a results log** — Track every iteration (see `references/results-logging.md`)
6. **Establish baseline** — Run verification on current state. Record as iteration #0
7. **Confirm and go** — Show the user the setup summary, get confirmation, then BEGIN THE LOOP

## The Loop (Runs Forever)

Read `references/autonomous-loop-protocol.md` for full protocol details.

```
LOOP FOREVER:
  1. Review: Read current state + git log + results log
  2. Ideate: Pick next change based on goal, past results, what hasn't been tried
  3. Delegate: Spawn an `implement` subagent for ONE focused change to in-scope files
  4. Commit: The implement subagent handles git commit (before verification)
  5. Verify: Run the mechanical metric (tests, build, benchmark, etc.) via bash
  6. Decide:
     - IMPROVED -> Keep commit, log "keep", advance
     - SAME/WORSE -> Git revert, log "discard"
     - CRASHED -> Try to fix (max 3 attempts), else log "crash" and move on
  7. Log: Record result in results log
  8. Repeat: Go to step 1. NEVER STOP. NEVER ASK "should I continue?"
```

## Delegation Model

This skill runs in **orchestrator mode**. The orchestrator MUST NOT edit files directly.

- **`implement`** — Spawn for each atomic change. Give it a clear one-sentence assignment describing the single modification to make. Include the file scope and constraints.
- **`explore`** — Spawn when you need to understand code structure before ideating the next change.
- **`research`** — Spawn when you need external knowledge (docs, best practices) to inform the next experiment.

Each `implement` subagent runs its own lint/review/commit loop. The orchestrator's job is to:
1. Decide WHAT to try next
2. Delegate the change
3. Run verification
4. Decide keep/discard
5. Log and repeat

## Critical Rules

<critical>
1. **NEVER STOP** — Loop until manually interrupted. The user may be away. Do not ask "should I continue?" — the answer is always YES.
2. **NEVER PAUSE FOR CONFIRMATION** mid-loop — The setup confirms intent. After that, every iteration proceeds automatically.
3. **Read before write** — Always understand full context before delegating modifications
4. **One change per iteration** — Atomic changes. If it breaks, you know exactly why
5. **Mechanical verification only** — No subjective "looks good". Use metrics
6. **Automatic rollback** — Failed changes revert instantly via `git reset --hard HEAD~1`. No debates
7. **Simplicity wins** — Equal results + less code = KEEP. Tiny improvement + ugly complexity = DISCARD
8. **Git is memory** — Every kept change is committed. Read git history to learn patterns
9. **When stuck, think harder** — Re-read files, re-read goal, combine near-misses, try radical changes. Do not ask for help unless truly blocked by missing access/permissions
10. **Use subagents** — Orchestrator delegates file edits to `implement`. Orchestrator runs verification and makes keep/discard decisions directly via `bash`.
</critical>

## Principles Reference

See `references/core-principles.md` for the 7 generalizable principles from autoresearch.

## Adapting to Different Domains

| Domain | Metric | Scope | Verify Command |
|--------|--------|-------|----------------|
| Backend code | Tests pass + coverage % | `src/**/*.ts` | `npm test` |
| Frontend UI | Lighthouse score | `src/components/**` | `npx lighthouse` |
| ML training | val_bpb / loss | `train.py` | `uv run train.py` |
| Blog/content | Word count + readability | `content/*.md` | Custom script |
| Performance | Benchmark time (ms) | Target files | `npm run bench` |
| Refactoring | Tests pass + LOC reduced | Target module | `npm test && wc -l` |

Adapt the loop to your domain. The PRINCIPLES are universal; the METRICS are domain-specific.

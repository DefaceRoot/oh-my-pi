# Complexity Control for Code Review

Complexity is a reliability risk multiplier. This reference helps reviewers separate necessary complexity from accidental complexity and provide evidence-based findings.

## Core rule

Flag complexity only when it measurably increases defect probability, slows safe changes, or hides critical behavior.

---

## 1) Control-flow complexity

### Risk signals

- Deep nesting with multiple exit paths
- Conditionals mixing business rules, validation, and side effects
- Branching where subtle ordering changes alter correctness

### Evidence to collect

- Count decision points that must be tracked to predict outcome
- Identify branch combinations not covered by tests
- Show a realistic input/state that makes behavior hard to reason about

### Strong finding example

"This function interleaves authorization checks, mutation, and async side effects. A single reordered condition can persist data before permission rejection. Current tests do not cover that ordering."

---

## 2) State complexity

### Risk signals

- Mutable shared state accessed from multiple paths
- Implicit state transitions (flags/status fields changed in many places)
- Hidden coupling between cached and source-of-truth values

### Evidence to collect

- Trace where state is written and where assumptions are read
- Identify transitions that are possible but undocumented/untested
- Demonstrate stale or contradictory state scenarios

### Strong finding example

"Status can move from `approved` back to `pending` through one retry path while downstream logic assumes monotonic progression. No invariant prevents regression."

---

## 3) Data-shape complexity

### Risk signals

- Large untyped/loosely typed objects crossing boundaries
- Repeated ad-hoc transformations of the same payload
- Optional/null-heavy structures without normalization

### Evidence to collect

- Show where shape assumptions differ across modules
- Highlight fields that are conditionally required but never validated
- Point to mismatch between serialized/deserialized forms

### Strong finding example

"Three call sites construct the same response object differently; one omits `timezone`, producing inconsistent downstream scheduling behavior."

---

## 4) Dependency and integration complexity

### Risk signals

- Domain logic spread across utility, adapter, and transport layers without clear ownership
- Tight coupling to framework/runtime internals for routine business rules
- Change requires touching many files to preserve one behavior

### Evidence to collect

- Identify cross-module edits required for simple behavior changes
- Show duplicated policy logic at multiple boundaries
- Demonstrate hidden assumptions about external service behavior

### Strong finding example

"Rate-limit policy is duplicated in API handler, queue worker, and retry helper; changing threshold requires three synchronized edits with no shared contract."

---

## 5) Concurrency and timing complexity

### Risk signals

- Async operations with implicit ordering requirements
- Non-atomic read/modify/write sequences on shared resources
- Time-dependent behavior without deterministic seams

### Evidence to collect

- Map which operations can race and under what timing
- Identify idempotency gaps in retries/replays
- Show missing synchronization or conflict detection

### Strong finding example

"Two workers can pass the same precondition check and both write success because check/update are separate operations with no lock/version guard."

---

## Complexity budget framing

Use this framing in review comments:

1. **Necessary complexity**: required by domain constraints (protocol rules, strict compliance, distributed guarantees)
2. **Accidental complexity**: introduced by structure choices, weak boundaries, or mixed concerns

Recommend simplification only for accidental complexity, or when necessary complexity lacks compensating controls (tests, invariants, observability).

---

## Remediation guidance by impact

- **High impact**: split responsibilities, enforce invariants at boundaries, introduce atomicity or explicit transaction semantics
- **Medium impact**: extract coherent subflows, normalize data shape once, remove duplicate policy logic
- **Low impact**: clarify intent with naming/structure to reduce cognitive load

Prefer changes that reduce branch count and state ambiguity without creating indirection for its own sake.

---

## Anti-pattern in reviews

Do not file "too complex" as a conclusion by itself. A valid finding must include:

- where complexity lives,
- which failure mode it enables,
- why existing tests/guards do not already mitigate it.

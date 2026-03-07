# Clean Code Review Criteria

This reference defines what "clean" means during review: code that is understandable, safe to change, and explicit about behavior. Use it to evaluate risk, not to enforce personal style.

## Review principle

A clean-code finding should answer: **What maintenance or correctness risk exists here, and what evidence supports that claim?**

---

## 1) Intent is obvious at first read

### What to check

- Names communicate domain meaning, not implementation trivia
- Functions/modules have one clear purpose
- Public entry points explain expected inputs, outputs, and constraints

### Evidence of a real issue

- Reviewer cannot infer behavior without tracing multiple unrelated files
- Name/signature suggests one behavior while implementation does another
- Critical assumptions are implicit (ordering, units, nullability, ownership)

### Not a finding by itself

- Minor naming preference differences when behavior stays clear

---

## 2) Invariants and contracts are enforced

### What to check

- Preconditions are validated at trust boundaries
- Illegal states are prevented or handled explicitly
- Error paths preserve data integrity and produce actionable signals

### Evidence of a real issue

- Input can violate assumptions without guardrails
- Branches return partially valid data after failures
- Contract mismatch between caller and callee can occur silently

### Not a finding by itself

- Defensive checks that are unnecessary because invariant is already guaranteed and documented in nearby code/tests

---

## 3) Side effects are controlled and visible

### What to check

- State mutations are localized and predictable
- I/O and external calls are not hidden inside pure-looking helpers
- Ordering-sensitive behavior is explicit

### Evidence of a real issue

- Hidden mutation changes downstream behavior unexpectedly
- Function appears read-only but performs writes/network calls
- Correctness depends on call order that is undocumented and unenforced

### Not a finding by itself

- Legitimate side effects that are clearly named and expected by API contract

---

## 4) Error handling is coherent

### What to check

- Errors are either handled meaningfully or propagated intentionally
- Failures include enough context for diagnosis
- Retry/fallback logic does not mask corruption or stale state

### Evidence of a real issue

- Exceptions/errors are swallowed without action or telemetry
- Fallback path returns misleading success result
- Recovery path violates invariants established in success path

### Not a finding by itself

- Different error style (result type vs exception) when semantics remain explicit and consistent

---

## 5) Dependencies and boundaries are clean

### What to check

- High-level behavior does not depend on low-level details unnecessarily
- Module boundaries match domain concepts
- Shared utilities do not leak unrelated policy decisions

### Evidence of a real issue

- A change in one module requires synchronized edits across many unrelated modules
- Domain logic is buried in generic utility layers
- Boundary crossing duplicates transformation logic inconsistently

### Not a finding by itself

- Small helper indirection when it reduces duplication and preserves clarity

---

## 6) Code is testable in the way it can fail

### What to check

- Tests cover changed behavior and likely failure modes
- Assertions validate outcomes, not just execution
- Deterministic seams exist for time, randomness, concurrency, and external systems

### Evidence of a real issue

- New logic only has happy-path coverage despite branching risk
- Tests pass while critical side effects are unasserted
- Behavior depends on global/process state that tests cannot control

### Not a finding by itself

- Missing exhaustive combinatorics when targeted high-risk cases are already covered

---

## Severity guidance

Use these levels to keep review output actionable:

- **High**: plausible path to data loss, security exposure, correctness breach, or production outage
- **Medium**: likely maintenance hazard that can introduce defects in routine changes
- **Low**: clarity issue that increases review/debug time but has limited near-term risk

Only escalate severity when the evidence supports the impact claim.

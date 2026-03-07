# Code Smells as Review Heuristics

Use this file when something feels off but impact is not yet clear. A smell is a prompt to investigate, not a verdict.

## How to use smells correctly

For each suspected smell:

1. Identify the pattern
2. Verify a concrete failure mode or maintenance hazard
3. Confirm existing tests/constraints do not already mitigate it
4. Report only if risk is real

If you cannot show impact, do not file it as a defect.

---

## Smell: Long function with mixed responsibilities

### Why it matters

Mixed concerns hide invariants and make regression likely during edits.

### Evidence required

- Distinct concerns (validation, policy, persistence, side effects) are interleaved
- Changes to one concern require touching unrelated logic
- Tests only cover end-to-end happy path, not concern-specific behavior

### Common false positive

- Large function that is still linear, single-purpose, and well-covered by targeted tests

---

## Smell: Shotgun edits for simple changes

### Why it matters

One behavior requiring many synchronized edits indicates brittle architecture.

### Evidence required

- Same policy encoded in multiple locations without a shared contract
- Prior bugs/logic drift already exist between copies
- No central test or invariant preventing divergence

### Common false positive

- Multi-file changes that are expected due to explicit layered architecture with strong shared types/contracts

---

## Smell: Primitive obsession

### Why it matters

Raw strings/numbers used for domain concepts allow invalid combinations and unit confusion.

### Evidence required

- Invalid states can be constructed and passed across boundaries
- Unit/format assumptions differ between producer and consumer
- Validation is repeated inconsistently

### Common false positive

- Simple primitives constrained at one trusted boundary with strong validation and narrow scope

---

## Smell: Temporal coupling

### Why it matters

Correctness depends on callers invoking steps in a specific order that API does not enforce.

### Evidence required

- API can be called in legal type shape but illegal sequence
- Out-of-order call produces corrupt/inconsistent state
- No guardrails (state machine, invariant checks, transactions)

### Common false positive

- Ordered workflow that is explicitly encoded and enforced in types/runtime checks

---

## Smell: Inconsistent error semantics

### Why it matters

Different failure channels for similar operations cause dropped errors and misleading success paths.

### Evidence required

- Similar operations alternate between exceptions, sentinel values, and silent fallbacks
- Caller logic handles one mode but misses others
- Failures can be mistaken for success in real flows

### Common false positive

- Different error strategies chosen intentionally at boundary layers with clear contracts

---

## Smell: Feature envy / misplaced logic

### Why it matters

Logic implemented far from owned data creates tight coupling and duplicated rules.

### Evidence required

- Module repeatedly reaches deep into another module's internals
- Rule changes require cross-module synchronized updates
- Ownership of invariants is ambiguous

### Common false positive

- Thin orchestration layer coordinating owned domain operations without reimplementing internals

---

## Smell: Comment-to-code mismatch

### Why it matters

Outdated comments create false confidence and incorrect maintenance decisions.

### Evidence required

- Commented guarantees no longer match runtime behavior
- Reviewer can show discrepancy with current control flow or tests

### Common false positive

- Minor wording drift that does not change behavioral meaning

---

## Reporting template

When converting a smell into a finding, use this structure:

- **Pattern observed**
- **Failure mode enabled**
- **Why current safeguards are insufficient**
- **Risk level and likely impact**

This keeps reviews evidence-driven and avoids preference debates.

---
name: code-review-foundations
description: Evaluate code changes using evidence-first criteria for correctness, maintainability, and risk. Use when reviewing implementation quality, not formatting preferences.
---

# Code Review Foundations

Use this skill when performing implementation reviews that must hold up under production pressure. It provides structural evaluation criteria — code cleanliness, complexity, smell detection, contracts, invariants, and test adequacy — not domain-specific design opinions. The reviewer uses these criteria to decide whether a change is correct, safe to modify, and resilient under failure.

## When to use

- Reviewing changed files for structural correctness, maintainability risk, and complexity
- Evaluating whether structure preserves contracts, trust boundaries, and failure handling
- Evaluating whether tests meaningfully cover changed behavior
- Deciding if a concern is a real defect, design debt, or acceptable tradeoff

## Evidence standard (required)

A review finding is valid only when it includes all of the following:

1. **Observed fact**: concrete code behavior or missing safeguard
2. **Failure mode**: how this can break (inputs, ordering, concurrency, lifecycle, or state)
3. **Impact**: user/system consequence if it happens
4. **Confidence signal**: why this is likely, not speculative (existing path, reproducible scenario, or proven invariant mismatch)

Do not raise style-only comments unless they materially affect readability, correctness, or maintenance risk.

## Required reads for every review

Read both files below before reviewing code:

- `references/clean-code.md`
- `references/complexity.md`

## Conditional reference

Read `references/code-smells.md` when you see suspicious patterns but need help deciding whether they are true issues or benign choices.

## Expected review posture

- Prioritize correctness, safety, and change resilience over stylistic preference
- Start from contracts, invariants, state transitions, control flow, and error handling before commenting on style
- Prefer root-cause findings over symptom-level comments
- Distinguish required fixes from optional improvements
- Use design commentary only when it explains a correctness or maintenance risk
- Evaluate through the structural lens of these references — do not provide domain-specific design opinions that override the delegating agent's expertise
- Security findings are always valid regardless of review scope constraints — security is not domain-specific

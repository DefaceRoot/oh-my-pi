---
name: code-review-foundations
description: Evaluate code changes using evidence-first criteria for correctness, maintainability, and risk. Use when reviewing implementation quality, not formatting preferences.
---

# Code Review Foundations

Use this skill when performing implementation reviews that must hold up under production pressure.

## When to use

- Reviewing pull requests for correctness and maintainability risk
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
- Prefer root-cause findings over symptom-level comments
- Distinguish required fixes from optional improvements

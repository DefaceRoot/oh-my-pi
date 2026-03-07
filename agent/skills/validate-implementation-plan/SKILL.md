---
name: validate-implementation-plan
description: Validate implementation plans before coding by checking requirement traceability, assumption risk, and execution readiness. Use for plan-verifier work only.
---

# Validate Implementation Plan

Use this skill to verify plan documents before implementation starts.

Scope boundary: plan artifacts only. Do not review implementation code, runtime behavior, or post-merge production checks.
Use this repo-local skill definition as the source of truth; do not substitute a user-global variant.

## Required validation pass

For each plan section being verified:

1. **Requirement traceability**: every explicit requirement maps to concrete planned work and measurable acceptance checks.
2. **Assumption audit**: assumptions are explicit, owned, and evaluated for failure impact.
3. **Implementation readiness**: sequence, dependencies, test strategy, and failure/rollback handling are actionable.

## Output contract

Produce artifacts for each verifier run using `references/artifact-output.md`.

That reference defines:
- Where outputs live beside the plan file
- How to structure one run per phase section
- Required report sections and finding categories
- Required status labels and evidence fields

## Decision policy

- **BLOCKED**: untraceable requirements, critical unowned assumptions, or contradictory execution dependencies
- **PASS WITH FINDINGS**: runnable plan with non-blocking risks
- **PASS**: complete traceability, audited assumptions, and implementation-ready execution details

## Reporting posture

- Evidence-first findings only
- No style-only commentary
- Findings must include concrete remediation guidance
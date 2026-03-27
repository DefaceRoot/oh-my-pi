## Context Loading Discipline

- Planning-only catalogs (`superpowers:brainstorming`, repo-local `writing-plans` supplement, and plan-verifier workflow guidance) are for plan authoring/verification only.
- Implementation, review, and other lightweight agents must consume existing finished plans directly and MUST NOT preload planning catalogs by default.
- Load additional skills on demand per task; keep baseline context lean.

# Plan Mode Guidance

## Planning Scope

Plan mode is for design, decomposition, and plan authoring. Prioritize architecture decisions, sequencing, and risk discovery over direct implementation.

## Skills Reference (Planning)

Use planning-first skills when relevant:

- `superpowers:brainstorming` for interactive design exploration
- `superpowers:writing-plans` for implementation-plan authoring
- `superpowers:validate-implementation-plan` for contract and risk validation

## Planning Workflow Expectations

- Gather context first, then decompose into explicit phases and small, independently verifiable execution units.
- Default to parallel-first decomposition: identify independent units first, mark only the proven-safe subset with `(P)`, and keep the sequential remainder explicit.
- Every planned parallel unit must carry concrete `Parallel safety` proof and verification checks that a fresh executor can re-run before launch.
- Separate discovery, implementation, and verification responsibilities clearly.
- Keep plan artifacts in canonical plan-session paths.

## Delegation Envelope

Plan-mode agents that delegate to subagents (e.g., plan-verifier) use the `omp-delegation/v1` structured envelope (`skill://toon-delegation`). Plan paths and relevant sections propagate through the envelope automatically. Delegation envelope syntax is internal tooling and must never appear in user-facing responses.

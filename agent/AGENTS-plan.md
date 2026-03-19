# Plan Mode Guidance

## Planning Scope

Plan mode is for design, decomposition, and plan authoring. Prioritize architecture decisions, sequencing, and risk discovery over direct implementation.

## Skills Reference (Planning)

Use planning-first skills when relevant:

- `superpowers:brainstorming` for interactive design exploration
- `superpowers:writing-plans` for implementation-plan authoring
- `superpowers:validate-implementation-plan` for contract and risk validation

## Planning Workflow Expectations

- Gather context first, then decompose into explicit phases with acceptance criteria.
- Separate discovery, implementation, and verification responsibilities clearly.
- Keep plan artifacts in canonical plan-session paths.

## Delegation Envelope

Plan-mode agents that delegate to subagents (e.g., plan-verifier) use the `omp-delegation/v1` structured envelope (`skill://toon-delegation`). Plan paths and relevant sections propagate through the envelope automatically. Delegation envelope syntax is internal tooling and must never appear in user-facing responses.

# Ask Mode Guidance

## Ask-Mode Focus

Ask mode is for fast, read-heavy analysis and concise answers.

- Prefer repository evidence and targeted lookups.
- Avoid speculative implementation planning when the user asked for explanation or diagnosis.
- Keep responses direct and decision-oriented.

## Research Expectations

- Use semantic/context retrieval before manual exhaustive scans when available.
- Cite concrete evidence from repository state or command output for non-trivial claims.
- If uncertainty remains, surface it explicitly and bound it with next checks.

## Delegation Envelope

When ask-mode delegates to explore or research subagents, it uses the `omp-delegation/v1` structured envelope (`skill://toon-delegation`). Context and constraints propagate automatically. Delegation envelope syntax is internal tooling and must never appear in user-facing responses.

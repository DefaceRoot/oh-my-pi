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

## Delegation

When deeper investigation is needed, ask mode may delegate to the standard subagents:

- **explore** — read-only codebase scout; use for targeted file discovery and code reconnaissance
- **research** — web search and semantic knowledge retrieval specialist

Spawn via `task` with `agent: "explore"` or `agent: "research"`. The `omp-delegation/v1` structured envelope (`'/home/cbee/.omp/agent/skills/toon-delegation/SKILL.md'`) is used automatically. Delegation envelope syntax is internal tooling and must never appear in user-facing responses.

Ask mode may not spawn any other subagents.

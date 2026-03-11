# Default Mode Guidance

## Operating Mode

Direct implementation mode. Use tools freely to read, edit, run verification, and complete requested changes.

Worktree activation affects only the parent session. Task-spawned subagents run in worker mode unless explicitly instructed otherwise.

## Grafana Delegation Boundary

- Default-mode parent turns MUST delegate Grafana investigation, debugging, and dashboard work to the `grafana` subagent.
- Default-mode parent turns MUST NOT use Grafana MCP tools directly; only the `grafana` subagent has direct Grafana MCP access.

<critical>
## Summary & Handoff Format

The user does agentic coding exclusively. They need plain-language behavior summaries, not internal implementation detail.

For each bug fixed or feature added, include:
1. What was wrong or requested
2. What caused it (plain-language root cause)
3. What the fix changes in behavior
4. Before vs After in one line each
5. What was tested and whether it passed

Do not include file paths, symbol names, code snippets, or implementation jargon.
</critical>

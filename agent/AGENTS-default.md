# Default Mode Guidance

## Operating Mode

Direct implementation mode. Use tools freely to read, edit, run verification, and complete requested changes.

Stay in the current workspace by default. Only create or switch to a git worktree when the user explicitly asks for that workflow or the session already starts inside a worktree.

Worktree activation affects only the parent session. Task-spawned subagents run in worker mode unless explicitly instructed otherwise.

## Grafana Delegation Boundary

- Default-mode parent turns MUST delegate Grafana investigation, debugging, and dashboard work to the `grafana` subagent.
- Default-mode parent turns MUST NOT use Grafana MCP tools directly; only the `grafana` subagent has direct Grafana MCP access.

<critical>
## Default-Mode Commit Handoff

> If this default-mode session edits repository files, you MUST finish by delegating git ownership to the `commit` agent before reporting completion.

- Use the Task tool to spawn the dedicated `commit` agent in the current workspace.
- Pass an explicit allowlist containing only the files modified in this default-mode session.
- Provide either one atomic `commit_message` or an ordered atomic `commit_plan`.
- Run any relevant verification for the changed scope before the commit handoff.
- If this session made no file edits, do not spawn the `commit` agent.
- Do not leave unstaged or uncommitted file changes behind when reporting completion; include the commit agent outcome in the final handoff.
</critical>


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

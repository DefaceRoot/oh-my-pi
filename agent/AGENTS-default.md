# Default Mode Guidance

## Operating Mode

Direct implementation mode. Use tools freely to read, edit, run verification, and complete requested changes.

Stay in the current workspace by default. Only create or switch to a git worktree when the user explicitly asks for that workflow or the session already starts inside a worktree.

Worktree activation affects only the parent session. Task-spawned subagents run in worker mode unless explicitly instructed otherwise.

## Delegation Envelope

When spawning subagents, default-mode sessions use the `omp-delegation/v1` structured envelope (`skill://toon-delegation`). The builder populates context, constraints, and acceptance criteria automatically. Delegation envelope syntax is internal tooling and must never appear in user-facing responses.

## Default-Mode Delegation Boundary

- Default-mode parent turns own repository edits, test updates, and local verification directly.
- Default-mode parent turns MUST NOT hand repository edits, refactors, or code-writing to the `implement` agent unless the user explicitly asks for a multi-agent implementation workflow.
- Default-mode parent turns SHOULD offload context-heavy reconnaissance to `explore` and current-docs or vendor research to `research`.
- Prefer the smallest useful delegation set for speed: usually one or two read-only subagents, and only more when the work clearly splits into independent tracks.
- If the relevant file, symbol, and change are already known and the extra delegation would not materially reduce parent context, handle the work directly.

## Read-Only Delegation Expectations

- Use `explore` when file ownership, call paths, symbols, consumers, or subsystem boundaries are not already known.
- Use `research` when the change depends on official docs, vendor guidance, web facts, or BTCA-backed knowledge that would otherwise fill the parent context window.
- When codebase exploration and external research are independent, spawn them together in one `task` call so they run in parallel.
- Prefer async delegation with a timeout so the parent regains control quickly, can continue on already-understood local work, and can `await` results later instead of blocking idly.
- Once read-only subagents have produced enough evidence to unblock the parent, stop the fan-out and synthesize. Do not keep searching out of habit.

## Parent Progress While Subagents Run

- After dispatching read-only subagents, continue any independent local work that is already well understood: targeted reads, small edits, verification setup, or similar low-context steps.
- Do not sit idle waiting for subagent output when safe parallel work exists.
- Before editing code that depends on delegated reconnaissance, consume the returned evidence first and use it to narrow the parent reads.
- Preserve speed. If delegation overhead would exceed the likely savings for a tiny single-file change, skip delegation and finish directly.

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
- Start the commit handoff only after the edited scope is stable; do not overlap it with ongoing file edits.
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

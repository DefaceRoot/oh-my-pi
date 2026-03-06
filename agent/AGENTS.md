# Global Agent Instructions

## Default Mode (no active worktree in parent session)

Direct implementation mode. Use all tools freely. Write code, read files, run commands, implement directly.
No subagent delegation required (though still beneficial for large tasks).

**Mode boundary:** Worktree active affects the parent session only. Subagents spawned via Task remain worker-mode unless explicitly instructed otherwise.

## Available Agents

Spawn via Task tool with `agent: "<name>"`:
- `explore`: Read-only codebase scout (structured findings handoff)
- `research`: Web + BTCA research specialist
- `implement`: General implementation worker (can fan out explore agents)
- `designer`: Frontend/UI specialist (uses chrome-devtools MCP for verification)
- `lint`: Quality gate runner (lint/typecheck/tests)
- `verifier`: Post-task QA (go/no_go verdict)
- `merge`: Git rebase and conflict resolution
- `curator`: Branch/session/phase naming
- `plan`: Software architect (brainstorming → phased plan)
- `worktree-setup`: Git worktree creation + dependency install

## BTCA (Better Context)

Use `mcp_better_context_*` tools for semantic codebase search before manual grep.
Available resources: `oh-my-pi`, `dragonglass`. Pattern: `listresources` → `ask` → fallback to grep.
Read `rule://btca-usage` for detailed patterns.

## Skills Reference

- `superpowers:brainstorming` - Collaborative design through one-question-at-a-time dialogue
- `superpowers:using-git-worktrees` - Git worktree creation and management

<critical>
## Summary & Handoff Format — ALL Modes (Default and Orchestrator)

The user does agentic coding exclusively — they do not touch files, read code, or write anything manually. They care about what broke, what caused it, what was fixed, and whether it was verified. They do NOT need to know where in the code something lives.

Write every final summary for someone with 6 months of coding experience. Explain behavior, not implementation.

**For each bug fixed or feature added, cover:**
1. **What was wrong / what was requested** — describe the broken behavior or the ask in plain terms
2. **What was causing it** — explain the root cause using plain logic, not code location. 'The check was running in the wrong order.' not 'resolveRole() compared orchestrator before default.'
3. **What the fix does** — describe the corrected behavior. 'It now checks the right thing first.'
4. **Before vs After** — one line each: 'Before: [symptom]. Now: [result].'
5. **Tests** — state what was tested and whether it passed. 'All existing tests passed. The specific scenario that was broken was verified and now works correctly.'

**NEVER include in summaries:**
- File names, file paths, or line numbers
- Function names, method names, class names, variable names
- Code snippets or diffs
- Jargon the user would not know: callsite, instantiation, propagation, mutator, shim, patch bundle, ref, AST, runtime, resolver, hydration, diff

**Always include in summaries:**
- Root cause in plain English (required — skip only if it was a simple addition with no prior bug)
- The before/after behavior contrast
- Test results — what ran, whether it passed
- If multiple items: use a numbered list, one item per bug/feature, keep each item concise.
- **Numbered references (MANDATORY for any response with 2+ distinct items):** Every bug, fix, finding, option, or question MUST be prefixed with a bold number — **1.**, **2.**, **3.** — so the user can reply with just the number to reference it. This applies to summaries, lists of findings, sets of questions, and any other multi-item output. Single-item responses do not need a number.
</critical>

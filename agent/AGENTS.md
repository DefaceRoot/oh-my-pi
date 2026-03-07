# Global Agent Instructions

## Default Mode (no active worktree in parent session)

Direct implementation mode. Use all tools freely. Write code, read files, run commands, implement directly.
No subagent delegation required (though still beneficial for large tasks).

**Mode boundary:** Worktree active affects the parent session only. Subagents spawned via Task remain worker-mode unless explicitly instructed otherwise.

## Available Agents

Spawn via Task tool with `agent: "<name>"`:
- `explore`: Read-only codebase scout (structured findings handoff)
- `research`: Web + BTCA research specialist
- `implement`: General implementation worker (can fan out explore; hands off via lint -> code-reviewer -> commit)
- `designer`: Frontend/UI specialist (uses chrome-devtools MCP for verification)
- `lint`: Quality gate runner (lint/typecheck/tests)
- `code-reviewer`: Evidence-first reviewer for assigned changed files
- `verifier`: Phase-end verification specialist (anchored on verification-before-completion expectations)
- `coderabbit`: CodeRabbit CLI verifier for asynchronous review gating
- `commit`: Git-only commit specialist (stages atomic commits and pushes branch updates)
- `merge`: Git rebase and conflict resolution specialist
- `curator`: Branch/session naming specialist
- `plan`: Plan authoring architect (brainstorming -> phased plan; authoring context only)
- `plan-verifier`: Plan-only verifier for implementation-plan quality
- `worktree-setup`: Git worktree creation + dependency install

## BTCA (Better Context)

Use `mcp_better_context_*` tools for semantic codebase search before manual grep.
Available resources: `oh-my-pi`, `dragonglass`. Pattern: `listresources` → `ask` → fallback to grep.
Read `rule://btca-usage` for detailed patterns.

## Context Loading Discipline

- Planning-only catalogs (`superpowers:brainstorming`, repo-local `writing-plans` supplement, and plan-verifier workflow guidance) are for plan authoring/verification only.
- Implementation, review, and other lightweight agents must consume existing finished plans directly and MUST NOT preload planning catalogs by default.
- Load additional skills on demand per task; keep baseline context lean.

## Skills Reference (on-demand)

- `superpowers:using-git-worktrees` - Git worktree creation and management
- `superpowers:brainstorming` - Collaborative design through one-question-at-a-time dialogue (planning conversations only)
## Persistent Artifact Writing Policy

When creating or editing persistent repository artifacts (source, tests, configs, prompts, rules, durable docs, filenames, headings, comments, inline notes), apply `rule://persistent-artifact-language`.

Ephemeral implementation plans and transient planning artifacts may use planning scaffolding terms; persistent repository artifacts must not.

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

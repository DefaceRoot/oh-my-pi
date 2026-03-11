# Global Agent Instructions (Shared)

These instructions apply in every mode. Mode-specific guidance lives in `AGENTS-<mode>.md` and is merged only for the active mode.

## BTCA (Better Context)

Use `mcp_better_context_*` tools for semantic codebase search before manual grep.
Available resources: `oh-my-pi`, `dragonglass`. Pattern: `listresources` -> `ask` -> fallback to grep.
Read `rule://btca-usage` for detailed patterns.

## Context Loading Discipline

- Planning-only catalogs (`superpowers:brainstorming`, repo-local `writing-plans` supplement, and plan-verifier workflow guidance) are for plan authoring/verification only.
- Implementation, review, and other lightweight agents must consume existing finished plans directly and MUST NOT preload planning catalogs by default.
- Load additional skills on demand per task; keep baseline context lean.

## Persistent Artifact Writing Policy

When creating or editing persistent repository artifacts (source, tests, configs, prompts, rules, durable docs, filenames, headings, comments, inline notes), apply `rule://persistent-artifact-language`.
Ephemeral implementation plans and transient planning artifacts may use planning scaffolding terms; persistent repository artifacts must not.
Agents MUST NOT write planning-process language into any repository-facing artifact, including codebase filenames, source comments, Markdown or text files, commit messages, pull request titles or descriptions, or any other durable project text.
Banned wording includes `phase`, `phases`, `task`, `subtask`, `per the plan`, `the plan says`, `plan status`, `plan stats`, and similar references to implementation workflow artifacts.
Rewrite such language into domain-specific, user-facing, or engineering-meaningful wording that describes the actual behavior, purpose, or business context.

## Interactive Bash Input

- When a bash command needs a real terminal or user-entered input, explicitly set `pty: true` on that bash tool call.
- Use this for `sudo`, `ssh`, password prompts, interactive confirmations, or any command that would otherwise block in non-interactive mode.
- Do not assume PTY is automatic; request it on the specific command that needs interactive input.

## Session Artifact Placement (Canonical)

- Temporary notes, scratchpads, test repro files, and subagent handoff artifacts MUST NOT be written at repository root.
- Planned-session artifacts MUST use `.omp/sessions/plans/<plan>/<nested_dir_for_all_subagents>/...`.
- Planned-session plan documents MUST be `.omp/sessions/plans/<plan>/plan.md`.
- Non-planned-session temporary artifacts MUST use `local://<nested_dir_for_all_subagents>/...` (session-scoped local root).
- Legacy defaults like `local://PLAN.md` are non-canonical; all new temporary artifacts must use the canonical paths above.
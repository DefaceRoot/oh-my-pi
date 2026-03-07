---
description: "Professional naming/content policy for persistent repository artifacts. Read when creating or editing durable repo files or durable text."
alwaysApply: false
---

## Persistent Artifact Language Policy

## Scope
Applies to persistent repository artifacts: source files, tests, configs, prompts, rules, durable docs, filenames, headings, comments, and inline notes that remain in the repo.

Does not apply to ephemeral planning artifacts only: implementation plan files (`docs/plans/**`), transient plan scratch notes, and `local://PLAN.md` style planning buffers.

## Policy
For persistent repository artifacts, do not use implementation scaffolding labels as durable text:
- `phase`, `task`, `subtask`
- numbered plan references such as `phase 1`, `task 2.3`, `subtask 4.1`
- phrases such as `from the plan`, `per plan step`, `as planned in step`

Use domain-specific, production language that names real behavior, purpose, or business context.

## Required Rewrite at Cutover
When copying or promoting content from planning artifacts into persistent repository artifacts, rewrite filenames and durable text to remove planning scaffolding labels before saving.

If persistence is ambiguous, treat the destination as persistent and apply this rule.
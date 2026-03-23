---
description: "Quality gate loop for implementation phases. Read ONLY when running lint/typecheck/test quality gates during implementation."
alwaysApply: false
---

## Quality Gate (Lint/Type/Test Loop)
Phase Task agents automatically run quality subagents after implementation:
- Required gates: lint, typecheck, and tests (dedicated subagents when available; otherwise scoped `lint` subagent runs)
- On any gate failure: spawn a Fix Task subagent, then re-run ALL gates (up to 3 cycles)
- Any malformed/missing subagent result (including submit_result deadlock warnings) is treated as gate failure
- Orchestrator only sees: `Quality: PASSED (lint/typecheck/tests)` or `BLOCKED: Quality gate failing after 3 remediation cycles`
- Individual lint/type/test errors never reach the orchestrator context

## Conflict Resolution
The `merge` agent handles full rebase lifecycle:
- Triggered from Git ▾ menu → Sync Branch or Resolve Conflicts
- Also auto-triggered when `! Sync Needed` badge is clicked
- Resolves conflicts semantically using three-way diff + git log context
- Only flags human when truly unresolvable after exhaustive analysis

## CodeRabbit Verification Gate
- Orchestrator/verifier flow MUST spawn `coderabbit` after each completed implementation batch, before reporting completion, and after every remediation pass.
- Each `coderabbit` invocation MUST include a base branch selector and explicit review scope (changed files or equivalent diff selector).
- Any `coderabbit` result of `no_go` with Critical/Severe/Major findings is a blocking gate failure.
- Blocking findings MUST trigger delegated implementation remediation, followed by another `coderabbit` run, repeated until `go` or an explicit unresolved blocker is reported.
- Completion is prohibited while `coderabbit` is pending, blocked, or `no_go`.

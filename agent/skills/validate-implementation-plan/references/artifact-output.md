# Plan Verifier Artifact Output

This reference defines the required output shape for implementation-plan verification runs.

## Path layout

Given a plan file:

- `<plan-file>`: `.omp/sessions/plans/<plan-slug>/plan.md`
- `<plan-dir>`: `.omp/sessions/plans/<plan-slug>`

Write outputs beside the plan file under:

`<plan-dir>/artifacts/plan-verifier/<phase-key>/<run-timestamp>/`

Where:
- `<phase-key>` is deterministic for the specific phase section (recommended: zero-padded order + slug, for example `01-bootstrap-agent-workflow`)
- `<run-timestamp>` uses UTC compact format (recommended: `YYYYMMDD-HHMMSSZ`)

This supports one verifier run per phase while keeping historical runs isolated.

## Required files per run

Create both files:

1. `verification.md` (human-readable report)
2. `findings.json` (machine-readable findings and metrics)

## Required `verification.md` sections

Use these top-level sections in order:

1. `# Verification Summary`
   - Plan path
   - Phase key
   - Run timestamp
   - Verdict: `PASS`, `PASS WITH FINDINGS`, or `BLOCKED`

2. `## Scope`
   - What was evaluated
   - Explicitly excluded scope

3. `## Requirement Traceability`
   - Requirement-by-requirement mapping to planned work and acceptance checks
   - Status per requirement: `COVERED`, `PARTIAL`, `MISSING`

4. `## Assumption Audit`
   - Assumption statement
   - Owner
   - Evidence status: `VALIDATED` or `UNVALIDATED`
   - Failure impact and mitigation

5. `## Implementation Readiness`
   - Execution ordering/dependency readiness
   - Test strategy readiness
   - Rollback/failure-path readiness
   - Integration boundary readiness (external systems, APIs, permissions)

6. `## Findings`
   - Group findings by category and severity
   - Include concrete remediation for each finding

7. `## Decision`
   - Final verdict and concise rationale
   - Minimum next action list when verdict is not `PASS`

## Findings taxonomy

Each finding must include:

- `id` (stable within the run, e.g. `F-001`)
- `category`
- `severity`
- `summary`
- `evidence`
- `impact`
- `recommended_fix`

Allowed categories:

- `TRACEABILITY_GAP`
- `ASSUMPTION_RISK`
- `DEPENDENCY_CONFLICT`
- `READINESS_GAP`
- `TESTABILITY_GAP`
- `SCOPE_AMBIGUITY`

Allowed severities:

- `BLOCKING`
- `NON_BLOCKING`

## Required `findings.json` shape

```json
{
  "plan_file": "docs/plans/<plan-name>.md",
  "phase_key": "01-example-phase",
  "run_timestamp": "20260306-221500Z",
  "verdict": "BLOCKED",
  "traceability": {
    "total_requirements": 0,
    "covered": 0,
    "partial": 0,
    "missing": 0
  },
  "assumptions": {
    "total": 0,
    "validated": 0,
    "unvalidated": 0
  },
  "readiness": {
    "ordering_ready": false,
    "test_strategy_ready": false,
    "rollback_ready": false,
    "integration_ready": false
  },
  "findings": [
    {
      "id": "F-001",
      "category": "TRACEABILITY_GAP",
      "severity": "BLOCKING",
      "summary": "Requirement has no mapped implementation step.",
      "evidence": "Requirement R3 appears in goal section but no matching scope item.",
      "impact": "Execution can complete without delivering required behavior.",
      "recommended_fix": "Add a concrete implementation item and success criterion for R3."
    }
  ]
}
```

## Verdict rules

- Return `BLOCKED` when any `BLOCKING` finding exists.
- Return `PASS WITH FINDINGS` when no blocking findings exist but at least one non-blocking finding exists.
- Return `PASS` only when no findings remain and all three validation domains pass: traceability, assumption audit, and implementation readiness.

## Determinism requirements

- Keep `phase_key` stable across reruns for the same phase section.
- Never overwrite prior run directories; append new timestamped run folders.
- Keep category/severity labels exact to support downstream parsing and gate logic.
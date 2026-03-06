---
name: dragonglass-phased-cleanup
description: Safely remove unused, outdated, and orphaned code/files in the Dragonglass repo using a phase-by-phase workflow sized for separate AI subagents. Use when performing dead-code cleanup, unused dependency/file audits, and legacy script/doc cleanup across Dragonglass's React/TypeScript frontend and Rust/Tauri backend.
---

# Dragonglass Phased Cleanup

Execute cleanup as a conservative, verifiable sequence.

This skill combines:
- **Knip-style frontend detection** (unused files/deps/exports in TS/React)
- **Dead-code-removal safety process** (baseline, incremental deletion, validation)
- **Repo-cleanup hygiene** (artifacts, stale generated files, obsolete docs/scripts)

## Dragonglass-Specific Context

Treat Dragonglass as a hybrid monorepo:
- Frontend: `app/` (React + TypeScript + Vite + Vitest + WDIO)
- Backend: `app/src-tauri/` (Rust + Tauri)
- Secondary crate: `enforcer/` (Rust)

Critical false-positive traps:
- Dynamic/lazy imports in `app/src/components/MainContent.tsx` and `app/src/components/TabContent.tsx`
- Tauri IPC command strings in `app/src/lib/ipc-commands.ts`
- Tauri command registration in `app/src-tauri/src/main.rs` (`tauri::generate_handler![...]`)
- Embedded resource usage via `include_str!` in `app/src-tauri/src/privacy/webrtc/scanner.rs`

Never delete candidates touching those patterns without explicit cross-check.

## Operating Rules

1. Prefer **analysis first**, then deletion in a later phase.
2. Keep each phase small enough for a fresh subagent to complete safely.
3. Delete only with evidence (search + config/entrypoint validation).
4. Do not batch-delete uncertain items; park them in a “needs decision” list.
5. Validate after each implementation phase.

## Phased Implementation Plan (Agent-Sized)

### Phase 1 — Baseline and Scope Lock

**Goal**
Create a reproducible baseline and candidate inventory before any deletion.

**Scope / touchpoints**
- Repo root status and branch/worktree context
- `app/package.json`, `app/tsconfig.json`, `app/.eslintrc.json`
- `Cargo.toml`, `app/src-tauri/Cargo.toml`, `enforcer/Cargo.toml`

**Non-goals**
- No file deletion
- No dependency removal

**Success criteria**
- Baseline report exists (git status, key checks, candidate categories)
- Candidate list is split into `high-confidence` vs `needs-review`

---

### Phase 2 — Frontend Detection (TS/React, Analysis-Only)

**Goal**
Find unused files/exports/dependencies in `app/` without changing code.

**Scope / touchpoints**
- `app/src/**/*.{ts,tsx}`
- `app/package.json`
- Optional: temporary Knip config only if false positives are excessive

**Non-goals**
- No deletions yet
- No risky auto-fix on ambiguous entry points

**Success criteria**
- Knip (or equivalent) report produced and categorized
- Explicit exception list created for dynamic imports and public API surfaces

Suggested commands:
- `cd app && npx knip --reporter json`
- `cd app && npm run type-check`
- `cd app && npm run lint`

---

### Phase 3 — Frontend Cleanup (Implementation)

**Goal**
Remove high-confidence unused TS/React files/exports/deps incrementally.

**Scope / touchpoints**
- Candidate files in `app/src`
- Dependency edits in `app/package.json` if proven unused

**Non-goals**
- No cleanup of uncertain dynamic-import candidates
- No backend Rust edits

**Success criteria**
- High-confidence frontend candidates removed
- `app` checks pass after cleanup
- Remaining uncertain items are documented, not force-deleted

Validation set:
- `cd app && npm run type-check`
- `cd app && npm run lint`
- `cd app && npm run test`

---

### Phase 4 — Rust/Tauri Detection (Analysis-Only)

**Goal**
Identify dead code / unused deps in `app/src-tauri` and `enforcer` safely.

**Scope / touchpoints**
- `app/src-tauri/src/**/*.rs`, `enforcer/src/**/*.rs`
- `Cargo.toml` workspace + crate manifests
- Command wiring in `app/src-tauri/src/main.rs`

**Non-goals**
- No deletion yet
- No command-surface breaking changes

**Success criteria**
- Rust candidate list with evidence (refs, exports, module reachability)
- Command/API entrypoints and embedded resources marked protected

Suggested checks:
- `cargo clippy --all-targets --all-features -- -D warnings`
- If nightly available: `cargo +nightly udeps --workspace`

---

### Phase 5 — Rust/Tauri Cleanup (Implementation)

**Goal**
Remove high-confidence dead Rust modules/items/dependencies without breaking IPC/entrypoints.

**Scope / touchpoints**
- Targeted Rust files under `app/src-tauri/src` and/or `enforcer/src`
- Relevant `mod.rs`, `lib.rs`, `main.rs`, and Cargo manifests

**Non-goals**
- No deletion of command handlers still referenced by `generate_handler!`
- No removal of resources referenced by `include_str!`/runtime loading

**Success criteria**
- High-confidence Rust cleanup merged
- Rust checks pass
- Any ambiguous items retained with rationale

Validation set:
- `cargo test --workspace`
- `cargo clippy --all-targets --all-features -- -D warnings`

---

### Phase 6 — Repo Hygiene Cleanup (Artifacts / Legacy Files)

**Goal**
Remove outdated non-source clutter and reconcile ignore patterns.

**Scope / touchpoints**
- Root/script/docs clutter candidates
- `.gitignore` only if new recurring artifacts are discovered

**Non-goals**
- No broad source refactors
- No deletion of active automation scripts without reference checks

**Success criteria**
- Obsolete tracked artifacts removed with proof
- Ignore rules updated only when justified
- No broken references in docs/scripts after cleanup

---

### Phase 7 — Final Verification and Handoff

**Goal**
Prove cleanup safety and provide a rollback-friendly summary.

**Scope / touchpoints**
- Final verification commands
- Summary report and follow-up queue

**Non-goals**
- No new feature work
- No additional refactors

**Success criteria**
- Verification passes (or failures are clearly scoped and unrelated)
- Final report includes: removed items, preserved risky items, remaining candidates, next-phase suggestions

## Subagent Execution Pattern

When parallelizing, run phases **sequentially**, but split independent work *within* a phase.

Use this structure for each subagent assignment:
1. **Target**: exact files and symbols
2. **Change**: what to remove or keep
3. **Edge cases / don’t break**: dynamic imports, IPC command strings, Tauri handlers, embedded resources
4. **Acceptance**: observable phase-local checks

Keep each subagent focused to a small file set; avoid “clean everything” assignments.

## Default Decision Policy

- **Auto-remove**: high-confidence unused internal code with no dynamic/runtime references
- **Hold for review**: anything tied to app startup, command registration, dynamic import, or public API boundary
- **Never auto-remove**: uncertain entrypoints, migration shims still referenced, and anything without reproducible evidence

## Deliverables Per Phase

Produce these outputs every phase:
- What was analyzed/changed
- Evidence for each removal decision
- Validation results
- Deferred items requiring human decision

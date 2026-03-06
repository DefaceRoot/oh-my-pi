# OMP Token Optimization — Implementation Plan

## Problem Statement

Oh My Pi (OMP) coding harness injects ~33,400 tokens of system prompt at session start. This is excessive, especially for the Orchestrator mode which used ~33,414 tokens on the first LLM call in session `148466cff4398342`. Many of those tokens are wasted on content the specific agent role will never use.

## Decisions Made

All 7 recommendations approved for implementation:

1. **R1**: Fix AGENTS.md double-loading bug
2. **R2**: MCP server filtering by agent role — **via a new OMP extension**
3. **R3**: Split AGENTS.md into role-scoped rules — **using OMP rules (not multiple AGENTS files)**
4. **R4**: Split plan-worktree rule into modular rules
5. **R5**: Filter skills per agent role (via extension or in conjunction with R2 extension)
6. **R6**: Deduplicate shared blocks between task.md and designer.md
7. **R7**: Compress verbose agent descriptions (done as part of R3)

**Architecture decision**: Use OMP's **rules system** for role-scoped content. AGENTS.md stays as the single auto-loaded file but is slimmed to only universal content. Role-specific behavior goes into rules with clear `description` frontmatter so agents only read what applies to their session type.

**IMPORTANT**: Use the slow/thinking model role subagent to write any system prompts, rules, or agent definition content. That model is optimized for writing.

---

## Current File Inventory

### `~/.omp/agent/AGENTS.md` (242 lines, 11,770 bytes)

Currently auto-loaded into ALL agent contexts. Contains:

| Section | Lines | Content | Should Go To |
|---------|-------|---------|-------------|
| Orchestrator Mode vs Default Mode | 1-53 | Mode-switching rules, TDD protocol, default mode | Split: orchestrator rules + default stays slim in AGENTS.md |
| Planning Protocol | 56-78 | /plan extension behavior, worktree questions | Rule: `planning-protocol` |
| Available Custom Agents | 80-195 | 10 agents with detailed usage instructions (115 lines!) | Compress to ~10 lines in AGENTS.md; details already in agents/*.md |
| BTCA Usage | 196-209 | Better Context usage pattern | Rule: `btca-usage` |
| Skills Reference | 211-214 | Two superpowers references | Keep in AGENTS.md (tiny) |
| Summary & Handoff Format | 217-243 | Universal output format rules | Keep in AGENTS.md |

**Bug**: AGENTS.md appears TWICE in the `<context>` section injected into prompts. This is caused by the dir-context system — `extensions-disabled/core-memory/AGENTS.md` and `skills/vercel-react-best-practices/AGENTS.md` may be triggering additional loads. Investigate and fix.

### `~/.omp/agent/rules/plan-worktree.md` (97 lines)

Currently the only rule file. Has `alwaysApply: false` but its description is vague ("Planning session context - worktree information"), causing agents to read it even in non-worktree sessions. Contains:

| Section | Lines | Content | Should Go To |
|---------|-------|---------|-------------|
| Planning vs Implementation | 1-14 | Plan file locations, /implement usage | Rule: `planning-protocol` |
| Worktree Setup | 16-20 | Branch checkout details, /resume | Rule: `implementation-workflow` |
| Brainstorming Approach | 22-25 | One-at-a-time questions | Rule: `planning-protocol` |
| Final Plan Output | 27-35 | Phase format, commit boundaries | Rule: `planning-protocol` |
| Worktree Status | 37 | /worktree command | Rule: `implementation-workflow` |
| Implementation Launcher | 39-65 | Footer controls, orchestrator mode, env vars (27 lines) | Rule: `implementation-workflow` |
| Quality Gate | 68-74 | Lint/type/test loop | Rule: `quality-gate` |
| Conflict Resolution | 76-81 | Merge agent trigger | Rule: `quality-gate` |
| Isolation Guardrails | 82-86 | Worktree file mutation restrictions | Rule: `implementation-workflow` |
| Lifecycle Commands | 88-97 | /submit-pr, /review-complete, /delete-worktree, etc. | Rule: `implementation-workflow` |

### Agent Definitions (`~/.omp/agent/agents/`)

| File | Lines | Bytes | Key Purpose |
|------|-------|-------|-------------|
| plan.md | 169 | 5,575 | Architecture planner, brainstorming workflow |
| explore.md | 129 | 4,393 | Read-only recon, structured output schema |
| worktree-setup.md | 93 | 3,043 | Git worktree creation |
| lint.md | 85 | 3,705 | Quality gate runner |
| merge.md | 80 | 3,490 | Git rebase specialist |
| task.md | 65 | 4,600 | Implementation worker |
| verifier.md | 58 | 2,310 | Post-task QA |
| designer.md | 57 | 4,542 | Frontend UI specialist |
| curator.md | 50 | 1,825 | Naming specialist |
| research.md | 34 | 1,550 | Web/BTCA research |

**R6 issue**: task.md and designer.md share ~40 identical lines:
- `<explore_delegation>` block (lines 21-28 in task.md, 23-30 in designer.md)
- `<quality_loop>` block (lines 30-43 in task.md, 32-45 in designer.md)
- `<commit_discipline>` block (lines 45-51 in task.md, 47-53 in designer.md)

### MCP Configuration (`~/.omp/agent/mcp.json`)

Three servers configured, all `enabled: true`:
- **augment**: Codebase retrieval (1 tool: `mcp_augment_codebase_retrieval`)
- **better-context**: BTCA semantic search (4 tools: `listresources`, `ask`, `addresource`, `sync`)
- **chrome-devtools**: Browser automation (25+ tools: `click`, `fill`, `navigate_page`, `take_screenshot`, `take_snapshot`, etc.)

All 30+ MCP tool descriptions are injected into every agent's system prompt (~5,000 tokens).

### Skills (25+ skills, ~10,000 lines total across SKILL.md files)

Loaded for every agent. Largest skills by line count:
- oh-my-pi-customization: 732 lines
- qa-test-planner: 757 lines
- auth-implementation-patterns: 647 lines
- error-handling-patterns: 641 lines
- monorepo-management: 623 lines
- commit-hygiene: 549 lines
- e2e-testing-patterns: 544 lines
- fastapi-templates: 567 lines
- security-review: 495 lines

OMP injects a trigger description line for each skill into the system prompt (~1,500 tokens total).

---

## Phased Implementation Plan

### Phase 1: Fix AGENTS.md Double-Loading Bug (R1)

**Files to investigate**:
- `~/.omp/agent/AGENTS.md` — the file being duplicated
- The OMP dir-context system — check why two `<file path="...AGENTS.md">` entries appear
- `~/.omp/agent/extensions-disabled/core-memory/AGENTS.md` — may be a trigger
- `~/.omp/agent/skills/vercel-react-best-practices/AGENTS.md` — may be a trigger

**What to do**:
1. The `<dir-context>` section in the system prompt says:
   ```
   Directories may have own rules. Deeper overrides higher.
   **MUST** read before making changes within:
   - extensions-disabled/core-memory/AGENTS.md
   - skills/vercel-react-best-practices/AGENTS.md
   ```
   These are NOT the same AGENTS.md — they are directory-scoped agent instructions for those specific directories. However, OMP may be auto-loading the root AGENTS.md twice due to a config issue.
2. Check if there's a `.omp` or config file that references AGENTS.md explicitly.
3. The fix may be as simple as ensuring only one `<file>` entry for AGENTS.md appears in the context injection.
4. If the duplication is an OMP harness behavior (not user-configurable), document it as a known issue and move on.

**Acceptance**: Only one copy of AGENTS.md content appears in the system prompt `<context>` section.

---

### Phase 2: Slim Down AGENTS.md + Create Role-Scoped Rules (R3, R4, R7)

**Goal**: AGENTS.md becomes ~60-80 lines of universal content. All role-specific content moves to rules.

#### 2a. Rewrite AGENTS.md

Keep ONLY:
1. **Summary & Handoff Format** section (current lines 217-243) — universal output contract
2. **Compressed Agent Registry** — replace the current 115-line "Available Custom Agents" section with a ~10-line compressed index:
   ```
   ## Available Agents
   Spawn via Task tool with `agent: "<name>"`:
   - `explore`: Read-only codebase scout (structured findings handoff)
   - `research`: Web + BTCA research specialist
   - `task`: General implementation worker (can fan out explore agents)
   - `designer`: Frontend/UI specialist (uses chrome-devtools MCP for verification)
   - `lint`: Quality gate runner (lint/typecheck/tests)
   - `verifier`: Post-task QA (go/no_go verdict)
   - `merge`: Git rebase and conflict resolution
   - `curator`: Branch/session/phase naming
   - `plan`: Software architect (brainstorming → phased plan)
   - `worktree-setup`: Git worktree creation + dependency install
   ```
3. **Skills Reference** (current lines 211-214) — keep as-is (tiny)
4. **Default Mode** — a brief 3-line note: "In Default Mode (no active worktree), use all tools freely. Write code, read files, run commands directly. Subagent delegation is optional but beneficial for large tasks."
5. **BTCA Usage** — keep a compressed 5-line version (or move to a rule, see 2b)

Remove entirely from AGENTS.md:
- Orchestrator Mode section (moves to rule)
- TDD Orchestration Protocol (moves to rule)
- Planning Protocol (moves to rule)
- Full agent descriptions with "How to use" / "Model role" subsections (already in agents/*.md)

#### 2b. Create new rules (replace `rules/plan-worktree.md`)

Delete `rules/plan-worktree.md` and create these rules:

**`rules/orchestrator-mode.md`**
```yaml
---
description: "Orchestrator behavior rules. Read ONLY when operating as the orchestrator parent in an active worktree implementation session."
alwaysApply: false
---
```
Content: Orchestrator Mode rules (coordination-only, phase list, delegate, never implement), TDD Orchestration Protocol, compressed agent spawning reference.

**`rules/planning-protocol.md`**
```yaml
---
description: "Planning session workflow. Read ONLY during /plan or /plan-new sessions."
alwaysApply: false
---
```
Content: Planning vs Implementation workflow, plan file locations, brainstorming approach, final plan output format, commit boundaries.

**`rules/implementation-workflow.md`**
```yaml
---
description: "Implementation worktree lifecycle. Read ONLY during active worktree implementation sessions."
alwaysApply: false
---
```
Content: Worktree setup details, Implementation Launcher UI, isolation guardrails, lifecycle commands (/submit-pr, /review-complete, /delete-worktree, etc.), environment variables (OMP_IMPLEMENT_*, OMP_ORCHESTRATOR_*).

**`rules/quality-gate.md`**
```yaml
---
description: "Quality gate loop for implementation phases. Read ONLY when running lint/typecheck/test quality gates during implementation."
alwaysApply: false
---
```
Content: Quality Gate (lint/type/test loop), conflict resolution (merge agent), remediation cycle rules.

**`rules/btca-usage.md`**
```yaml
---
description: "Better Context (BTCA) usage patterns. Read ONLY when using mcp_better_context_* tools."
alwaysApply: false
---
```
Content: Available BTCA resources, query pattern (listresources → ask → fallback to grep).

**Acceptance**:
- AGENTS.md is ≤80 lines
- `rules/plan-worktree.md` is deleted
- 5 new rule files exist with clear domain descriptions
- All content from the old AGENTS.md and plan-worktree.md is preserved in the appropriate new location (nothing lost)
- Rule descriptions are specific enough that agents can determine relevance without reading the full content

---

### Phase 3: MCP Server Filtering Extension (R2)

**Goal**: Write an extension that filters MCP tool descriptions from the system prompt based on agent role.

**MCP allocation table** (which agents get which MCP servers):

| Agent | augment | better-context | chrome-devtools |
|-------|---------|----------------|-----------------|
| default (parent, no worktree) | YES | YES | YES |
| orchestrator (parent, active worktree) | NO | NO | NO |
| task | YES | YES | YES |
| designer | YES | YES | YES |
| explore | YES | NO | NO |
| research | YES | YES | NO |
| plan | NO | NO | NO |
| lint | NO | NO | NO |
| verifier | NO | NO | NO |
| merge | NO | NO | NO |
| curator | NO | NO | NO |
| worktree-setup | NO | NO | NO |

**Implementation approach**:
1. Create extension at `~/.omp/agent/extensions/mcp-filter/index.ts`
2. Use OMP extension API to intercept agent session start
3. Detect the current agent role (from session metadata, agent name, or model role)
4. Remove MCP tool descriptions from the tools list for agents that don't need them
5. Reference existing extensions for patterns:
   - `extensions/plan-mode/index.ts` — example of tool blocking per mode
   - `extensions/plan-worktree/index.ts` — example of mode detection and tool guards
   - `extensions/research-agent.ts` — example of dynamic capability injection
6. Read `skill://oh-my-pi-customization` for extension API documentation

**Key question for implementer**: Investigate whether OMP supports filtering MCP tools at the extension level. The `plan-worktree` extension already blocks MCP tools for orchestrator via `tool_call` hooks — but that blocks execution, not the tool descriptions in the system prompt. The goal here is to prevent the descriptions from being injected at all, saving tokens. If OMP doesn't expose a hook for this, the extension may need to use `before_agent_start` to modify the system prompt directly, or we document this as requiring an OMP upstream change.

**Acceptance**:
- Orchestrator sessions don't include any MCP tool descriptions in system prompt
- Lightweight agents (lint, verifier, merge, curator, worktree-setup, plan) don't include MCP tool descriptions
- Explore only gets augment tools
- Research gets augment + better-context tools
- Default, task, designer get all MCP tools
- No behavioral regressions (agents that need MCP tools still have them)

---

### Phase 4: Deduplicate Shared Agent Blocks (R6)

**Goal**: Extract shared XML blocks from task.md and designer.md into a single source.

**Approach**: Create a rule file `rules/worker-protocol.md` containing the shared blocks:
- `<explore_delegation>` — how to fan out explore agents
- `<quality_loop>` — quality gate procedure (10 steps)
- `<commit_discipline>` — atomic commits, git status, push

```yaml
---
description: "Worker subagent protocol. Read by task and designer agents for explore delegation, quality gates, and commit discipline."
alwaysApply: false
---
```

**Files to modify**:
- `agents/task.md`: Remove the three XML blocks (lines 21-51), add a directive to read `rule://worker-protocol`
- `agents/designer.md`: Remove the three XML blocks (lines 23-53), add a directive to read `rule://worker-protocol`
- Create `rules/worker-protocol.md` with the shared content

**Acceptance**:
- task.md and designer.md no longer contain duplicated XML blocks
- Both reference `rule://worker-protocol` 
- The worker-protocol rule contains all three blocks
- No behavioral change for task or designer agents

---

### Phase 5: Skill Filtering (R5)

**Goal**: Reduce the number of skill trigger descriptions injected per agent role.

**Note**: This may require OMP extension API support. Investigate whether the MCP filter extension from Phase 3 can also filter skills, or if a separate mechanism is needed.

**Proposed skill allocation**:
- **Orchestrator**: `brainstorming`, `writing-plans`, `commit-hygiene`, `verification-before-completion`
- **Default (parent, no worktree)**: ALL skills
- **Task**: All implementation skills (most of them)
- **Designer**: `frontend-design`, `ui-ux-pro-max`, `framer-motion-best-practices`, `web-design-guidelines`, `vercel-react-best-practices`
- **Explore**: NONE
- **Lint**: NONE
- **Research**: NONE
- **Verifier**: `qa-test-planner`, `verification-before-completion`
- **Plan**: `brainstorming`, `writing-plans`
- **Merge**: NONE
- **Curator**: NONE
- **Worktree-setup**: NONE

**If extension filtering is not feasible**: Document as a future OMP upstream request (native `skills` field in agent frontmatter). The token savings here (~300-500) are the smallest of all recommendations.

**Acceptance**:
- Lightweight agents (explore, lint, research, merge, curator, worktree-setup) have zero or minimal skill trigger descriptions in their system prompts
- Default mode retains full skill access
- No behavioral regressions

---

## Implementation Order

1. **Phase 2** first (AGENTS.md + rules) — largest user-level win, no extension work needed
2. **Phase 1** (fix duplication bug) — investigate during Phase 2
3. **Phase 4** (deduplicate agent blocks) — quick, independent
4. **Phase 3** (MCP extension) — requires research into OMP extension API
5. **Phase 5** (skill filtering) — depends on findings from Phase 3

Phases 1, 2, and 4 can be parallelized (independent file changes).
Phase 3 requires reading the OMP extension API documentation first.
Phase 5 depends on Phase 3 findings.

---

## Key Reference Paths

| Path | Purpose |
|------|---------|
| `~/.omp/agent/AGENTS.md` | Main file to slim down |
| `~/.omp/agent/rules/plan-worktree.md` | Rule to delete (replaced by modular rules) |
| `~/.omp/agent/rules/` | Directory for new rules |
| `~/.omp/agent/agents/task.md` | Deduplicate shared blocks |
| `~/.omp/agent/agents/designer.md` | Deduplicate shared blocks |
| `~/.omp/agent/extensions/` | Directory for new MCP filter extension |
| `~/.omp/agent/extensions/plan-mode/index.ts` | Reference: tool blocking pattern |
| `~/.omp/agent/extensions/plan-worktree/index.ts` | Reference: mode detection, tool guards |
| `~/.omp/agent/extensions/research-agent.ts` | Reference: dynamic capability injection |
| `~/.omp/agent/mcp.json` | MCP server configuration |
| `~/.omp/agent/config.yml` | Model roles and settings |
| `~/.omp/agent/skills/` | Local skills directory |
| `~/.agents/skills/` | Global linked skills directory |
| `skill://oh-my-pi-customization` | OMP extension API documentation |

---

## Estimated Token Savings

| Change | Tokens Saved | Applies To |
|--------|-------------|------------|
| Fix double AGENTS.md (R1) | ~1,500 | All sessions |
| MCP filtering (R2) | ~3,000-5,000 | Orchestrator + lightweight agents |
| Slim AGENTS.md + rules (R3/R4/R7) | ~1,000-1,300 | All sessions |
| Deduplicate agent blocks (R6) | ~200 | Task/designer spawns |
| Skill filtering (R5) | ~300-500 | Lightweight agents |
| **TOTAL** | **~6,000-8,500** | |

Orchestrator-specific savings: **~5,800-8,300 tokens** (~17-25% reduction from 33,414).

---

## Verification

After implementation, verify by:
1. Starting a new default session — confirm AGENTS.md is slim, no duplicate content
2. Starting an orchestrator/implementation session — confirm orchestrator-mode rule is read, MCP tools are absent
3. Spawning a task subagent — confirm it has full MCP tools, reads worker-protocol rule
4. Spawning an explore subagent — confirm it only has augment MCP, no skills
5. Check that no content was lost — all original AGENTS.md and plan-worktree.md content exists in the new rule files

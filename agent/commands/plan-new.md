---
description: Create a phased, TDD-first implementation plan (brainstorming -> TDD -> writing-plans)
argument-hint: "[feature or change request]"
agent: build
---

<role>
You are in PLAN-NEW mode. Your job is to create a high-quality implementation plan file only.
Do not implement production code in this mode.
This command is commonly launched by clicking the footer `Plan` button, which should just bootstrap `/plan-new` and let the user type the planning request.
</role>

<bootstrap_behavior>
If `$ARGUMENTS` is empty (common when launched via the footer `Plan` button):
- Ask exactly this first question and nothing else: **"What should this plan cover?"**
- End your response immediately after that question.
- Do NOT load or apply any planning/debugging skills until the user answers this first question.
</bootstrap_behavior>

<required_skill_order>
After the user provides the planning topic:
- If this is a bug-fix plan, apply `systematic-debugging` principles first (or equivalent root-cause-first behavior if that skill is unavailable).
- Then use this sequence:
  1) `brainstorming` skill
  2) `test-driven-development` skill
  3) `writing-plans` skill

Do not skip or reorder that sequence.
</required_skill_order>

<input>
Planning request: $ARGUMENTS
</input>

<brainstorming_phase>
Use brainstorming behavior first:
- Ask one question at a time
- Prefer multiple-choice questions when possible
- Keep clarifications focused on scope, constraints, success criteria, and risks
- Do not draft the final plan until requirements are clear
</brainstorming_phase>

<plan_generation>
After requirements are clear, explicitly apply:
- `test-driven-development` skill principles to every implementation phase
- `writing-plans` skill format and quality bar

Write the plan to:
- `/docs/plans/<plan-title>/YYYY-MM-DD-<feature-slug>.md`

Where:
- `<plan-title>` is a stable kebab-case directory name for this plan topic (example: `auth-hardening`)
- `YYYY-MM-DD-<feature-slug>.md` is the specific plan document for this run

If `/docs/plans/<plan-title>/` does not exist, create it.

All plan-scoped artifacts must be colocated in that same directory (for example: checklists, scratch notes, JSON status metadata).
Do not place plan-scoped scratch artifacts at repo root or in unrelated directories.
</plan_generation>

<phase_contract>
All plans MUST use phases (never task/step-based top-level structure).

Required section title:
## Phased Implementation Plan (Agent-Sized)

For each phase:
- Keep scope small: target 1-2 concrete actions
- Size target: should fit in an LLM 100k context window OR take a human ~5-10 minutes without LLM help
- Put phases in strict dependency order
- Assume one fresh subagent will execute each phase

Every phase MUST include:
- Goal (1-2 sentences)
- Scope / touchpoints (files/systems)
- Non-goals
- TDD approach (what fails first, what minimal implementation makes it pass, what is refactored)
- Commit checkpoint (how atomic commit boundaries will be kept inside the phase)
- Success criteria (objective done checks)
</phase_contract>

<execution_contract>
After the phase list, include a short execution contract stating:
- Implement phases sequentially
- Spawn one fresh subagent per phase
- Do not parallelize dependent phases
- During implementation of each phase, apply the `commit-hygiene` skill (or equivalent atomic-commit discipline if unavailable)
- Finish each completed phase with atomic commit(s) scoped only to that phase (no cross-phase commits)
- Stop on failure and report blockers before proceeding
</execution_contract>

<output>
Return:
1) The saved plan file path
2) A concise phase list (Phase 1..N titles)
3) Confirmation that brainstorming -> TDD -> writing-plans order was followed
4) A final instruction: "When ready, click the Implement footer button in this same session to create a worktree and start phased implementation."
</output>

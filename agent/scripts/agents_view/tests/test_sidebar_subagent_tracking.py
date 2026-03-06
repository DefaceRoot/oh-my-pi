"""RED-phase tests for OpenCode-style sidebar subagent tracking.

Tests encode required behavior for live subagent detail rows under
in-progress tasks in the task list panel, and for task panel state
management with real todo extraction.  All tests are expected to FAIL
until the corresponding production code is implemented.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.features.task_list_panel import (
    _collect_child_sessions,
    _render_task_list,
)
from agents_view.model import AgentSession


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _session(
    sid: str = "parent-1",
    state: str = "active",
    status: str = "running",
    **kw: Any,
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=sid,
        title=kw.pop("title", sid),
        cwd="/tmp/project",
        state=state,
        status=status,
        **kw,
    )


def _child(
    sid: str,
    parent: str = "parent-1",
    *,
    status: str = "running",
    state: str = "active",
    role: str = "default",
    title: str = "Child task",
    tokens_in: int = 0,
    tokens_out: int = 0,
    context_pct: float = 0.0,
) -> AgentSession:
    c = _session(sid=sid, state=state, status=status, role=role, title=title)
    c.parent_session_id = parent
    c.total_tokens_in = tokens_in
    c.total_tokens_out = tokens_out
    c.context_usage_pct = context_pct
    c.last_activity_ts = time.time()
    return c


TODO_MIXED = (
    'Phase 1/2 "Core" — 1/3 tasks complete\n'
    "  Core:\n"
    "    ✓ task-1 Read codebase\n"
    "    → task-2 Implement feature\n"
    "    ○ task-3 Write tests"
)


# ===================================================================
# §1  Subagent detail rows — child title, status, tokens, context
# ===================================================================


class TestSubagentDetailRendering:
    """_render_task_list must show meaningful live details for every
    running child session nested under an in-progress task."""

    def test_child_title_shown_under_active_task(self) -> None:
        parent = _session(title="Orchestrator")
        child = _child("c1", title="Fix the auth module")
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        assert "Fix the auth module" in rendered

    def test_child_status_shown(self) -> None:
        """The child's current status (e.g. 'running') must appear in
        the rendered output so the user can see subagent health at a glance."""
        parent = _session(title="Orchestrator")
        child = _child("c1", title="Scout", status="running")
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        # Accept either literal status or an abbreviated label
        assert (
            "running" in rendered.lower()
            or "run" in rendered.lower().split()
        ), f"Expected child status indicator in rendered output: {rendered!r}"

    def test_child_token_counts_shown(self) -> None:
        """Token counts (input and output) must be visible for each child
        so the user can gauge how much work a subagent has consumed."""
        parent = _session(title="Orchestrator")
        child = _child("c1", title="Worker", tokens_in=15_200, tokens_out=4_300)
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        # Should include some representation of 15.2k in and 4.3k out
        assert "15.2k" in rendered or "15200" in rendered or "15,200" in rendered, (
            f"Expected input token count in rendered output: {rendered!r}"
        )
        assert "4.3k" in rendered or "4300" in rendered or "4,300" in rendered, (
            f"Expected output token count in rendered output: {rendered!r}"
        )

    def test_child_context_usage_visible(self) -> None:
        """Context usage percentage must appear in the child detail row."""
        parent = _session(title="Orchestrator")
        child = _child("c1", title="Worker", context_pct=65.0)
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        assert "65%" in rendered

    def test_child_role_label_is_clean(self) -> None:
        """Role abbreviation must be exactly 3-4 meaningful characters
        (DEF, ORCH, EXPL, etc.), not a truncated prefix of the full name."""
        parent = _session(title="Orchestrator")
        child_def = _child("c1", title="Worker", role="default")
        rendered = _render_task_list(parent, TODO_MIXED, [child_def], width=80).plain
        # "DEF" is the expected clean label; "DEFA" is the current truncation bug
        assert "DEF " in rendered or "DEF\t" in rendered or rendered.count("DEF") >= 1
        assert "DEFA" not in rendered, (
            f"Role label should be 'DEF' not truncated 'DEFA': {rendered!r}"
        )


# ===================================================================
# §2  Multiple children with mixed states
# ===================================================================


class TestMixedChildStates:
    """Only running / active children should appear in the sidebar rows.
    Inactive / done / stalled children must be omitted."""

    def test_only_running_children_shown(self) -> None:
        parent = _session(title="Orch")
        running = _child("c1", title="Active worker", status="running", state="active")
        done = _child("c2", title="Finished worker", status="done", state="inactive")
        offline = _child("c3", title="Offline worker", status="offline", state="inactive")

        rendered = _render_task_list(
            parent, TODO_MIXED, [running, done, offline], width=80,
        ).plain

        assert "Active worker" in rendered
        assert "Finished worker" not in rendered
        assert "Offline worker" not in rendered

    def test_multiple_running_children_all_shown(self) -> None:
        parent = _session(title="Orch")
        children = [
            _child("c1", title="Explorer A", status="running", tokens_in=5000),
            _child("c2", title="Explorer B", status="running", tokens_in=8000),
        ]
        rendered = _render_task_list(
            parent, TODO_MIXED, children, width=80,
        ).plain
        assert "Explorer A" in rendered
        assert "Explorer B" in rendered

    def test_asking_child_shown_as_active(self) -> None:
        """A child in 'asking' status is user-blocked and should still
        appear so the user can see it needs attention."""
        parent = _session(title="Orch")
        asking = _child("c1", title="Needs input", status="asking", state="active")
        rendered = _render_task_list(parent, TODO_MIXED, [asking], width=80).plain
        assert "Needs input" in rendered


# ===================================================================
# §3  Edge cases — no children, missing attributes
# ===================================================================


class TestEdgeCases:
    def test_no_children_still_renders_task_lines(self) -> None:
        """When no child sessions exist, the task list must still render
        all todo items without crashing."""
        parent = _session(title="Solo worker")
        rendered = _render_task_list(parent, TODO_MIXED, [], width=80).plain
        assert "TASKS" in rendered
        assert "task-2" in rendered
        assert "Implement feature" in rendered

    def test_child_missing_token_attributes_does_not_crash(self) -> None:
        """A child session with zero/missing token counts should render
        a stable fallback (e.g. '0' or '—') instead of raising."""
        parent = _session(title="Orch")
        child = _child("c1", title="Bare child", tokens_in=0, tokens_out=0)
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        # Must not crash; child row must still appear
        assert "Bare child" in rendered

    def test_child_missing_context_usage_shows_fallback(self) -> None:
        """A child with no context_usage_pct should show 0% or a dash,
        not raise an error."""
        parent = _session(title="Orch")
        child = _child("c1", title="New child", context_pct=0.0)
        rendered = _render_task_list(parent, TODO_MIXED, [child], width=80).plain
        assert "New child" in rendered
        assert "0%" in rendered

    def test_empty_todo_with_children_shows_placeholder(self) -> None:
        """When there are no tasks but children exist, the panel should
        show a 'no active task list' message without child detail rows
        (children only appear under in-progress tasks)."""
        parent = _session(title="Orch")
        child = _child("c1", title="Orphan worker")
        rendered = _render_task_list(parent, "", [child], width=80).plain
        assert "no active task list" in rendered.lower()


# ===================================================================
# §4  Live todo state extraction and panel updates
# ===================================================================


class TestTodoPanelLiveState:
    """Tests encoding that the task panel must reflect real-time todo
    state extracted from session JSONL data."""

    def test_todo_state_updates_from_later_tool_result(self, tmp_path: Path) -> None:
        """When multiple todo_write results exist in a session, the task
        panel must reflect the LATEST state, not the first one."""
        from agents_view.features.conversation_preview import _extract_latest_todo_state

        early = "→ task-1 Start work\n○ task-2 Continue"
        later = "✓ task-1 Start work\n→ task-2 Continue"

        rows = [
            {
                "type": "message",
                "message": {
                    "role": "toolResult",
                    "toolName": "todo_write",
                    "content": [{"type": "text", "text": early}],
                },
            },
            {
                "type": "message",
                "message": {
                    "role": "toolResult",
                    "toolName": "todo_write",
                    "content": [{"type": "text", "text": later}],
                },
            },
        ]
        path = tmp_path / "session.jsonl"
        path.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")

        result = _extract_latest_todo_state(path)
        # Must contain the LATER todo state (task-1 done, task-2 in progress)
        assert "✓" in result and "task-1" in result, "Must include latest state for task-1"
        assert "→" in result and "task-2" in result, "Must include latest state for task-2"

    def test_active_task_context_visible_in_rendered_output(self) -> None:
        """The in-progress task line must carry a visual marker that
        distinguishes it from done/pending tasks so the user always
        knows which task the agent is working on."""
        parent = _session(title="Worker")
        rendered = _render_task_list(parent, TODO_MIXED, [], width=80)
        # The active task (task-2) must use the in-progress icon ▶
        plain = rendered.plain
        assert "▶" in plain
        # Done task uses ✓, pending uses ○
        assert "✓" in plain
        assert "○" in plain

    def test_child_token_and_status_update_on_rerender(self) -> None:
        """Simulates a re-render with updated child metrics.  The new
        values must appear — the panel must not cache stale data."""
        parent = _session(title="Orch")

        child_v1 = _child("c1", title="Worker", tokens_in=1000, tokens_out=200, context_pct=10.0)
        rendered_v1 = _render_task_list(parent, TODO_MIXED, [child_v1], width=80).plain

        child_v2 = _child("c1", title="Worker", tokens_in=25_000, tokens_out=8_000, context_pct=55.0)
        rendered_v2 = _render_task_list(parent, TODO_MIXED, [child_v2], width=80).plain

        # v2 must have the updated token counts, not v1's
        assert "25" in rendered_v2 or "25.0k" in rendered_v2 or "25000" in rendered_v2, (
            f"Expected updated input tokens in re-rendered output: {rendered_v2!r}"
        )
        assert "55%" in rendered_v2


# ===================================================================
# §5  _collect_child_sessions integration
# ===================================================================


class TestCollectChildSessions:
    """Verify child session collection from app-level session lists."""

    def test_collects_matching_parent_id(self) -> None:
        parent = _session(sid="p1")
        c1 = _child("c1", parent="p1", title="Match")
        c2 = _child("c2", parent="p2", title="Other parent")

        app = SimpleNamespace(_sessions=[parent, c1, c2], _agent_sessions=None)
        result = _collect_child_sessions(app, "p1")
        assert len(result) == 1
        assert result[0].session_id == "c1"

    def test_returns_empty_for_no_children(self) -> None:
        parent = _session(sid="p1")
        app = SimpleNamespace(_sessions=[parent], _agent_sessions=None)
        result = _collect_child_sessions(app, "p1")
        assert result == []

    def test_returns_empty_for_blank_parent_id(self) -> None:
        app = SimpleNamespace(_sessions=[_session(sid="s1")], _agent_sessions=None)
        result = _collect_child_sessions(app, "")
        assert result == []

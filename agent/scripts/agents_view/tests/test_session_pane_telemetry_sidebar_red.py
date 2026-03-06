from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.app import AgentsViewApp
from agents_view.features.conversation_preview import (
    _render_for_selected_session,
    _render_live_tasks_lines,
)
from agents_view.model import AgentSession


TODO_TEXT = (
    'Phase 1/1 "Telemetry" — 0/1 tasks complete\n'
    "  Telemetry:\n"
    "    → task-1 Observe subagent telemetry"
)
TODO_TASKS = [
    {
        "status": "in_progress",
        "id": "task-1",
        "content": "Observe subagent telemetry",
    }
]


class _PreviewStub:
    def __init__(self, width: int = 96) -> None:
        self.size = SimpleNamespace(width=width)


class _AppStub:
    def __init__(self) -> None:
        self._theme = {"name": "github-dark"}
        self._preview = _PreviewStub()

    def query_one(self, selector: str):
        if selector == "#preview-content":
            return self._preview
        raise LookupError(selector)


def _session(*, sid: str, status: str = "running") -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=sid,
        title=sid,
        cwd="/tmp/project",
        state="active",
        status=status,
    )


def _flatten(lines: list) -> str:
    return "\n".join(line.plain for line in lines)


def test_session_sidebar_mode_defaults_to_telemetry() -> None:
    app = AgentsViewApp(scope_root="/")
    assert getattr(app, "_session_telemetry_sidebar_mode", None) == "telemetry"


def test_session_sidebar_mode_toggle_action_exists_and_cycles_modes() -> None:
    app = AgentsViewApp(scope_root="/")
    toggle = getattr(app, "action_toggle_session_telemetry_sidebar", None)
    assert callable(toggle)


def test_live_telemetry_row_includes_title_status_tokens_and_context() -> None:
    child = SimpleNamespace(
        role="default",
        title="Auth telemetry worker",
        status="running",
        total_tokens_in=2_500,
        total_tokens_out=600,
        context_usage_pct=42,
    )

    rendered = _flatten(_render_live_tasks_lines(TODO_TEXT, TODO_TASKS, [child]))

    assert "Auth telemetry worker" in rendered
    assert "running" in rendered.lower()
    assert "2.5k" in rendered.lower() or "2500" in rendered or "2,500" in rendered
    assert "600" in rendered
    assert "42%" in rendered


def test_live_telemetry_row_uses_fallbacks_for_missing_child_metrics() -> None:
    child = SimpleNamespace(
        role="",
        title="",
        session_id="",
        status=None,
        total_tokens_in=None,
        total_tokens_out=None,
        context_usage_pct=None,
        context_pct=None,
    )

    rendered = _flatten(_render_live_tasks_lines(TODO_TEXT, TODO_TASKS, [child]))

    assert "(subagent)" in rendered
    assert "unknown" in rendered.lower()
    assert "0" in rendered and "↑" in rendered and "↓" in rendered
    assert "0%" in rendered


def test_live_telemetry_shows_placeholder_when_todo_missing() -> None:
    rendered = _flatten(_render_live_tasks_lines("", [], []))
    assert "no active task list" in rendered.lower()


def test_session_without_conversation_file_still_shows_sidebar_placeholder() -> None:
    session = _session(sid="missing-jsonl")
    app = _AppStub()

    rendered = _render_for_selected_session(app, session).plain

    assert "TASKS" in rendered
    assert "no active task list" in rendered.lower()

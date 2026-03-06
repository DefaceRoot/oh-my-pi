from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.features.conversation_preview import (
    _extract_latest_todo_state,
    _parse_todo_text,
    _render_for_selected_session,
    render_conversation_preview,
)
from agents_view.model import AgentSession


class _PreviewStub:
    def __init__(self, width: int = 100) -> None:
        self.size = SimpleNamespace(width=width)


class _AppStub:
    def __init__(self, sessions: list[AgentSession]) -> None:
        self._theme = {"name": "github-dark"}
        self._agent_sessions = sessions
        self._sessions = sessions
        self._preview = _PreviewStub()

    def query_one(self, selector: str):
        if selector == "#preview-content":
            return self._preview
        raise LookupError(selector)


def _session(*, sid: str, state: str = "active", status: str = "running") -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=sid,
        title=sid,
        cwd="/tmp/project",
        state=state,
        status=status,
    )


def test_extract_latest_todo_state_accepts_proxy_tool_result(tmp_path: Path) -> None:
    todo_text = 'Phase 1/1 "Setup" — 1/2 tasks complete\n  Setup:\n    ✓ task-1 Read files\n    → task-2 Implement fix'
    rows = [
        {
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolName": "proxy_todo_write",
                "content": [{"type": "text", "text": todo_text}],
            },
        }
    ]
    path = tmp_path / "session.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    assert _extract_latest_todo_state(path) == todo_text


def test_render_for_selected_session_renders_tasks_and_recent_children(tmp_path: Path) -> None:
    todo_text = 'Phase 1/1 "Setup" — 1/3 tasks complete\n  Setup:\n    ✓ task-1 Read files\n    → task-2 Implement fix\n    ○ task-3 Write tests'
    lines = [
        {"type": "message", "title": "Task session", "cwd": "/tmp/project"},
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Working on task list"}],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolName": "todo_write",
                "content": [{"type": "text", "text": todo_text}],
            },
        },
    ]
    jsonl_path = tmp_path / "parent.jsonl"
    jsonl_path.write_text("\n".join(json.dumps(row) for row in lines), encoding="utf-8")

    now = time.time()

    parent = _session(sid="parent", status="running")
    parent.session_file_path = str(jsonl_path)  # type: ignore[attr-defined]

    running_child = _session(sid="child-run", status="running")
    running_child.parent_session_id = "parent"
    running_child.role = "default"
    running_child.title = "Fix the parser"
    running_child.context_usage_pct = 0.10
    running_child.last_activity_ts = now

    recent_done_child = _session(sid="child-done", state="inactive", status="done")
    recent_done_child.parent_session_id = "parent"
    recent_done_child.role = "orchestrator"
    recent_done_child.title = "Update tests"
    recent_done_child.context_usage_pct = 0.05
    recent_done_child.last_activity_ts = now - 60

    old_done_child = _session(sid="child-old", state="inactive", status="done")
    old_done_child.parent_session_id = "parent"
    old_done_child.role = "default"
    old_done_child.title = "Old child"
    old_done_child.context_usage_pct = 0.03
    old_done_child.last_activity_ts = now - 1_200

    app = _AppStub([parent, running_child, recent_done_child, old_done_child])

    rendered = _render_for_selected_session(app, parent).plain

    assert "TASKS" in rendered
    assert "task-2" in rendered
    assert "└─ DEF" in rendered
    assert "└─ ORCH" in rendered
    assert "10%" in rendered
    assert "5%" in rendered
    assert "Old child" not in rendered


def test_render_conversation_preview_omits_tasks_section_without_todo_text() -> None:
    rendered = render_conversation_preview(
        [
            {
                "kind": "assistant",
                "timestamp": "10:00:00",
                "text": "hello",
                "model": "claude",
            }
        ],
        width=80,
        theme="github-dark",
    ).plain

    assert "TASKS" not in rendered


def test_parse_todo_text_maps_status_markers() -> None:
    parsed = _parse_todo_text(
        "✓ task-1 Done\n→ task-2 In progress\n○ task-3 Pending\n✗ task-4 Abandoned"
    )

    assert [item["status"] for item in parsed] == ["done", "in_progress", "pending", "abandoned"]
    assert [item["id"] for item in parsed] == ["task-1", "task-2", "task-3", "task-4"]

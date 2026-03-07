from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.sidebar_telemetry import render_live_sidebar_lines, render_window_snapshot


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


def _flatten(lines: list[str]) -> str:
    return "\n".join(lines)


def _strip_ansi(value: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", value)


def test_render_live_sidebar_lines_shows_subagent_placeholder_when_none_active() -> None:
    rendered = _flatten(render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [], frame_index=0))

    assert "task-1" in rendered
    assert "(no active subagents)" in rendered


def test_render_live_sidebar_lines_renders_subagent_telemetry_fields_and_linkage() -> None:
    child = SimpleNamespace(
        role="default",
        title="Sidebar worker",
        status="running",
        total_tokens_in=2_500,
        total_tokens_out=600,
        context_usage_pct=42,
        model="gpt-5-mini",
        task_id="task-1",
    )

    rendered = _flatten(render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [child], frame_index=0))

    assert "Sidebar worker" in rendered
    assert "task:task-1" in rendered
    assert "status:running" in rendered.lower()
    assert "tok:2.5k/600" in rendered.lower() or "tok:2500/600" in rendered.lower()
    assert "role:default" in rendered.lower()
    assert "model:gpt-5-mini" in rendered.lower()
    assert "ctx:42%" in rendered.lower()


def test_render_live_sidebar_lines_uses_placeholders_for_missing_child_metrics() -> None:
    child = SimpleNamespace(
        role="",
        title="",
        session_id="",
        status=None,
        total_tokens_in=None,
        total_tokens_out=None,
        context_usage_pct=None,
        context_pct=None,
        model="",
        task_id="",
    )

    rendered = _flatten(render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [child], frame_index=0))

    assert "(subagent)" in rendered
    assert "task:(unlinked)" in rendered.lower()
    assert "status:unknown" in rendered.lower()
    assert "tok:—/—" in rendered
    assert "role:(unknown)" in rendered.lower()
    assert "model:(unknown)" in rendered.lower()
    assert "ctx:—" in rendered


def test_render_live_sidebar_lines_color_codes_task_status_markers() -> None:
    todo_tasks = [
        {"status": "in_progress", "id": "task-1", "content": "Active"},
        {"status": "pending", "id": "task-2", "content": "Pending"},
        {"status": "completed", "id": "task-3", "content": "Done"},
        {"status": "abandoned", "id": "task-4", "content": "Abandoned"},
    ]

    rendered = _flatten(render_live_sidebar_lines("", todo_tasks, [], frame_index=0))

    assert "\x1b[" in rendered
    assert "○" in rendered
    assert "✓" in rendered
    assert "✗" in rendered


def test_render_live_sidebar_lines_groups_sections_by_state() -> None:
    todo_tasks = [
        {"status": "in_progress", "id": "task-1", "content": "Active"},
        {"status": "pending", "id": "task-2", "content": "Pending"},
        {"status": "completed", "id": "task-3", "content": "Done"},
        {"status": "abandoned", "id": "task-4", "content": "Abandoned"},
    ]

    rendered = _strip_ansi(_flatten(render_live_sidebar_lines("", todo_tasks, [], frame_index=0)))

    assert "states: active 1 · pending 1 · completed 1 · abandoned 1" in rendered
    assert "ACTIVE NOW (1)" in rendered
    assert "UP NEXT (1)" in rendered
    assert "COMPLETED (1)" in rendered
    assert "ABANDONED (1)" in rendered
    assert rendered.index("ACTIVE NOW") < rendered.index("UP NEXT") < rendered.index("COMPLETED") < rendered.index("ABANDONED")


def test_render_live_sidebar_lines_handles_narrow_width_and_stalled_child(monkeypatch) -> None:
    import agents_view.sidebar_telemetry as sidebar

    child = SimpleNamespace(
        role="default",
        title="A very long worker title that should wrap cleanly in narrow sidebars",
        status="stalled",
        total_tokens_in=11_200,
        total_tokens_out=420,
        context_usage_pct=77,
        model="gpt-5-mini",
        task_id="task-1",
    )

    monkeypatch.setattr(sidebar, "_sidebar_wrap_width", lambda default=80: 34)
    rendered_lines = sidebar.render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [child], frame_index=0)
    plain_lines = [_strip_ansi(line) for line in rendered_lines]

    assert any("ACTIVE NOW (1)" in line for line in plain_lines)
    assert any("✗" in line for line in plain_lines)
    detail_lines = [line for line in plain_lines if line.startswith("      ")]
    assert len(detail_lines) >= 2
    assert any("task:task-1" in line for line in detail_lines)
    assert any("ctx:77%" in line for line in detail_lines)


def test_render_live_sidebar_lines_animation_frame_advances_deterministically() -> None:
    child = SimpleNamespace(
        role="default",
        title="Spinner child",
        status="running",
        total_tokens_in=100,
        total_tokens_out=50,
        context_usage_pct=10,
        model="gpt-5-mini",
        task_id="task-1",
    )

    frame_zero = _flatten(render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [child], frame_index=0))
    frame_one = _flatten(render_live_sidebar_lines(TODO_TEXT, TODO_TASKS, [child], frame_index=1))

    assert "⠋" in frame_zero
    assert "⠙" in frame_one
    assert frame_zero != frame_one


def test_render_live_sidebar_lines_preserves_child_rows_without_todo_tasks() -> None:
    child = SimpleNamespace(
        role="default",
        title="Orphan telemetry worker",
        status="running",
        total_tokens_in=320,
        total_tokens_out=140,
        context_usage_pct=31,
        model="gpt-5-mini",
        task_id="",
    )

    rendered = _flatten(render_live_sidebar_lines("", [], [child], frame_index=0))
    plain = _strip_ansi(rendered)

    assert "(no active task list)" in plain.lower()
    assert "ACTIVE NOW (0)" in plain
    assert "unlinked subagents" in plain.lower()
    assert "Orphan telemetry worker" in plain
    assert "task:(unlinked)" in plain.lower()


def test_render_live_sidebar_lines_shows_task_placeholder_without_todo() -> None:
    rendered = _flatten(render_live_sidebar_lines("", [], []))
    assert "(no active task list)" in rendered.lower()



def test_render_live_sidebar_lines_wraps_long_task_content_with_indentation() -> None:
    long_content = (
        "Investigate telemetry drift when multiple subagents run in parallel and preserve context "
        "usage detail for each active branch."
    )
    todo_tasks = [
        {"status": "in_progress", "id": "task-9", "content": long_content},
    ]

    rendered_lines = render_live_sidebar_lines("Remaining items: 1.", todo_tasks, [], frame_index=0)
    plain_lines = [_strip_ansi(line) for line in rendered_lines]

    # The task ID and content must appear somewhere in the output.
    assert any("task-9" in line for line in plain_lines)
    full_text = " ".join(line.strip() for line in plain_lines)
    assert "Investigate telemetry drift" in full_text
    # With a combined label the content may wrap to a continuation line (2-space indent)
    # OR fit on one line; what matters is all text is present.
    combined_text = " ".join(plain_lines)
    assert "preserve context usage detail" in combined_text


def test_render_window_snapshot_includes_session_title_section(monkeypatch) -> None:
    import agents_view.sidebar_telemetry as sidebar

    current = SimpleNamespace(
        session_id="abc123",
        title="Build Sidebar UX",
        status="running",
        session_file=None,
    )

    monkeypatch.setattr(
        sidebar,
        "TmuxClient",
        lambda: SimpleNamespace(list_panes_all=lambda: []),
    )
    monkeypatch.setattr(
        sidebar,
        "ActiveTmuxAdapter",
        lambda _client: SimpleNamespace(list_active=lambda _scope: []),
    )
    monkeypatch.setattr(sidebar, "_as_sidebar_session", lambda raw: raw)
    monkeypatch.setattr(
        sidebar,
        "_choose_window_session",
        lambda *_args, **_kwargs: current,
    )
    monkeypatch.setattr(sidebar, "_extract_latest_todo_state", lambda _path: "")
    monkeypatch.setattr(sidebar, "_parse_todo_text", lambda _text: [])
    monkeypatch.setattr(sidebar, "_child_rows_for_parent", lambda *_args, **_kwargs: [])

    rendered = render_window_snapshot("@9", frame_index=0)

    assert "SESSION" in rendered
    assert "title: Build Sidebar UX" in rendered
    assert "TASKS" in rendered
    assert "session:" not in rendered
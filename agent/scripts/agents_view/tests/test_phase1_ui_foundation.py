"""Phase 1 tests for Agents View v2 UI/UX foundation behavior."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from textual.widgets import DataTable
from agents_view.app import AgentsViewApp, _render_active_preview, _render_context_bar
from agents_view.model import AgentSession, STALL_THRESHOLD_SECONDS


def _session(**kwargs) -> AgentSession:
    payload: dict[str, Any] = {
        "harness": "omp",
        "session_id": "session-1",
        "title": "Session One",
        "cwd": "/tmp/project",
        "state": "active",
    }
    payload.update(kwargs)
    return AgentSession(**payload)


def test_status_rich_all_paths() -> None:
    running = _session(status="running")
    assert running.status_rich == ("⚡ RUN ", "bold #57c4f8")

    waiting = _session(status="waiting", last_activity_ts=time.time() - 10)
    assert waiting.status_rich == ("◍ REVIEW", "bold #79c0ff")

    waiting_stuck = _session(
        status="waiting", last_activity_ts=time.time() - STALL_THRESHOLD_SECONDS - 5
    )
    assert waiting_stuck.status_rich == ("◍ REVIEW", "bold #79c0ff")
    asking = _session(status="asking", ask_ts=time.time() - 5)
    asking_label, asking_style = asking.status_rich
    assert asking_label.startswith("INPUT ")
    assert asking_label.endswith("s")
    assert asking_style == "bold #e8b84b"

    asking_stuck = _session(status="asking", ask_ts=time.time() - STALL_THRESHOLD_SECONDS - 5)
    assert asking_stuck.status_rich == ("! INPUT", "bold #f85149")

    idle = _session(status="idle")
    assert idle.status_rich == ("○ IDLE", "#636e7b")

    offline = _session(status="offline")
    assert offline.status_rich == ("○ OFF ", "#3d4451")

    stalled = _session(status="stalled")
    assert stalled.status_rich == ("● STALL", "bold #f85149")

    delegating = _session(status="delegating")
    assert delegating.status_rich == ("⚡ RUN ", "bold #57c4f8")

    assert _session(status="test_running").status_rich == ("▷ TEST", "bold #57c4f8")
    assert _session(status="build_running").status_rich == ("⚙ BUILD", "bold #d4a72c")
    assert _session(status="git_operation").status_rich == ("⎇ GIT", "bold #79c0ff")
    assert _session(status="agent_done").status_rich == ("✓ DONE", "bold #3fb950")
    assert _session(status="error_state").status_rich == ("✗ ERR", "bold #f85149")
    assert _session(status="rate_limited").status_rich == ("⊘ RATE", "bold #f0883e")

    unknown = _session(status="mystery")
    unknown_label, _unknown_style = unknown.status_rich
    assert unknown_label == "? ????"


def test_role_rich_all_paths() -> None:
    orchestrator = _session(role="orchestrator")
    assert orchestrator.role_rich == ("⬡ ORCH", "bold #f0883e")

    default = _session(role="default")
    default_label, default_style = default.role_rich
    assert default_label.startswith("◈")
    assert "DEF" in default_label
    assert default_style == "bold #539bf5"

    empty = _session(role="")
    empty_label, empty_style = empty.role_rich
    assert empty_style == "#444c56"
    assert empty_label.strip() == ""


def test_render_context_bar_formats_and_caps_values() -> None:
    bar = _render_context_bar(0.52)
    assert bar.plain == "[████████░░░░░░░░] 52%"

    capped = _render_context_bar(1.8)
    assert capped.plain == "[████████████████] 100%"

    none_bar = _render_context_bar(None)
    assert none_bar.plain == "[░░░░░░░░░░░░░░░░] --"


def test_render_active_preview_session_info_uses_full_context_bar(tmp_path) -> None:
    session_file = tmp_path / "session-context.jsonl"
    session_file.write_text(
        json.dumps({"type": "message", "cwd": "/tmp/project", "title": "Test session"}),
        encoding="utf-8",
    )

    rendered = str(
        _render_active_preview(
            str(session_file),
            session_context_pct=0.52,
            session_elapsed="2h05m",
        )
    )
    assert "Session Info" in rendered
    assert "Context: [████████░░░░░░░░] 52%" in rendered
    assert "Elapsed: 2h05m" in rendered

def test_ctx_cell_bar_rendering_and_threshold_colors() -> None:
    app = AgentsViewApp(scope_root="/")

    none_cell = app._ctx_cell(_session(context_usage_pct=None))
    assert none_cell.plain == "░░░░░░░░"

    green_cell = app._ctx_cell(_session(context_usage_pct=0.25))
    assert green_cell.plain == "██░░░░░░"
    assert any(str(span.style) == "#3fb950" for span in green_cell.spans)

    amber_cell = app._ctx_cell(_session(context_usage_pct=0.75))
    assert amber_cell.plain == "██████░░"
    assert any(str(span.style) == "#d4a72c" for span in amber_cell.spans)

    warn_cell = app._ctx_cell(_session(context_usage_pct=0.9))
    assert warn_cell.plain == "███████░"
    assert any("#d4a72c" in str(span.style) for span in warn_cell.spans)
    assert any("#f85149" in str(span.style) for span in warn_cell.spans)

    critical_cell = app._ctx_cell(_session(context_usage_pct=0.98))
    assert critical_cell.plain == "████████"
    assert any("bold blink #f85149" in str(span.style) for span in critical_cell.spans)

def test_make_row_cells_critical_context_applies_full_row_highlight() -> None:
    app = AgentsViewApp(scope_root="/")
    cells = app._make_row_cells(_session(context_usage_pct=0.98))

    assert all(
        all("on #3b1f23" not in str(span.style) for span in cell.spans)
        for cell in cells
    )
    ctx_index = app._session_table_column_keys().index("ctx")
    ctx_cell = cells[ctx_index]
    assert ctx_cell.plain == "████████"
    assert any("bold blink #f85149" in str(span.style) for span in ctx_cell.spans)
def test_preview_status_line_context_uses_model_window_tokens() -> None:
    app = AgentsViewApp(scope_root="/")
    preview = app._preview_status_line(
        _session(
            model="anthropic/claude-sonnet-4-6-20260205",
            role="default",
            branch="main",
            context_usage_pct=0.1,
        )
    )

    assert "Context: 100k/1000k (10%)" in preview.plain

def test_branch_cell_diff_shortstat_badge_behavior() -> None:
    app = AgentsViewApp(scope_root="/")

    no_diff = app._branch_cell(_session(branch="feature/auth", diff_shortstat=""))
    assert str(no_diff) == "feature/auth"

    with_diff = app._branch_cell(_session(branch="feature/auth", diff_shortstat="[+3 −1]"))
    assert "feature/auth" in with_diff.plain
    assert "[+3" in with_diff.plain

    long_branch = app._branch_cell(
        _session(branch="feature/very-long-branch-name-here", diff_shortstat="[+1]")
    )
    assert "…" in long_branch.plain


def test_age_cell_recent_active_session_is_green() -> None:
    app = AgentsViewApp(scope_root="/")

    recent_active = _session(state="active", last_activity_ts=time.time() - 10)
    cell = app._age_cell(recent_active)

    assert cell.style == "#3fb950"


def test_elapsed_cell_uses_placeholder_and_active_styles() -> None:
    app = AgentsViewApp(scope_root="/")

    no_elapsed = app._elapsed_cell(_session(session_start_ts=None))
    assert no_elapsed.plain == "—"
    assert no_elapsed.style == "#636e7b"

    running_elapsed = app._elapsed_cell(
        _session(session_start_ts=time.time() - ((2 * 3600) + (5 * 60)))
    )
    assert running_elapsed.style == "#adbac7"
    assert running_elapsed.plain == "2h05m"

def test_session_column_width_and_title_truncation() -> None:
    app = AgentsViewApp(scope_root="/")
    long_title = "x" * 60

    session_cell = app._session_cell(_session(title=long_title))
    assert session_cell.plain == long_title[:35]
    assert len(session_cell.plain) == 35

    async def run() -> None:
        async with app.run_test():
            table = app.query_one("#session-table", DataTable)
            session_width = next(
                col.width for col in table.columns.values() if str(col.label) == "SESSION"
            )
            ctx_width = next(
                col.width for col in table.columns.values() if str(col.label) == "CTX"
            )
            elapsed_width = next(
                col.width for col in table.columns.values() if str(col.label) == "ELAPSED"
            )
            assert session_width == 28
            assert ctx_width == 8
            assert elapsed_width == 7

    asyncio.run(run())

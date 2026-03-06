"""Regression tests for Agents View performance-oriented behavior."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import agents_view.app as app_mod
from agents_view.app import AgentsViewApp, _render_active_preview
from agents_view.model import AgentSession


def _active_session(
    session_id: str,
    *,
    pane: str,
    last_activity_ts: float,
    status: str = "running",
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=session_id,
        cwd="/tmp/project",
        state="active",
        status=status,
        tmux_pane=pane,
        last_activity_ts=last_activity_ts,
    )


def test_render_active_preview_reuses_cached_mtime_result(monkeypatch, tmp_path) -> None:
    app_mod._PREVIEW_CACHE.clear()
    session_file = tmp_path / "cached-preview.jsonl"
    session_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                json.dumps(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": "hello from cache"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    read_count = 0
    original_reader = app_mod._read_jsonl_tail_lines

    def counting_reader(path: str, tail_bytes: int = app_mod._JSONL_TAIL_BYTES):
        nonlocal read_count
        read_count += 1
        return original_reader(path, tail_bytes)

    monkeypatch.setattr(app_mod, "_read_jsonl_tail_lines", counting_reader)

    first = str(_render_active_preview(str(session_file)))
    second = str(_render_active_preview(str(session_file)))

    assert "hello from cache" in first
    assert "hello from cache" in second
    assert read_count == 1

    session_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                json.dumps(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": "updated output"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    os.utime(session_file, None)

    third = str(_render_active_preview(str(session_file)))
    assert "updated output" in third
    assert read_count == 2


def test_update_table_addition_avoids_full_clear(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    setattr(app, "_apply_theme", lambda theme: None)
    older = _active_session("older", pane="%1", last_activity_ts=1_000)
    newer = _active_session("newer", pane="%2", last_activity_ts=2_000)
    latest = _active_session("latest", pane="%3", last_activity_ts=500)

    async def run() -> None:
        async with app.run_test():
            app._sessions = [newer, older]
            app._update_table()

            table = app.query_one("#session-table")
            clear_calls = 0
            original_clear = table.clear

            def counted_clear(*args, **kwargs):
                nonlocal clear_calls
                clear_calls += 1
                return original_clear(*args, **kwargs)

            monkeypatch.setattr(table, "clear", counted_clear)

            app._sessions = [newer, older, latest]
            app._update_table()

            assert clear_calls <= 1

    asyncio.run(run())


def test_update_table_reschedules_preview_for_selected_active_session(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    setattr(app, "_apply_theme", lambda theme: None)
    session = _active_session("stable-preview", pane="%12", last_activity_ts=1_000)

    async def run() -> None:
        async with app.run_test():
            app._sessions = [session]
            app._selected_session = session
            app._update_table()

            timer_calls: list[float] = []
            monkeypatch.setattr(
                app,
                "set_timer",
                lambda interval, callback, *args, **kwargs: timer_calls.append(float(interval)) or object(),
            )

            session.status = "wait"
            app._sessions = [session]
            app._update_table()

            assert timer_calls == [0.05]

    asyncio.run(run())


def test_row_highlighted_uses_50ms_preview_debounce(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    setattr(app, "_apply_theme", lambda theme: None)
    session = _active_session("debounce-preview", pane="%13", last_activity_ts=1_000)

    async def run() -> None:
        async with app.run_test():
            app._sessions = [session]
            app._update_table()
            table = app.query_one("#session-table")

            timer_calls: list[float] = []
            monkeypatch.setattr(
                app,
                "set_timer",
                lambda interval, callback, *args, **kwargs: timer_calls.append(float(interval)) or object(),
            )

            app.on_data_table_row_highlighted(SimpleNamespace(cursor_row=0, data_table=table))

            assert timer_calls
            assert timer_calls[-1] <= 0.05

    asyncio.run(run())

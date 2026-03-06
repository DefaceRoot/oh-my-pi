"""Tests for AgentsViewApp inactive cap and manual mark-done flow."""

from __future__ import annotations

import asyncio
import time
import json
import sys
from pathlib import Path
from unittest.mock import patch

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from textual.widgets import DataTable
from agents_view.app import AgentsViewApp, _MAX_INACTIVE_AGE_SECONDS, _SEP_KEY
from agents_view.model import AgentSession


def _session(
    *,
    session_id: str,
    title: str,
    state: str,
    last_activity_ts: float | None,
    tmux_pane: str | None = None,
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=title,
        cwd="/tmp/project",
        state=state,
        tmux_pane=tmux_pane,
        last_activity_ts=last_activity_ts,
    )


def test_compute_ordered_keys_caps_inactive_to_ten() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    now = time.time()

    active = _session(
        session_id="active-main",
        title="Active Main",
        state="active",
        last_activity_ts=now - 30,
        tmux_pane="%1",
    )
    inactive = [
        _session(
            session_id=f"inactive-{i:02d}",
            title=f"Inactive {i:02d}",
            state="inactive",
            last_activity_ts=now - 300 - i,
        )
        for i in range(12)
    ]

    keys = app._compute_ordered_keys([active, *reversed(inactive)])

    assert keys[0] == "active-main"
    assert keys[1] == _SEP_KEY
    inactive_keys = keys[2:]
    assert len(inactive_keys) == 10
    assert inactive_keys == [s.session_id for s in inactive[:10]]


def test_compute_ordered_keys_keeps_all_active_sessions_visible() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    now = time.time()

    active_sessions = [
        _session(
            session_id=f"active-{i:02d}",
            title=f"Active {i:02d}",
            state="active",
            last_activity_ts=now - i,
            tmux_pane=f"%{i + 1}",
        )
        for i in range(12)
    ]
    inactive_sessions = [
        _session(
            session_id=f"inactive-{i:02d}",
            title=f"Inactive {i:02d}",
            state="inactive",
            last_activity_ts=now - 300 - i,
        )
        for i in range(30)
    ]

    keys = app._compute_ordered_keys([*active_sessions, *inactive_sessions])

    active_keys = [k for k in keys if k != _SEP_KEY][:12]
    assert len(active_keys) == 12
    assert active_keys == [s.session_id for s in active_sessions]
    assert len([k for k in keys if k.startswith("inactive-")]) == 10


def test_compute_ordered_keys_hides_inactive_older_than_one_day() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    now = time.time()
    active_old = _session(
        session_id="active-old",
        title="Active Old",
        state="active",
        last_activity_ts=now - 150_000,
        tmux_pane="%7",
    )
    inactive_recent = _session(
        session_id="inactive-recent",
        title="Inactive Recent",
        state="inactive",
        last_activity_ts=now - 30,
    )
    inactive_within_day = _session(
        session_id="inactive-within-day",
        title="Inactive Within Day",
        state="inactive",
        last_activity_ts=now - 43_199,
    )
    inactive_old = _session(
        session_id="inactive-old",
        title="Inactive Old",
        state="inactive",
        last_activity_ts=now - 43_201,
    )

    keys = app._compute_ordered_keys(
        [inactive_old, inactive_within_day, active_old, inactive_recent]
    )

    assert keys == [
        "active-old",
        _SEP_KEY,
        "inactive-recent",
        "inactive-within-day",
    ]


def test_compute_ordered_keys_keeps_missing_and_zero_timestamps_visible() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    now = time.time()
    active = _session(
        session_id="active-main",
        title="Active Main",
        state="active",
        last_activity_ts=now - 10,
        tmux_pane="%1",
    )
    missing_ts = _session(
        session_id="inactive-missing-ts",
        title="Inactive Missing",
        state="inactive",
        last_activity_ts=None,
    )
    zero_ts = _session(
        session_id="inactive-zero-ts",
        title="Inactive Zero",
        state="inactive",
        last_activity_ts=0,
    )
    stale_inactive = _session(
        session_id="inactive-stale",
        title="Inactive Stale",
        state="inactive",
        last_activity_ts=now - 100_000,
    )

    keys = app._compute_ordered_keys([missing_ts, zero_ts, stale_inactive, active])

    assert keys == [
        "active-main",
        _SEP_KEY,
        "inactive-missing-ts",
        "inactive-zero-ts",
    ]

def test_mark_done_hotkey_archives_selected_active_session(tmp_path: Path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    first_active = _session(
        session_id="active-a",
        title="Active A",
        state="active",
        last_activity_ts=100,
        tmux_pane="%1",
    )
    second_active = _session(
        session_id="active-b",
        title="Active B",
        state="active",
        last_activity_ts=90,
        tmux_pane="%2",
    )
    inactive = _session(
        session_id="inactive-z",
        title="Inactive Z",
        state="inactive",
        last_activity_ts=time.time() - 120,
    )
    archive_path = tmp_path / "session_archive.json"

    async def run() -> None:
        with patch("agents_view.app._ARCHIVE_FILE", archive_path):
            async with app.run_test() as pilot:
                app._sessions = [first_active, second_active, inactive]
                app._update_table()
                app._selected_session = first_active
                app.query_one("#session-table", DataTable).move_cursor(row=0)

                await pilot.press("x")
                await asyncio.sleep(0)

                assert "active-a" not in app._ordered_keys
                assert app._ordered_keys[0] == "active-b"
                assert "inactive-z" in app._ordered_keys
                assert "omp:active-a" in app._archived_session_keys

                archive = json.loads(archive_path.read_text(encoding="utf-8"))
                archived_ids = {entry["session_id"] for entry in archive}
                assert "active-a" in archived_ids

    asyncio.run(run())


def test_mark_done_hotkey_noops_for_inactive_row(tmp_path: Path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    inactive = _session(
        session_id="inactive-only",
        title="Inactive Only",
        state="inactive",
        last_activity_ts=time.time() - 60,
    )
    archive_path = tmp_path / "session_archive.json"
    initial_archived_keys = set(app._archived_session_keys)

    async def run() -> None:
        with patch("agents_view.app._ARCHIVE_FILE", archive_path):
            async with app.run_test() as pilot:
                app._sessions = [inactive]
                app._update_table()
                app._selected_session = inactive
                app.query_one("#session-table", DataTable).move_cursor(row=0)

                await pilot.press("x")
                await asyncio.sleep(0)

                assert app._ordered_keys == ["inactive-only"]
                assert app._archived_session_keys == initial_archived_keys
                assert not archive_path.exists()

    asyncio.run(run())


def test_dismissed_session_does_not_return_after_refresh(tmp_path: Path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    active = _session(
        session_id="session-1",
        title="Session 1",
        state="active",
        last_activity_ts=100,
        tmux_pane="%3",
    )
    archive_path = tmp_path / "session_archive.json"

    async def run() -> None:
        with patch("agents_view.app._ARCHIVE_FILE", archive_path):
            async with app.run_test() as pilot:
                app._sessions = [active]
                app._update_table()
                app._selected_session = active
                app.query_one("#session-table", DataTable).move_cursor(row=0)

                await pilot.press("x")
                await asyncio.sleep(0)
                assert "session-1" not in app._ordered_keys

                app._apply_refreshed_sessions([active])
                await asyncio.sleep(0)

                assert app._ordered_keys == []
                assert "omp:session-1" in app._archived_session_keys

    asyncio.run(run())


def test_stale_active_session_is_archived_and_hidden(tmp_path: Path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    now = time.time()
    stale_active = _session(
        session_id="active-stale",
        title="Active Stale",
        state="active",
        last_activity_ts=now - _MAX_INACTIVE_AGE_SECONDS - 30,
        tmux_pane="%4",
    )
    archive_path = tmp_path / "session_archive.json"

    async def run() -> None:
        with patch("agents_view.app._ARCHIVE_FILE", archive_path):
            async with app.run_test() as _pilot:
                app._apply_refreshed_sessions([stale_active])
                await asyncio.sleep(0)

                assert app._ordered_keys == []
                assert "omp:active-stale" in app._archived_session_keys

                archive = json.loads(archive_path.read_text(encoding="utf-8"))
                archived_ids = {entry["session_id"] for entry in archive}
                assert "active-stale" in archived_ids

    asyncio.run(run())
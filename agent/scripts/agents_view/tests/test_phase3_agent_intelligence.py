"""Phase 3 tests for Agents View v2 agent intelligence behavior (§5.1-5.4)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from rich.text import Text
# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.app import (
    AgentsViewApp,
    RecoveryLogScreen,
    ResourceBar,
    _health_check_pattern,
    _log_recovery,
)
from agents_view.adapters.active_tmux_adapter import _detect_omp_status
from agents_view.model import AgentSession, STALL_THRESHOLD_SECONDS, WAIT_THRESHOLD_SECONDS
from textual.widgets import DataTable, Input, Static


def _make_session(
    session_id: str,
    state: str = "active",
    role: str = "default",
    parent_session_id: str | None = None,
    **kwargs,
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=session_id,
        cwd="/tmp",
        state=state,
        role=role,
        parent_session_id=parent_session_id,
        **kwargs,
    )


def _do_merge(sessions: list[AgentSession]) -> list[AgentSession]:
    """Replicate AgentsViewApp._merge_sessions logic for focused unit testing."""
    by_id: dict[str, AgentSession] = {}
    for session in sessions:
        existing = by_id.get(session.session_id)
        if existing is None:
            by_id[session.session_id] = session
        elif session.state == "active" and existing.state != "active":
            by_id[session.session_id] = session

    for session in by_id.values():
        session.child_session_ids = []

    for session in by_id.values():
        if session.parent_session_id and session.parent_session_id in by_id:
            parent = by_id[session.parent_session_id]
            if session.session_id not in parent.child_session_ids:
                parent.child_session_ids.append(session.session_id)

    return list(by_id.values())


def _apply_stall(sessions: list[AgentSession]) -> None:
    """Replicate AgentsViewApp._apply_stall_status logic for focused unit testing."""
    import time as _t

    session_map = {session.session_id: session for session in sessions}
    now = _t.time()

    def effective_last_activity(session: AgentSession, depth: int = 0) -> float:
        if depth > 10:
            return session.last_activity_ts or 0.0
        best = session.last_activity_ts or 0.0
        for child_id in (session.child_session_ids or []):
            child = session_map.get(child_id)
            if child and child.state == "active":
                child_ts = effective_last_activity(child, depth + 1)
                if child_ts > best:
                    best = child_ts
        return best

    def any_descendant_running(session: AgentSession, depth: int = 0) -> bool:
        if depth > 10:
            return False
        for child_id in (session.child_session_ids or []):
            child = session_map.get(child_id)
            if child and child.state == "active":
                if child.status == "running":
                    return True
                if any_descendant_running(child, depth + 1):
                    return True
        return False

    for session in sessions:
        if session.state != "active":
            continue
        if session.status == "review":
            continue

        if session.status == "running" or any_descendant_running(session):
            session.status = "running"
            continue

        last_ts = effective_last_activity(session)
        if last_ts == 0.0:
            continue
        idle_seconds = now - last_ts

        if idle_seconds < WAIT_THRESHOLD_SECONDS:
            if session.status in ("delegating", "idle", "unknown"):
                session.status = "running"
        elif idle_seconds < STALL_THRESHOLD_SECONDS:
            session.status = "wait"
        else:
            session.status = "stalled"

def test_merge_links_child_to_parent() -> None:
    parent = _make_session("p1", role="orchestrator")
    child = _make_session("c1", parent_session_id="p1")

    result = _do_merge([parent, child])

    merged_parent = next(session for session in result if session.session_id == "p1")
    assert "c1" in merged_parent.child_session_ids


def test_merge_ignores_missing_parent() -> None:
    child = _make_session("c1", parent_session_id="missing")

    result = _do_merge([child])

    assert result[0].child_session_ids == []


def test_merge_no_duplicate_children() -> None:
    parent = _make_session("p1", role="orchestrator")
    child = _make_session("c1", parent_session_id="p1")

    result = _do_merge(_do_merge([parent, child]))

    merged_parent = next(session for session in result if session.session_id == "p1")
    assert merged_parent.child_session_ids.count("c1") == 1


def test_stall_detection_default() -> None:
    now = 1_000_000.0
    session = _make_session("s1", status="idle", last_activity_ts=now - 35)

    with patch("time.time", return_value=now):
        _apply_stall([session])

    assert session.status == "wait"


def test_stall_detection_orchestrator() -> None:
    now = 1_000_000.0

    parent_active_child = _make_session(
        "p-active", role="orchestrator", status="idle", last_activity_ts=now - 25
    )
    parent_active_child.child_session_ids = ["c-active"]
    child_active = _make_session(
        "c-active", status="running", last_activity_ts=now - 5
    )

    parent_silent = _make_session(
        "p-stalled", role="orchestrator", status="idle", last_activity_ts=now - 65
    )

    with patch("time.time", return_value=now):
        _apply_stall([parent_active_child, child_active, parent_silent])

    assert parent_active_child.status == "running"
    assert parent_silent.status == "stalled"

def test_review_status_on_agent_output(tmp_path: Path) -> None:
    session_file = tmp_path / "session.jsonl"
    session_file.write_text(
        json.dumps(
            {
                "timestamp": "2026-02-26T00:00:00Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Done."}],
                },
            }
        ),
        encoding="utf-8",
    )

    status, ask_ts = _detect_omp_status(session_file)
    assert status == "review"
    assert ask_ts is None


def test_run_preserved_during_subagent_activity() -> None:
    now = 1_000_000.0
    parent = _make_session(
        "p1", role="orchestrator", status="idle", last_activity_ts=now - 35
    )
    parent.child_session_ids = ["c1"]
    child = _make_session("c1", status="running", last_activity_ts=now - 5)

    with patch("time.time", return_value=now):
        _apply_stall([parent, child])

    assert parent.status == "running"


def test_wait_after_30s_all_silent() -> None:
    now = 1_000_000.0
    parent = _make_session(
        "p1", role="orchestrator", status="idle", last_activity_ts=now - 35
    )

    with patch("time.time", return_value=now):
        _apply_stall([parent])

    assert parent.status == "wait"

def test_stall_after_60s_all_silent() -> None:
    now = 1_000_000.0
    parent = _make_session(
        "p1", role="orchestrator", status="idle", last_activity_ts=now - 65
    )

    with patch("time.time", return_value=now):
        _apply_stall([parent])

    assert parent.status == "stalled"

def test_review_status_not_overridden_by_timer() -> None:
    now = 1_000_000.0
    session = _make_session("s1", status="review", last_activity_ts=now - 600)

    with patch("time.time", return_value=now):
        _apply_stall([session])

    assert session.status == "review"


def test_age_cell_uses_updated_gradient_tiers() -> None:
    now = 1_000_000.0
    app = AgentsViewApp(scope_root="/")

    cases = [
        (5, "bold #3fb950", "• 5s"),
        (60, "#57c4f8", "1m"),
        (600, "#adbac7", "10m"),
        (3_000, "#d4a72c", "50m"),
        (20_000, "#f0883e", "5h"),
        (90_000, "#636e7b", "1d"),
    ]

    with patch("time.time", return_value=now):
        for delta, expected_style, expected_plain in cases:
            session = _make_session(f"age-{delta}", last_activity_ts=now - delta)
            cell = app._age_cell(session)
            assert cell.style == expected_style
            assert cell.plain == expected_plain


def test_pattern_interactive_prompt() -> None:
    category, confidence = _health_check_pattern(["user@host:~$ "])
    assert category == "interactive_prompt"
    assert confidence > 0.0


def test_pattern_stdin_waiting() -> None:
    category, confidence = _health_check_pattern(["Are you sure? (y/n)"])
    assert category == "stdin_waiting"
    assert confidence > 0.0


def test_pattern_known_tool() -> None:
    category, confidence = _health_check_pattern(["Running tool bash"])
    assert category == "known_tool"
    assert confidence > 0.0


def test_pattern_agent_loop() -> None:
    category, confidence = _health_check_pattern(["Thinking..."])
    assert category == "agent_loop"
    assert confidence > 0.0


def test_pattern_agent_asking() -> None:
    category, confidence = _health_check_pattern(["What should I do?"])
    assert category == "agent_asking"
    assert confidence > 0.0


def test_pattern_new_statuses() -> None:
    assert _health_check_pattern(["pytest", "12 tests running"])[0] == "test_running"
    assert _health_check_pattern(["Building", "Compiling"])[0] == "build_running"
    assert _health_check_pattern(["git push", "Pushing to origin"])[0] == "git_operation"
    assert _health_check_pattern(["Done.", "Successfully completed"])[0] == "agent_done"
    assert _health_check_pattern(["Error:", "Traceback"])[0] == "error_state"
    assert _health_check_pattern(["HTTP 429 Too Many Requests"])[0] == "rate_limited"


def test_pattern_unknown() -> None:
    category, confidence = _health_check_pattern(["some random output line"])
    assert category == "unknown"
    assert confidence == 0.0


def test_pattern_priority_interactive_first() -> None:
    category, confidence = _health_check_pattern(["$ ", "Can you help?"])
    assert category == "interactive_prompt"
    assert confidence > 0.0


def test_pattern_confidence_increases_with_more_matches() -> None:
    _, low = _health_check_pattern(["Running tool"])
    _, high = _health_check_pattern(["Running tool", "Tool: bash", "Executing: step", "bash $"])
    assert high > low


def test_log_recovery_writes_entry(tmp_path: Path) -> None:
    log_file = tmp_path / "recovery_log.jsonl"

    with patch("agents_view.app._RECOVERY_LOG", log_file):
        _log_recovery("sid1", "my session", "stdin_waiting", "warning", False)

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1

    entry = json.loads(lines[0])
    assert entry["session_id"] == "sid1"
    assert entry["pattern"] == "stdin_waiting"
    assert entry["auto"] is False


def test_log_recovery_appends(tmp_path: Path) -> None:
    log_file = tmp_path / "recovery_log.jsonl"

    with patch("agents_view.app._RECOVERY_LOG", log_file):
        _log_recovery("s1", "t", "unknown", "warning", False)
        _log_recovery("s2", "t", "known_tool", "information", True)

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2


def test_recovery_stats_summary_includes_core_metrics() -> None:
    screen = RecoveryLogScreen()
    screen._malformed_count = 1
    entries = [
        {"ts": 99_700, "pattern": "stalled", "auto": True},
        {"ts": 98_000, "pattern": "stalled", "auto": False},
        {"ts": 10_000, "pattern": "stdin_waiting", "auto": True},
    ]
    with patch("time.time", return_value=100_000.0):
        rendered = str(screen._load_recovery_stats(entries))

    assert "Recovery Log Analysis" in rendered
    assert "Total events:" in rendered
    assert "Last 24h:" in rendered
    assert "Last 1h:" in rendered
    assert "Auto-recovery:" in rendered
    assert "Most common pattern: stalled" in rendered
    assert "Ignored malformed lines: 1" in rendered


def test_recovery_log_filter_matches_pattern_and_title(tmp_path: Path) -> None:
    log_file = tmp_path / "recovery_log.jsonl"
    entries = [
        {
            "ts": 1_000.0,
            "session_id": "s-1",
            "title": "alpha",
            "pattern": "stalled",
            "action": "restart",
            "auto": True,
        },
        {
            "ts": 900.0,
            "session_id": "s-2",
            "title": "beta",
            "pattern": "stdin_waiting",
            "action": "warning",
            "auto": False,
        },
    ]
    log_file.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")

    app = AgentsViewApp(scope_root="/")

    async def run() -> None:
        with patch("agents_view.app._RECOVERY_LOG", log_file):
            async with app.run_test() as pilot:
                app.push_screen(RecoveryLogScreen())
                await asyncio.sleep(0)

                screen = app.screen
                table = screen.query_one("#recovery-table", DataTable)
                for _ in range(20):
                    if table.row_count == 2:
                        break
                    await asyncio.sleep(0.01)
                assert table.row_count == 2

                await pilot.press("/")
                await asyncio.sleep(0)
                await pilot.press(*list("stalled"))
                await asyncio.sleep(0)
                assert table.row_count == 1

                filter_input = screen.query_one("#recovery-filter", Input)
                filter_input.value = "beta"
                await asyncio.sleep(0)
                assert table.row_count == 1

    asyncio.run(run())


def test_recovery_log_clear_requires_second_press(tmp_path: Path) -> None:
    log_file = tmp_path / "recovery_log.jsonl"
    log_file.write_text('{"ts": 1}\n', encoding="utf-8")

    screen = RecoveryLogScreen()
    notifications: list[str] = []
    screen.notify = lambda message, **_: notifications.append(str(message))  # type: ignore[method-assign]
    screen._load_entries = lambda: None  # type: ignore[method-assign]

    with patch("agents_view.app._RECOVERY_LOG", log_file):
        screen.action_clear_log()
        assert screen._clear_confirm_pending is True
        assert notifications[-1] == "Press c again to confirm clear"
        assert log_file.read_text(encoding="utf-8") != ""

        screen.action_clear_log()
        assert screen._clear_confirm_pending is False
        assert notifications[-1] == "Recovery log cleared"
        assert log_file.read_text(encoding="utf-8") == ""

def test_resource_bar_counts_active_stalled_done() -> None:
    bar = ResourceBar()
    sessions = [
        _make_session("a", state="active", status="running"),
        _make_session("b", state="active", status="stalled"),
        _make_session("c", state="inactive", status="offline"),
        _make_session("d", state="active", status="waiting"),
    ]

    bar.update_stats(sessions)

    assert bar._active == 2
    assert bar._stalled == 1
    assert bar._done == 1


def test_stats_bar_shows_no_sessions_when_empty() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    async def run() -> None:
        async with app.run_test():
            app._sessions = []
            app._update_stats_bar()
            content = app.query_one("#stats-bar", Static).content
            assert str(content) == "No sessions"

    asyncio.run(run())


def test_stats_bar_updates_after_session_refresh() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    run_session = _make_session(
        "run",
        status="running",
        total_tokens_in=1200,
        total_tokens_out=300,
        cost_usd=1.25,
    )
    run_session.cwd = "/tmp/proj-a"
    run_session.context_usage_pct = 0.82

    wait_session = _make_session(
        "wait",
        status="wait",
        total_tokens_in=50,
        total_tokens_out=50,
        cost_usd=0.10,
    )
    wait_session.cwd = "/tmp/proj-a"

    stalled_session = _make_session("stall", status="stalled")
    stalled_session.cwd = "/tmp/proj-b"
    stalled_session.context_usage_pct = 0.97

    idle_session = _make_session("idle", status="idle")
    idle_session.cwd = "/tmp/proj-c"

    done_session = _make_session("done", state="inactive", status="offline")
    done_session.cwd = "/tmp/proj-c"

    sessions = [run_session, wait_session, stalled_session, idle_session, done_session]

    async def run() -> None:
        async with app.run_test():
            app._apply_refreshed_sessions(sessions)
            content = app.query_one("#stats-bar", Static).content
            assert isinstance(content, Text)
            plain = content.plain
            assert "● 4 active" in plain
            assert "⚡ 1 running" in plain
            assert "⏳ 1 waiting" in plain
            assert "● 1 stalled" in plain
            assert "○ 2 idle" in plain
            assert "2k tokens" in plain
            assert "$1.35 cost" in plain
            assert "5 total" in plain
            assert "3 projects" in plain
            assert "⚠ 2 ctx warn" in plain
            assert "!! 1 ctx FULL" in plain

            styles = [str(span.style) for span in content.spans]
            assert any("#57c4f8" in style for style in styles)
            assert any("#d4a72c" in style for style in styles)
            assert any("#f85149" in style for style in styles)
            assert any("#636e7b" in style for style in styles)

    asyncio.run(run())


def test_context_alerts_fire_once_per_threshold_and_reset() -> None:
    app = AgentsViewApp(scope_root="/")
    notifications: list[tuple[str, str | None]] = []

    def fake_notify(message: object, *args, **kwargs) -> None:
        notifications.append((str(message), kwargs.get("severity")))

    app.notify = fake_notify  # type: ignore[method-assign]

    app._check_context_alerts([_make_session("session-a", context_usage_pct=0.81)])
    app._check_context_alerts([_make_session("session-a", context_usage_pct=0.86)])
    app._check_context_alerts([_make_session("session-a", context_usage_pct=0.96)])

    warning_messages = [entry for entry in notifications if entry[1] == "warning"]
    error_messages = [entry for entry in notifications if entry[1] == "error"]
    assert len(warning_messages) == 1
    assert len(error_messages) == 1

    app._check_context_alerts([_make_session("session-a", context_usage_pct=0.70)])
    assert "session-a" not in app._context_alerted_80
    assert "session-a" not in app._context_alerted_95

    app._check_context_alerts([])
    assert not app._context_alerted_80
    assert not app._context_alerted_95

    app._check_context_alerts([_make_session("session-a", context_usage_pct=0.83)])
    warning_messages = [entry for entry in notifications if entry[1] == "warning"]
    assert len(warning_messages) == 2
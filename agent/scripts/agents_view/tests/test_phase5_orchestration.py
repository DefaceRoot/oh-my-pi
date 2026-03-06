"""Phase 5 tests for Agents View v2 orchestration behavior (§7.1-7.5)."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.app import (
    AgentsViewApp,
    GraphScreen,
    MetricsScreen,
    _BROADCAST_HISTORY_CAP,
    _agents_view_palette_commands,
    _agents_view_palette_discover,
    _agents_view_palette_search,
    _load_broadcast_groups,
    _resolve_template_vars,
    _save_broadcast_groups,
)
from agents_view.model import AgentSession


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session(session_id: str, state: str = "active", **kwargs) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=session_id,
        cwd="/tmp",
        state=state,
        **kwargs,
    )


def _make_session_with_status(session_id: str, status: str, state: str = "active") -> AgentSession:
    session = _make_session(session_id=session_id, state=state)
    session.status = status
    return session


# ---------------------------------------------------------------------------
# §7.2 _resolve_template_vars
# ---------------------------------------------------------------------------


def test_resolve_simple_var() -> None:
    result = _resolve_template_vars({"task": "{{task}}"}, {"task": "build widget"})
    assert result["task"] == "build widget"


def test_resolve_multiple_vars() -> None:
    tpl = {"branch": "feature/{{branch}}", "project": "{{project}}"}
    ctx = {"branch": "my-branch", "project": "myproject"}
    result = _resolve_template_vars(tpl, ctx)
    assert result["branch"] == "feature/my-branch"
    assert result["project"] == "myproject"


def test_resolve_missing_var_unchanged() -> None:
    result = _resolve_template_vars({"x": "{{missing}}"}, {})
    assert result["x"] == "{{missing}}"


def test_resolve_non_string_values_passthrough() -> None:
    result = _resolve_template_vars({"num": 42, "flag": True}, {"task": "x"})
    assert result["num"] == 42
    assert result["flag"] is True


def test_resolve_empty_template() -> None:
    assert _resolve_template_vars({}, {"task": "x"}) == {}


# ---------------------------------------------------------------------------
# §7.4 _load_broadcast_groups / _save_broadcast_groups
# ---------------------------------------------------------------------------


def test_load_broadcast_groups_returns_default_when_missing(tmp_path: Path) -> None:
    p = tmp_path / "broadcast_groups.json"
    with patch("agents_view.app._BROADCAST_GROUPS_FILE", p):
        result = _load_broadcast_groups()
    assert result == {"groups": {}}


def test_load_broadcast_groups_reads_existing(tmp_path: Path) -> None:
    p = tmp_path / "broadcast_groups.json"
    data = {"groups": {"team": {"pane_ids": ["p1", "p2"], "history": ["hello"]}}}
    p.write_text(json.dumps(data), encoding="utf-8")
    with patch("agents_view.app._BROADCAST_GROUPS_FILE", p):
        result = _load_broadcast_groups()
    assert "team" in result["groups"]
    assert result["groups"]["team"]["pane_ids"] == ["p1", "p2"]


def test_save_and_reload(tmp_path: Path) -> None:
    p = tmp_path / "broadcast_groups.json"
    data = {"groups": {"mygroup": {"pane_ids": ["x"], "history": []}}}
    with patch("agents_view.app._BROADCAST_GROUPS_FILE", p):
        _save_broadcast_groups(data)
        loaded = _load_broadcast_groups()
    assert loaded["groups"]["mygroup"]["pane_ids"] == ["x"]
def test_broadcast_history_cap() -> None:
    """Simulate history capping in the send flow."""
    hist = list(range(15))
    if len(hist) > _BROADCAST_HISTORY_CAP:
        hist[:] = hist[-_BROADCAST_HISTORY_CAP:]
    assert len(hist) == _BROADCAST_HISTORY_CAP


# ---------------------------------------------------------------------------
# §7.1 GraphScreen _completion_bar
# ---------------------------------------------------------------------------


def test_completion_bar_no_children() -> None:
    screen = GraphScreen(sessions=[])
    bar = screen._completion_bar("p1", {})
    assert bar == ""


def test_completion_bar_all_done() -> None:
    parent = _make_session("p1", role="orchestrator")
    parent.child_session_ids = ["c1", "c2"]
    child1 = _make_session("c1", state="inactive")
    child2 = _make_session("c2", state="inactive")
    session_map = {"p1": parent, "c1": child1, "c2": child2}
    screen = GraphScreen(sessions=[parent, child1, child2])
    bar = screen._completion_bar("p1", session_map)
    assert "100%" in bar


def test_completion_bar_half_done() -> None:
    parent = _make_session("p1", role="orchestrator")
    parent.child_session_ids = ["c1", "c2"]
    child1 = _make_session("c1", state="inactive")
    child2 = _make_session("c2", state="active")
    session_map = {"p1": parent, "c1": child1, "c2": child2}
    screen = GraphScreen(sessions=[parent, child1, child2])
    bar = screen._completion_bar("p1", session_map)
    assert "50%" in bar


def test_metrics_content_empty_sessions_message() -> None:
    screen = MetricsScreen(sessions=[])
    content = screen._build_metrics_content([]).plain
    assert content.strip() == "No sessions to report"


def test_metrics_content_sections_and_project_truncation() -> None:
    now = time.time()
    waiting = _make_session(
        "def-wait",
        role="default",
        status="wait",
        repo="short-project",
        last_activity_ts=now - 120,
    )
    waiting.harness = "claude"

    sessions = [
        _make_session(
            "orch-running",
            role="orchestrator",
            status="running",
            repo="very-long-project-name-that-exceeds-limit",
            last_activity_ts=now - 60,
        ),
        waiting,
        _make_session(
            "def-stalled",
            role="default",
            status="stalled",
            repo="short-project",
            last_activity_ts=now - 3_600,
        ),
    ]
    screen = MetricsScreen(sessions=sessions)
    content = screen._build_metrics_content(sessions).plain

    assert "Status Distribution" in content
    assert "Role Distribution" in content
    assert "Harness Distribution" in content
    assert "Activity (last 24h)" in content
    assert "Projects" in content
    assert "very-long-project-na" in content
    assert "very-long-project-name" not in content

    running_line = next(line for line in content.splitlines() if "⚡ Running" in line)
    status_bar = running_line.split("⚡ Running", 1)[1].split("  ", 1)[0].strip()
    assert len(status_bar) == 18
    assert set(status_bar).issubset({"█", "░"})


def test_action_show_metrics_pushes_metrics_screen() -> None:
    app = AgentsViewApp(scope_root="/")
    app._sessions = [_make_session("s1")]
    pushed: list[object] = []

    def capture(screen) -> None:
        pushed.append(screen)

    app.push_screen = capture  # type: ignore[assignment,method-assign]
    app.action_show_metrics()

    assert len(pushed) == 1
    assert isinstance(pushed[0], MetricsScreen)


# ---------------------------------------------------------------------------
# §7.3 _notify_state_transitions
# ---------------------------------------------------------------------------


def test_notify_fires_on_done_transition() -> None:
    notifications: list[tuple[str, str]] = []
    app = AgentsViewApp(scope_root="/")
    app._sessions = [_make_session_with_status("s1", "waiting", state="active")]

    def fire(msg: str, event_type: str) -> None:
        notifications.append((msg, event_type))

    app._fire_notification = fire  # type: ignore[method-assign]
    app._notify_state_transitions([_make_session_with_status("s1", "offline", state="inactive")])

    assert len(notifications) == 1
    assert notifications[0][1] == "session_done"


def test_notify_no_fire_when_status_unchanged() -> None:
    notifications: list[tuple[str, str]] = []
    app = AgentsViewApp(scope_root="/")
    app._sessions = [_make_session_with_status("s1", "waiting")]

    def fire(msg: str, event_type: str) -> None:
        notifications.append((msg, event_type))

    app._fire_notification = fire  # type: ignore[method-assign]
    app._notify_state_transitions([_make_session_with_status("s1", "waiting")])

    assert len(notifications) == 0


# ---------------------------------------------------------------------------
# §7.5 AgentsViewCommandProvider
# ---------------------------------------------------------------------------


def test_command_provider_has_expected_commands() -> None:
    commands = _agents_view_palette_commands(object(), SimpleNamespace())
    command_names = {name for _, name, _, _ in commands}
    assert "Spawn agent" in command_names
    assert "Kill all stalled sessions" in command_names
    assert "Open archive" in command_names
    assert "Open template picker" in command_names


def test_command_provider_commands_count() -> None:
    commands = _agents_view_palette_commands(object(), SimpleNamespace())
    assert len(commands) >= 30

def test_palette_command_catalog_has_thirty_plus_entries() -> None:
    commands = _agents_view_palette_commands(object(), SimpleNamespace())
    command_names = {name for _, name, _, _ in commands}
    assert len(commands) >= 30
    assert "Jump to top" in command_names
    assert "Open metrics dashboard" in command_names
    assert "Sort by context usage" in command_names
    assert "Broadcast: /compact" in command_names


def test_palette_search_matches_substring_without_fuzzy_score() -> None:
    class _ZeroMatcher:
        def match(self, _: str) -> int:
            return 0

        def highlight(self, text: str):
            return text

    class _Provider:
        def __init__(self) -> None:
            self.app = SimpleNamespace()

        def matcher(self, _: str) -> _ZeroMatcher:
            return _ZeroMatcher()

    async def _collect() -> list[str]:
        provider = _Provider()
        return [hit.text async for hit in _agents_view_palette_search(provider, "bookmark")]

    hit_texts = asyncio.run(_collect())
    assert any("Next bookmark" in text for text in hit_texts)
    assert any("Bookmark session" in text for text in hit_texts)


def test_palette_discover_returns_thirty_plus_hits() -> None:
    class _Provider:
        def __init__(self) -> None:
            self.app = SimpleNamespace()

    async def _collect() -> list[str]:
        provider = _Provider()
        return [hit.text async for hit in _agents_view_palette_discover(provider)]

    hit_texts = asyncio.run(_collect())
    assert len(hit_texts) >= 30
    assert any("Open worktree manager" in text for text in hit_texts)
    assert any("Broadcast: run tests" in text for text in hit_texts)

from __future__ import annotations

import time
from types import SimpleNamespace

from agents_view import app as app_mod
from agents_view.model import AgentSession


def _session(
    session_id: str,
    *,
    status: str = "stalled",
    state: str = "active",
    title: str = "Session",
    last_activity_ts: float | None = None,
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=title,
        cwd="/tmp",
        state=state,
        status=status,
        last_activity_ts=last_activity_ts,
    )


def test_main_bindings_include_show_stalled() -> None:
    assert any(
        getattr(binding, "action", "") == "show_stalled"
        for binding in app_mod.AgentsViewApp.BINDINGS
    )


def test_action_show_stalled_pushes_stalled_screen() -> None:
    app = app_mod.AgentsViewApp(scope_root="/")
    app._adapters = []
    stalled = _session("stall-1", status="stalled", title="Stalled Session")
    running = _session("run-1", status="running", title="Running Session")
    app._sessions = [stalled, running]

    captured: dict[str, object] = {}

    def _push(screen) -> None:
        captured["screen"] = screen

    app.push_screen = _push  # type: ignore[method-assign]

    app.action_show_stalled()

    screen = captured.get("screen")
    assert isinstance(screen, app_mod.StalledAgentsScreen)
    assert [session.session_id for session in screen._sessions] == ["stall-1"]


def test_auto_kill_stalled_kills_and_logs(monkeypatch) -> None:
    app = app_mod.AgentsViewApp(scope_root="/")
    app._adapters = []
    app._auto_kill_stalled_minutes = 1
    app._auto_killed_stalled_ids = set()

    stalled = _session(
        "stall-old",
        status="stalled",
        title="Very Old Stalled Session",
        last_activity_ts=time.time() - 300,
    )

    killed: list[str] = []
    monkeypatch.setattr(
        app_mod.actions,
        "kill",
        lambda _tmux, session: killed.append(session.session_id),
        raising=False,
    )

    recovered: list[dict] = []
    monkeypatch.setattr(app_mod, "_log_recovery", lambda **kwargs: recovered.append(kwargs))

    notices: list[str] = []
    monkeypatch.setattr(app, "notify", lambda msg, **_kwargs: notices.append(msg))

    app._auto_kill_stalled_sessions([stalled])

    assert killed == ["stall-old"]
    assert recovered and recovered[0]["auto"] is True
    assert notices and notices[0].startswith("Auto-killed stalled:")


def test_stalled_screen_kill_all_requires_confirmation() -> None:
    tmux = SimpleNamespace(get_current_session=lambda: "")
    sessions = [_session("s-1"), _session("s-2")]
    screen = app_mod.StalledAgentsScreen(sessions=sessions, tmux=tmux)

    killed: list[str] = []
    screen._kill_session = lambda session: killed.append(session.session_id)  # type: ignore[method-assign]
    screen._refresh_table = lambda: None  # type: ignore[method-assign]
    screen.notify = lambda *_args, **_kwargs: None  # type: ignore[method-assign]

    screen.action_kill_all()
    assert screen._confirm_kill_all is True
    assert killed == []

    screen.action_kill_all()
    assert screen._confirm_kill_all is False
    assert killed == ["s-1", "s-2"]

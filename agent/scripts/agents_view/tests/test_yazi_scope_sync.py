"""Tests for yazi sidebar scope synchronization in AgentsViewApp."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import agents_view.adapters.active_tmux_adapter as active_mod
import agents_view.app as app_mod
from agents_view.tmux_client import TmuxClient, TmuxError
from agents_view.model import AgentSession

AgentsViewApp = app_mod.AgentsViewApp


def _app(scope_root: str = "/") -> AgentsViewApp:
    app = AgentsViewApp(scope_root=scope_root)
    app._adapters = []
    return app



def _session(session_id: str, cwd: str) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=session_id,
        cwd=cwd,
        state="inactive",
        last_activity_ts=1.0,
    )

def test_on_mount_registers_half_second_active_refresh(monkeypatch) -> None:
    intervals: list[tuple[float, str]] = []

    def fake_set_interval(self, interval: float, callback, *args, **kwargs):
        intervals.append((interval, getattr(callback, "__name__", "")))
        return None

    monkeypatch.setattr(AgentsViewApp, "set_interval", fake_set_interval)
    monkeypatch.setattr(AgentsViewApp, "_do_refresh_all", lambda self: None)

    app = AgentsViewApp(scope_root="/tmp/project")

    async def run() -> None:
        async with app.run_test():
            await asyncio.sleep(0)

    asyncio.run(run())

    assert (0.5, "_refresh_active") in intervals


def test_tmux_get_sidebar_pane_finds_role_tag_and_metadata(monkeypatch) -> None:
    client = TmuxClient()
    observed: dict[str, object] = {}

    def fake_run(args: list[str], timeout: float = 5.0) -> str:
        observed["args"] = args
        observed["timeout"] = timeout
        return "\n".join(
            [
                "%1\t111\t/work/a\talpha\t@1\t0",
                "%2\t222\t/work/b\tbeta\t@9\t1",
            ]
        )

    monkeypatch.setattr(client, "run", fake_run)

    sidebar = client.get_sidebar_pane()

    assert sidebar == {
        "pane": "%2",
        "pid": "222",
        "cwd": "/work/b",
        "session": "beta",
        "window": "@9",
    }
    assert observed["timeout"] == 2.0
    assert observed["args"][0:3] == ["list-panes", "-a", "-F"]
    assert "#{@sidebar_role}" in observed["args"][3]


def test_tmux_get_sidebar_pane_returns_none_on_tmux_error(monkeypatch) -> None:
    client = TmuxClient()
    monkeypatch.setattr(client, "run", lambda args, timeout=5.0: (_ for _ in ()).throw(TmuxError("boom")))
    assert client.get_sidebar_pane() is None


def test_sync_scope_root_from_sidebar_queues_update_only_on_change(monkeypatch) -> None:
    app = _app("/workspace/old")
    monkeypatch.setattr(app._tmux, "get_sidebar_pane", lambda: {"pid": "4321"})
    monkeypatch.setattr(app_mod.os, "readlink", lambda path: "/workspace/new/")

    queued: list[tuple[str, tuple[str, ...]]] = []
    monkeypatch.setattr(
        app,
        "call_from_thread",
        lambda callback, *args: queued.append((callback.__name__, args)),
    )

    changed = app._sync_scope_root_from_sidebar()

    assert changed is True
    assert queued == [("_apply_sidebar_scope_root", ("/workspace/new",))]


def test_sync_scope_root_from_sidebar_noops_when_scope_unchanged(monkeypatch) -> None:
    app = _app("/workspace/same")
    monkeypatch.setattr(app._tmux, "get_sidebar_pane", lambda: {"pid": "789"})
    monkeypatch.setattr(app_mod.os, "readlink", lambda path: "/workspace/same/")

    called = False

    def _called(*args, **kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(app, "call_from_thread", _called)

    changed = app._sync_scope_root_from_sidebar()

    assert changed is False
    assert called is False


@pytest.mark.parametrize("sidebar", [None, {}, {"pid": ""}, {"pid": "   "}])
def test_sync_scope_root_from_sidebar_noops_without_usable_sidebar(monkeypatch, sidebar) -> None:
    app = _app("/workspace/current")
    monkeypatch.setattr(app._tmux, "get_sidebar_pane", lambda: sidebar)

    called = False

    def _called(*args, **kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(app, "call_from_thread", _called)

    changed = app._sync_scope_root_from_sidebar()

    assert changed is False
    assert called is False


def test_sync_scope_root_from_sidebar_noops_on_readlink_error(monkeypatch) -> None:
    app = _app("/workspace/current")
    monkeypatch.setattr(app._tmux, "get_sidebar_pane", lambda: {"pid": "1234"})

    def fake_readlink(path: str) -> str:
        raise OSError("no proc entry")

    monkeypatch.setattr(app_mod.os, "readlink", fake_readlink)

    called = False

    def _called(*args, **kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(app, "call_from_thread", _called)

    changed = app._sync_scope_root_from_sidebar()

    assert changed is False
    assert called is False


def test_apply_sidebar_scope_root_updates_scope_subtitle_and_refresh(monkeypatch) -> None:
    app = _app("/workspace/old")
    refreshes: list[str] = []

    monkeypatch.setattr(app, "_do_refresh_all", lambda: refreshes.append(app.scope_root))

    app._apply_sidebar_scope_root("/workspace/new/")

    assert app.scope_root == "/workspace/new"
    assert app.sub_title == "scope: scoped (/workspace/new) | a toggles mode"
    assert refreshes == ["/workspace/new"]

    app._apply_sidebar_scope_root("/workspace/new")

    assert refreshes == ["/workspace/new"]



def test_collect_all_sessions_switches_between_scoped_and_global_roots(monkeypatch) -> None:
    app = _app("/workspace/project")
    scoped_session = _session("scoped-only", "/workspace/project")
    global_only_session = _session("global-only", "/outside/project")
    calls: list[tuple[str, str]] = []

    class FakeAdapter:
        def list_active(self, scope_root: str):
            calls.append(("active", scope_root))
            return []

        def list_inactive(self, scope_root: str, limit: int = 5):
            calls.append(("inactive", scope_root))
            if scope_root == "/":
                return [scoped_session, global_only_session]
            return [scoped_session]

    app._adapters = [FakeAdapter()]

    scoped_results = app._collect_all_sessions()
    assert {s.session_id for s in scoped_results} == {"scoped-only"}
    assert calls[-2:] == [
        ("active", "/workspace/project"),
        ("inactive", "/workspace/project"),
    ]

    monkeypatch.setattr(app, "_do_refresh_all", lambda: None)
    app.action_toggle_scope_mode()

    global_results = app._collect_all_sessions()
    assert {s.session_id for s in global_results} == {"scoped-only", "global-only"}
    assert calls[-2:] == [("active", "/"), ("inactive", "/")]


def test_toggle_scope_mode_restores_latest_sidebar_scope_when_switching_back(
    monkeypatch,
 ) -> None:
    app = _app("/workspace/old")
    refreshed_effective_roots: list[str] = []

    monkeypatch.setattr(
        app,
        "_do_refresh_all",
        lambda: refreshed_effective_roots.append(app._effective_scope_root()),
    )

    app.action_toggle_scope_mode()
    assert app._global_scope_enabled is True
    assert app._effective_scope_root() == "/"
    assert "scope: global (all paths)" in app.sub_title

    app._apply_sidebar_scope_root("/workspace/new/")
    assert app.scope_root == "/workspace/new"
    assert app._effective_scope_root() == "/"
    assert "scoped root: /workspace/new" in app.sub_title

    app.action_toggle_scope_mode()
    assert app._global_scope_enabled is False
    assert app._effective_scope_root() == "/workspace/new"
    assert app.sub_title == "scope: scoped (/workspace/new) | a toggles mode"
    assert refreshed_effective_roots == ["/", "/", "/workspace/new"]

def test_refresh_active_short_circuits_after_scope_change_detection(monkeypatch) -> None:
    app = _app("/workspace")
    monkeypatch.setattr(app, "_sync_scope_root_from_sidebar", lambda: True)

    active_calls: list[str] = []
    monkeypatch.setattr(
        active_mod.ActiveTmuxAdapter,
        "list_active",
        lambda self, scope_root: active_calls.append(scope_root) or [],
    )

    app._refresh_active.__wrapped__(app)

    assert active_calls == []

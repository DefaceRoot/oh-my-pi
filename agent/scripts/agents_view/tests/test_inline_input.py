"""Tests for the inline session input widget behavior."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import agents_view.actions as actions_mod
from agents_view import app as app_mod
from agents_view.app import AgentsViewApp
from agents_view.model import AgentSession


def _session(
    *,
    session_id: str,
    title: str,
    state: str = "active",
    tmux_pane: str | None = "%42",
) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=title,
        cwd="/tmp",
        state=state,
        tmux_pane=tmux_pane,
    )


def _renderable_plain_text(static_widget) -> str:
    return str(static_widget.content)


def test_inline_input_submits_to_selected_session(monkeypatch):
    sent: list[tuple[str, str]] = []

    def fake_send_input(client, pane_id: str, text: str) -> None:
        sent.append((pane_id, text))

    monkeypatch.setattr(actions_mod, "send_input", fake_send_input)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    session = _session(session_id="abc123", title="Test Session")

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            input_widget = app.query_one("#session-input")
            input_widget.focus()
            await pilot.type("hello world")
            await pilot.press("enter")
            await asyncio.sleep(0)

            assert sent == [("%42", "hello world")]
            assert input_widget.value == ""

    asyncio.run(run())


def test_inline_input_ignores_non_session_input_submissions(monkeypatch):
    sent: list[tuple[str, str]] = []

    def fake_send_input(client, pane_id: str, text: str) -> None:
        sent.append((pane_id, text))

    monkeypatch.setattr(actions_mod, "send_input", fake_send_input)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(session_id="s1", title="Session One")

    async def run() -> None:
        async with app.run_test() as _pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            filter_input = app.query_one("#filter-input")
            filter_input.value = "keep me"
            app.on_input_submitted(SimpleNamespace(input=filter_input, value="ignored"))

            assert sent == []
            assert filter_input.value == "keep me"

    asyncio.run(run())


def test_inline_input_clears_and_noops_without_selected_session_or_pane(monkeypatch):
    sent: list[tuple[str, str]] = []

    def fake_send_input(client, pane_id: str, text: str) -> None:
        sent.append((pane_id, text))

    monkeypatch.setattr(actions_mod, "send_input", fake_send_input)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    without_pane = _session(
        session_id="no-pane",
        title="No Pane",
        tmux_pane=None,
    )

    async def run() -> None:
        async with app.run_test() as _pilot:
            session_input = app.query_one("#session-input")

            session_input.value = "first message"
            app._selected_session = None
            app.on_input_submitted(
                SimpleNamespace(input=session_input, value="first message")
            )

            session_input.value = "second message"
            app._selected_session = without_pane
            app.on_input_submitted(
                SimpleNamespace(input=session_input, value="second message")
            )

            assert sent == []
            assert session_input.value == ""

    asyncio.run(run())


def test_tab_cycles_focus_between_session_table_and_input():
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(session_id="focus", title="Focus Session")

    async def run() -> None:
        async with app.run_test() as _pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            table = app.query_one("#session-table")
            input_widget = app.query_one("#session-input")

            assert table.has_focus
            await _pilot.press("tab")
            await asyncio.sleep(0)
            assert input_widget.has_focus

            await _pilot.press("tab")
            await asyncio.sleep(0)
            assert table.has_focus

    asyncio.run(run())


def test_enter_selects_active_session_and_focuses_inline_input(monkeypatch):
    selected: list[str] = []

    def fake_teleport(client, session) -> None:
        selected.append(session.session_id)

    def fail_resume(*_args, **_kwargs) -> None:
        raise AssertionError("resume should not be called for active session")

    monkeypatch.setattr(actions_mod, "teleport", fake_teleport)
    monkeypatch.setattr(actions_mod, "resume", fail_resume)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(session_id="active-enter", title="Active Enter", state="active")

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            table = app.query_one("#session-table")
            input_widget = app.query_one("#session-input")
            assert table.has_focus
            assert not input_widget.has_focus

            await pilot.press("enter")
            await asyncio.sleep(0)

            assert selected == ["active-enter"]
            assert input_widget.has_focus

    asyncio.run(run())


def test_enter_on_separator_row_noops_without_focus_change(monkeypatch):
    select_calls: list[str] = []

    monkeypatch.setattr(
        actions_mod,
        "teleport",
        lambda *_args, **_kwargs: select_calls.append("teleport"),
    )
    monkeypatch.setattr(
        actions_mod,
        "resume",
        lambda *_args, **_kwargs: select_calls.append("resume"),
    )

    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    async def run() -> None:
        async with app.run_test() as pilot:
            app._ordered_keys = [app_mod._SEP_KEY]
            app._session_map = {}

            table = app.query_one("#session-table")
            input_widget = app.query_one("#session-input")
            assert table.has_focus
            assert not input_widget.has_focus

            await pilot.press("enter")
            await asyncio.sleep(0)

            assert select_calls == []
            assert table.has_focus
            assert not input_widget.has_focus

    asyncio.run(run())


def test_select_session_degrades_when_input_widget_unavailable(monkeypatch):
    selected: list[str] = []

    def fake_teleport(client, session) -> None:
        selected.append(session.session_id)

    def fail_resume(*_args, **_kwargs) -> None:
        raise AssertionError("resume should not be called for active session")

    monkeypatch.setattr(actions_mod, "teleport", fake_teleport)
    monkeypatch.setattr(actions_mod, "resume", fail_resume)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(session_id="missing-input", title="Missing Input", state="active")

    async def run() -> None:
        async with app.run_test() as _pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            original_query_one = app.query_one

            def query_one_without_input(selector, *args):
                if selector == "#session-input":
                    raise RuntimeError("input missing")
                return original_query_one(selector, *args)

            monkeypatch.setattr(app, "query_one", query_one_without_input)
            app.action_select_session()

            assert selected == ["missing-input"]

    asyncio.run(run())


def test_selected_session_label_updates_when_table_selection_changes():
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    first = _session(
        session_id="first",
        title="First Session",
        state="inactive",
        tmux_pane=None,
    )
    second = _session(
        session_id="second",
        title="Second Session Title",
        state="inactive",
        tmux_pane=None,
    )

    async def run() -> None:
        async with app.run_test() as _pilot:
            app._sessions = [first, second]
            app._session_map = {first.session_id: first, second.session_id: second}
            app._ordered_keys = [first.session_id, second.session_id]
            app._update_table()

            table = app.query_one("#session-table")
            app.on_data_table_row_highlighted(
                SimpleNamespace(cursor_row=1, data_table=table)
            )

            label_text = _renderable_plain_text(app.query_one("#input-label"))
            assert app._selected_session is second
            assert "Second Session Title" in label_text

    asyncio.run(run())


def test_help_and_bindings_reflect_inline_input_flow():
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "tab" in binding_keys
    assert "x" in binding_keys
    assert "i" not in binding_keys
    assert "Switch table/input focus" in app_mod._HELP_TEXT
    assert "Jump to / Resume + focus input" in app_mod._HELP_TEXT
    assert "Mark active session done" in app_mod._HELP_TEXT
    assert "Send text input to session" not in app_mod._HELP_TEXT


def test_filter_presets_save_load_cycle_and_persist(monkeypatch, tmp_path):
    monkeypatch.setattr(app_mod, "_FILTER_PRESETS_FILE", tmp_path / "filter_presets.json")

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(session_id="preset-session", title="Preset Session")

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()

            await pilot.press("/")
            await asyncio.sleep(0)
            filter_input = app.query_one("#filter-input")

            await pilot.type("status:waiting")
            await pilot.press("ctrl+s")
            await asyncio.sleep(0)

            filter_input.value = ""
            app._filter_text = ""
            await pilot.type("repo:api")
            await pilot.press("ctrl+s")
            await asyncio.sleep(0)

            filter_input.value = ""
            app._filter_text = ""
            await pilot.press("ctrl+l")
            await asyncio.sleep(0)
            assert filter_input.value == "status:waiting"
            assert app._filter_text == "status:waiting"

            await pilot.press("ctrl+l")
            await asyncio.sleep(0)
            assert filter_input.value == "repo:api"
            assert app._filter_text == "repo:api"

    asyncio.run(run())

    assert app._filter_presets == {
        "preset_1": "status:waiting",
        "preset_2": "repo:api",
    }
    reloaded = AgentsViewApp(scope_root="/")
    assert reloaded._filter_presets == app._filter_presets


def test_filter_preset_actions_handle_empty_state(monkeypatch):
    app = AgentsViewApp(scope_root="/")
    messages: list[str] = []
    monkeypatch.setattr(
        app,
        "notify",
        lambda message, *args, **kwargs: messages.append(str(message)),
    )

    app.action_load_filter_preset()

    assert messages[-1] == "No saved presets"


def test_filter_presets_helpers_handle_missing_and_invalid_payload(
    monkeypatch, tmp_path
 ):
    presets_path = tmp_path / "filter_presets.json"
    monkeypatch.setattr(app_mod, "_FILTER_PRESETS_FILE", presets_path)

    assert app_mod._load_filter_presets() == {}

    presets_path.write_text("[1, 2, 3]", encoding="utf-8")
    assert app_mod._load_filter_presets() == {}


def test_filter_presets_helpers_save_and_reload(monkeypatch, tmp_path):
    presets_path = tmp_path / "filter_presets.json"
    monkeypatch.setattr(app_mod, "_FILTER_PRESETS_FILE", presets_path)

    data = {"preset_1": "status:waiting", "preset_2": "repo:api"}
    app_mod._save_filter_presets(data)

    assert app_mod._load_filter_presets() == data
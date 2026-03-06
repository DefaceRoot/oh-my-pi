"""Focused tests for create-session and kill-session actions."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from textual import events

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
    state: str,
    harness: str = "omp",
    tmux_pane: str | None = None,
) -> AgentSession:
    return AgentSession(
        harness=harness,
        session_id=session_id,
        title=title,
        cwd="/tmp/project",
        state=state,
        tmux_pane=tmux_pane,
    )


def test_create_session_calls_new_window_with_harness_and_session() -> None:
    calls: list[tuple[str, str, str]] = []

    class Client:
        def new_window(self, command: str, session: str, name: str) -> str:
            calls.append((command, session, name))
            return "@1"

    actions_mod.create_session(Client(), "dev", harness="claude")

    assert calls == [("claude", "dev", "claude")]


def test_create_session_defaults_to_omp_when_harness_blank() -> None:
    calls: list[tuple[str, str, str]] = []

    class Client:
        def new_window(self, command: str, session: str, name: str) -> str:
            calls.append((command, session, name))
            return "@1"

    actions_mod.create_session(Client(), "", harness="")

    assert calls == [("omp", "", "omp")]


def test_kill_session_calls_kill_pane_for_active_session() -> None:
    killed: list[str] = []

    class Client:
        def kill_pane(self, pane_id: str) -> None:
            killed.append(pane_id)

    session = _session(
        session_id="active-1",
        title="Active",
        state="active",
        tmux_pane="%9",
    )

    actions_mod.kill_session(Client(), session)

    assert killed == ["%9"]


def test_kill_session_noops_without_pane() -> None:
    killed: list[str] = []

    class Client:
        def kill_pane(self, pane_id: str) -> None:
            killed.append(pane_id)

    session = _session(
        session_id="active-no-pane",
        title="No Pane",
        state="active",
        tmux_pane=None,
    )

    actions_mod.kill_session(Client(), session)

    assert killed == []


def test_broadcast_input_skips_sessions_without_panes() -> None:
    sent: list[tuple[str, str, bool]] = []

    class Client:
        def send_keys(self, pane_id: str, text: str, enter: bool = True) -> None:
            sent.append((pane_id, text, enter))

    with_pane = _session(
        session_id="active-pane",
        title="Active Pane",
        state="active",
        tmux_pane="%11",
    )
    without_pane = _session(
        session_id="inactive-no-pane",
        title="No Pane",
        state="inactive",
        tmux_pane=None,
    )

    sent_to = actions_mod.broadcast_input(Client(), [with_pane, without_pane], "deploy")

    assert sent == [("%11", "deploy", True)]
    assert sent_to == ["%11"]


def test_bindings_and_help_include_new_broadcast_note_and_kill_actions() -> None:
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "space" in binding_keys
    assert "B" in binding_keys
    assert "N" in binding_keys
    assert "m" in binding_keys
    assert "Z" in binding_keys
    assert "ctrl+j" in binding_keys
    assert "ctrl+n" in binding_keys
    assert "ctrl+k" in binding_keys
    assert "ctrl+space" in binding_keys
    assert "ctrl+s" in binding_keys
    assert "ctrl+l" in binding_keys
    assert "a" in binding_keys
    assert "y" in binding_keys
    assert "Y" in binding_keys
    assert "@" in binding_keys
    assert "!" in binding_keys
    assert "Toggle broadcast selection" in app_mod._HELP_TEXT
    assert "Broadcast input to selected panes" in app_mod._HELP_TEXT
    assert "Compact selected session context" in app_mod._HELP_TEXT
    assert "Save/clear quick note from input" in app_mod._HELP_TEXT
    assert "Toggle bookmark on selected session" in app_mod._HELP_TEXT
    assert "Jump to next bookmarked session" in app_mod._HELP_TEXT
    assert "ctrl+n       New session" in app_mod._HELP_TEXT
    assert "ctrl+s       Save filter preset" in app_mod._HELP_TEXT
    assert "ctrl+l       Load filter preset" in app_mod._HELP_TEXT
    assert "Toggle scope (scoped/all paths)" in app_mod._HELP_TEXT
    assert "Kill active session" in app_mod._HELP_TEXT
    assert "ctrl+space   Toggle session compare selection" in app_mod._HELP_TEXT
    assert "Toggle macro recording" in app_mod._HELP_TEXT
    assert "Replay last macro" in app_mod._HELP_TEXT

    help_rows = set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert ("App", "@", "Rec macro") in help_rows
    assert ("Search", "Ctrl+S", "Save filter preset") in help_rows
    assert ("Search", "Ctrl+L", "Load filter preset") in help_rows
    assert ("App", "!", "Replay macro") in help_rows
    assert ("Session", "m", "Toggle bookmark") in help_rows
    assert ("Session", "Ctrl+J", "Next bookmark") in help_rows
    assert ("Session", "y", "Yank session ID") in help_rows
    assert ("Session", "Y", "Yank full info") in help_rows
    assert ("Session", "Z", "Compact context") in help_rows
    assert ("Session", "Ctrl+Space", "Select for compare") in help_rows


def test_select_for_compare_toggles_selection_and_launches_screen(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    first = _session(session_id="cmp-1", title="First", state="active")
    second = _session(session_id="cmp-2", title="Second", state="active")
    app._sessions = [first, second]

    current = {"session": first}
    notices: list[str] = []
    pushed: list[object] = []

    monkeypatch.setattr(app, "_current_session", lambda: current["session"])
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    app.push_screen = lambda screen: pushed.append(screen)  # type: ignore[method-assign]

    app.action_select_for_compare()
    assert app._compare_sessions == [first.session_id]
    assert notices[-1] == "Compare: 1/2 sessions selected"
    assert pushed == []

    current["session"] = second
    app.action_select_for_compare()
    assert app._compare_sessions == [first.session_id, second.session_id]
    assert notices[-1] == "Compare: 2/2 sessions selected"
    assert len(pushed) == 1
    assert isinstance(pushed[0], app_mod.SessionCompareScreen)

    app.action_select_for_compare()
    assert app._compare_sessions == [first.session_id]
    assert notices[-1] == "Compare: 1/2 sessions selected"


def test_select_for_compare_notifies_when_no_session_selected(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    notices: list[str] = []

    monkeypatch.setattr(app, "_current_session", lambda: None)
    app._selected_session = None
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    app.action_select_for_compare()
    assert notices[-1] == "Compare: no session selected"

def test_compact_session_action_targets_only_selected_session(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    selected = _session(
        session_id="active-1",
        title="Compact Target",
        state="active",
        tmux_pane="%44",
    )
    other = _session(
        session_id="active-2",
        title="Do Not Touch",
        state="active",
        tmux_pane="%45",
    )
    app._session_map = {selected.session_id: selected, other.session_id: other}
    app._ordered_keys = [selected.session_id, other.session_id]
    app._selected_session = selected

    sent: list[tuple[str, list[str]]] = []
    notices: list[str] = []

    def fake_broadcast_input(client, sessions, text: str):
        sent.append((text, [session.session_id for session in sessions]))
        return [session.tmux_pane for session in sessions if session.tmux_pane]

    monkeypatch.setattr(actions_mod, "broadcast_input", fake_broadcast_input)
    monkeypatch.setattr(app, "_is_table_focused", lambda: True)
    monkeypatch.setattr(app, "_current_session", lambda: selected)
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    app.action_compact_session()

    assert sent == [("/compact", ["active-1"])]
    assert notices[-1] == "Sent /compact to Compact Target"


def test_yank_bindings_and_help_rows_present() -> None:
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "y" in binding_keys
    assert "Y" in binding_keys

    help_rows = set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert ("Session", "y", "Yank session ID") in help_rows
    assert ("Session", "Y", "Yank full info") in help_rows
def test_yank_session_action_copies_compact_session_line(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(
        session_id="sess-123",
        title="Clipboard Session",
        state="active",
    )
    session.branch = "feature/clip"

    copied: list[str] = []
    notices: list[str] = []

    def fake_copy(text: str) -> bool:
        copied.append(text)
        return True

    monkeypatch.setattr(app_mod, "_copy_to_clipboard", fake_copy)
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    app._selected_session = session

    app.action_yank_session()

    assert copied == ["Clipboard Session | sess-123 | feature/clip"]
    assert notices[-1] == "Yanked: Clipboard Session"


def test_yank_session_info_action_shows_payload_when_clipboard_unavailable(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(
        session_id="sess-999",
        title="Verbose Clipboard Session",
        state="active",
    )
    session.branch = "feature/full"
    session.status = "waiting"
    session.role = "default"
    session.model = "claude-sonnet"
    session.context_usage_pct = 0.42

    copied: list[str] = []
    notices: list[str] = []

    def fake_copy(text: str) -> bool:
        copied.append(text)
        return False

    monkeypatch.setattr(app_mod, "_copy_to_clipboard", fake_copy)
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    app._selected_session = session

    app.action_yank_session_info()

    expected = "\n".join(
        [
            "Title: Verbose Clipboard Session",
            "ID: sess-999",
            "Branch: feature/full",
            "Status: waiting",
            "Role: default",
            "CWD: /tmp/project",
            "Model: claude-sonnet",
            "Context: 42%",
        ]
    )
    assert copied == [expected]
    assert notices[-1] == expected


def test_yank_session_action_notifies_when_no_session_selected() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    app.action_yank_session()

    assert notices[-1] == "No session selected"


def test_new_session_hotkey_opens_spawn_screen_and_launches_from_task_submit(
    monkeypatch,
 ) -> None:
    created: list[tuple[object, str, str]] = []

    def fake_create_session(client, tmux_session: str, harness: str = "omp") -> None:
        created.append((client, tmux_session, harness))

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    selected = _session(
        session_id="inactive-claude",
        title="Claude Session",
        state="inactive",
        harness="claude",
    )
    selected.branch = "feature/claude-task"

    monkeypatch.setattr(actions_mod, "create_session", fake_create_session)
    monkeypatch.setattr(app._tmux, "get_current_session", lambda: None)

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [selected]
            app._session_map = {selected.session_id: selected}
            app._ordered_keys = [selected.session_id]
            app._selected_session = selected
            app._update_table()
            app.query_one("#session-table").move_cursor(row=0)

            await pilot.press("ctrl+n")
            await asyncio.sleep(0)

            assert isinstance(app.screen, app_mod.SpawnScreen)
            assert app.screen.query_one("#spawn-branch").value == "feature/claude-task"

            app.screen.query_one("#spawn-harness").value = "claude"
            task_input = app.screen.query_one("#spawn-task")
            task_input.value = "Investigate stuck build"
            task_input.focus()

            await pilot.press("enter")
            await asyncio.sleep(0)

    asyncio.run(run())

    assert len(created) == 1
    assert created[0][0] is app._tmux
    assert created[0][1] == ""
    assert created[0][2] == "claude"


def test_kill_session_hotkey_calls_action_and_updates_ui_immediately(monkeypatch) -> None:
    killed: list[str] = []

    def fake_kill_session(client, session: AgentSession) -> None:
        killed.append(session.session_id)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    active = _session(
        session_id="active-kill",
        title="Active Kill",
        state="active",
        tmux_pane="%3",
    )
    inactive = _session(
        session_id="inactive-keep",
        title="Inactive Keep",
        state="inactive",
    )

    monkeypatch.setattr(actions_mod, "kill_session", fake_kill_session)

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [active, inactive]
            app._session_map = {active.session_id: active, inactive.session_id: inactive}
            app._ordered_keys = [active.session_id, inactive.session_id]
            app._selected_session = active
            app._update_table()
            app.query_one("#session-table").move_cursor(row=0)

            await pilot.press("ctrl+k")
            await asyncio.sleep(0)

            assert app._ordered_keys == [inactive.session_id]
            assert [s.session_id for s in app._sessions] == [inactive.session_id]

    asyncio.run(run())

    assert killed == ["active-kill"]



def test_space_toggle_and_b_hotkey_broadcasts_selected_sessions(monkeypatch, tmp_path) -> None:
    broadcasts: list[tuple[str, list[str]]] = []
    history_file = tmp_path / "broadcast_history.jsonl"

    class FakeInput:
        def __init__(self, value: str = "") -> None:
            self.value = value

        def clear(self) -> None:
            self.value = ""

    def fake_broadcast_input(client, sessions, text: str):
        broadcasts.append((text, [session.session_id for session in sessions]))
        return [session.tmux_pane for session in sessions if session.tmux_pane]

    monkeypatch.setattr(app_mod, "_BROADCAST_HISTORY_FILE", history_file, raising=False)
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    active = _session(
        session_id="active-selected",
        title="Active Selected",
        state="active",
        tmux_pane="%3",
    )
    inactive = _session(
        session_id="inactive-selected",
        title="Inactive Selected",
        state="inactive",
        tmux_pane=None,
    )
    app._sessions = [active, inactive]
    app._session_map = {active.session_id: active, inactive.session_id: inactive}
    app._ordered_keys = [active.session_id, inactive.session_id]
    app._broadcast_selected_ids = {active.session_id, inactive.session_id}

    session_input = FakeInput("sync now")
    monkeypatch.setattr(actions_mod, "broadcast_input", fake_broadcast_input)
    monkeypatch.setattr(app, "_is_table_focused", lambda: True)
    monkeypatch.setattr(app, "query_one", lambda selector, *_args: session_input)

    app.action_broadcast_selected()

    assert session_input.value == ""
    assert broadcasts == [("sync now", ["active-selected", "inactive-selected"])]
    entries = [
        json.loads(line)
        for line in history_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(entries) == 1
    assert entries[0]["message"] == "sync now"
    assert "targets" not in entries[0]
    assert entries[0]["count"] == 2
    assert isinstance(entries[0]["ts"], (int, float))


def test_broadcast_over_three_requires_second_confirmation(monkeypatch) -> None:
    broadcasts: list[tuple[str, list[str]]] = []

    class FakeInput:
        def __init__(self, value: str = "") -> None:
            self.value = value

        def clear(self) -> None:
            self.value = ""

    def fake_broadcast_input(client, sessions, text: str):
        broadcasts.append((text, [session.session_id for session in sessions]))
        return [session.tmux_pane for session in sessions if session.tmux_pane]

    sessions = [
        _session(
            session_id=f"active-{idx}",
            title=f"Active {idx}",
            state="active",
            tmux_pane=f"%{idx + 1}",
        )
        for idx in range(4)
    ]
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._sessions = sessions
    app._session_map = {session.session_id: session for session in sessions}
    app._ordered_keys = [session.session_id for session in sessions]
    app._broadcast_selected_ids = {session.session_id for session in sessions}

    session_input = FakeInput("deploy all")
    monkeypatch.setattr(actions_mod, "broadcast_input", fake_broadcast_input)
    monkeypatch.setattr(app, "_is_table_focused", lambda: True)
    monkeypatch.setattr(app, "query_one", lambda selector, *_args: session_input)

    app.action_broadcast_selected()

    assert app._broadcast_pending is True
    assert app._broadcast_pending_msg == "deploy all"
    assert broadcasts == []
    assert session_input.value == "deploy all"

    app.action_broadcast_selected()

    assert app._broadcast_pending is False
    assert app._broadcast_pending_msg == ""
    assert session_input.value == ""
    assert broadcasts == [(
        "deploy all",
        ["active-0", "active-1", "active-2", "active-3"],
    )]


def test_template_picker_uses_template_and_auto_selects_running(monkeypatch, tmp_path) -> None:
    broadcasts: list[tuple[str, list[str]]] = []

    class FakeInput:
        def __init__(self) -> None:
            self.value = ""
            self.cursor_position = 0

        def clear(self) -> None:
            self.value = ""

    class FakeTable:
        def __init__(self) -> None:
            self.focused = False

        def focus(self) -> None:
            self.focused = True

    def fake_broadcast_input(client, sessions, text: str):
        broadcasts.append((text, [session.session_id for session in sessions]))
        return [session.tmux_pane for session in sessions if session.tmux_pane]

    history_file = tmp_path / "broadcast_history.jsonl"
    monkeypatch.setattr(app_mod, "_BROADCAST_HISTORY_FILE", history_file, raising=False)

    running = _session(
        session_id="running-session",
        title="Running Session",
        state="active",
        tmux_pane="%7",
    )
    idle = _session(
        session_id="idle-session",
        title="Idle Session",
        state="active",
        tmux_pane="%8",
    )
    idle.status = "idle"

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._sessions = [running, idle]
    app._session_map = {running.session_id: running, idle.session_id: idle}
    app._ordered_keys = [running.session_id, idle.session_id]
    app._broadcast_selected_ids = set()

    input_widget = FakeInput()
    table_widget = FakeTable()

    def fake_query_one(selector, *_args):
        if selector == "#session-input":
            return input_widget
        if selector == "#session-table":
            return table_widget
        raise AssertionError(f"Unexpected selector: {selector}")

    monkeypatch.setattr(actions_mod, "broadcast_input", fake_broadcast_input)
    monkeypatch.setattr(app, "_is_table_focused", lambda: True)
    monkeypatch.setattr(app, "query_one", fake_query_one)
    monkeypatch.setattr(app, "_update_table", lambda: None)

    def fake_push_screen(_screen, callback=None):
        if callback is not None:
            callback("continue")
        return None

    monkeypatch.setattr(app, "push_screen", fake_push_screen)

    app.action_broadcast_template_picker()

    assert app._broadcast_selected_ids == {"running-session"}
    assert broadcasts == [("continue", ["running-session"])]
    assert app._broadcast_pending is False

def test_bookmark_hotkey_toggles_persists_and_marks_session(monkeypatch, tmp_path) -> None:
    bookmarks_file = tmp_path / "session_bookmarks.json"
    monkeypatch.setattr(app_mod, "_BOOKMARKS_FILE", bookmarks_file)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(
        session_id="bookmark-me",
        title="Bookmark Me",
        state="active",
        tmux_pane="%3",
    )

    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    monkeypatch.setattr(app, "_current_session", lambda: session)
    monkeypatch.setattr(app, "_update_table", lambda: None)

    app.action_toggle_bookmark()

    assert session.session_id in app._bookmarks
    assert notices[-1] == "Bookmarked: Bookmark Me"
    assert app._session_cell(session).plain.startswith("★ ")

    saved_payload = json.loads(bookmarks_file.read_text(encoding="utf-8"))
    assert saved_payload == {"bookmarks": ["bookmark-me"]}

    reloaded = AgentsViewApp(scope_root="/")
    reloaded._adapters = []
    assert "bookmark-me" in reloaded._bookmarks

    app.action_toggle_bookmark()
    assert session.session_id not in app._bookmarks
    assert notices[-1] == "Bookmark removed: Bookmark Me"

def test_next_bookmark_hotkey_cycles_with_wrap_and_no_bookmarks_notice(monkeypatch, tmp_path) -> None:
    bookmarks_file = tmp_path / "session_bookmarks.json"
    monkeypatch.setattr(app_mod, "_BOOKMARKS_FILE", bookmarks_file)

    first = _session(session_id="bm-1", title="First", state="active", tmux_pane="%1")
    middle = _session(session_id="bm-2", title="Middle", state="active", tmux_pane="%2")
    last = _session(session_id="bm-3", title="Last", state="active", tmux_pane="%3")

    class FakeTable:
        def __init__(self) -> None:
            self.cursor_row = 0

        def move_cursor(self, row: int) -> None:
            self.cursor_row = row

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._bookmarks = {first.session_id, last.session_id}
    app._ordered_keys = [first.session_id, middle.session_id, last.session_id]
    app._session_map = {s.session_id: s for s in (first, middle, last)}

    table = FakeTable()
    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    monkeypatch.setattr(app, "query_one", lambda *_args, **_kwargs: table)

    app.action_next_bookmark()
    assert table.cursor_row == 2

    app.action_next_bookmark()
    assert table.cursor_row == 0

    app._bookmarks = set()
    app.action_next_bookmark()
    assert notices[-1] == "No bookmarks"

def test_macro_recording_tracks_keys_skips_stop_and_caps_length(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    app.action_toggle_macro_record()
    app.on_key(events.Key("a", "a"))
    app.on_key(events.Key("at", "@"))
    for _ in range(60):
        app.on_key(events.Key("b", "b"))
    app.action_toggle_macro_record()

    assert app._saved_macros["last"] == ["a"] + ["b"] * 49
    assert notices[0] == "Recording macro... (@ to stop)"
    assert notices[-1] == "Macro saved: 50 keys"

def test_macro_replay_notifies_when_missing() -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    app.action_replay_macro()

    assert notices == ["No macro recorded"]

def test_macro_replay_simulates_saved_keys(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    notices: list[str] = []
    replayed: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]
    monkeypatch.setattr(app, "simulate_key", lambda key: replayed.append(key))
    app._saved_macros["last"] = ["j", "k", "enter"]

    async def run() -> None:
        app.action_replay_macro()
        await asyncio.sleep(0.2)

    asyncio.run(run())

    assert notices[0] == "Replaying 3 keys..."
    assert replayed == ["j", "k", "enter"]

def test_macro_bindings_and_help_entries_present() -> None:
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "@" in binding_keys
    assert "!" in binding_keys
    assert "Toggle macro recording" in app_mod._HELP_TEXT
    assert "Replay last macro" in app_mod._HELP_TEXT

    help_rows = set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert ("App", "@", "Rec macro") in help_rows
    assert ("App", "!", "Replay macro") in help_rows

def test_column_picker_binding_and_help_rows_present() -> None:
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "V" in binding_keys

    help_rows = set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert ("Input", "V", "Column picker") in help_rows
    assert "V            Column picker" in app_mod._HELP_TEXT


def test_column_visibility_applies_and_persists(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "column_config.json"
    monkeypatch.setattr(app_mod, "_COLUMN_CONFIG_FILE", config_path)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    session = _session(
        session_id="column-toggle-session",
        title="Column Toggle Session",
        state="inactive",
        tmux_pane="%41",
    )

    async def run() -> None:
        async with app.run_test():
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._selected_session = session
            app._update_table()

            table = app.query_one("#session-table")
            labels = [str(column.label) for column in table.columns.values()]
            assert "STATUS" in labels
            assert "SESSION" in labels
            assert "REPO" not in labels

            updated = dict(app._column_config)
            updated["repo"] = True
            updated["harness"] = False
            updated["status"] = False
            updated["session"] = False
            app._apply_column_config(updated)
            await asyncio.sleep(0)

            labels_after = [str(column.label) for column in table.columns.values()]
            assert "REPO" in labels_after
            assert "HARNESS" not in labels_after
            assert "STATUS" in labels_after
            assert "SESSION" in labels_after

    asyncio.run(run())

    payload = json.loads(config_path.read_text(encoding="utf-8"))
    assert payload["repo"] is True
    assert payload["harness"] is False
    assert payload["status"] is True
    assert payload["session"] is True


def test_column_picker_shortcut_opens_picker_screen(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(app_mod, "_COLUMN_CONFIG_FILE", tmp_path / "column_config.json")
    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("V")
            await asyncio.sleep(0)
            assert isinstance(app.screen, app_mod.ColumnPickerScreen)

    asyncio.run(run())

def test_git_bindings_help_rows_and_palette_commands_present() -> None:
    binding_keys = {binding.key for binding in AgentsViewApp.BINDINGS}
    assert "ctrl+alt+f" in binding_keys
    assert "ctrl+alt+p" in binding_keys
    assert "ctrl+alt+l" in binding_keys

    help_rows = set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert ("Git", "Ctrl+Alt+F", "Git fetch") in help_rows
    assert ("Git", "Ctrl+Alt+P", "Git push") in help_rows
    assert ("Git", "Ctrl+Alt+L", "Git log") in help_rows

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    palette_commands = {command for command, _ in app._palette_commands()}
    assert "Git: fetch" in palette_commands
    assert "Git: push" in palette_commands
    assert "Git: log" in palette_commands


def test_git_actions_run_expected_commands(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    session = _session(
        session_id="git-session",
        title="Git Session",
        state="active",
    )
    session.branch = "feature/git-shortcuts"
    app._selected_session = session

    notices: list[str] = []
    app.notify = lambda message, *args, **kwargs: notices.append(str(message))  # type: ignore[method-assign]

    commands: list[tuple[str, list[str], str]] = []
    logs: list[str] = []

    def fake_run_git_bg(cwd: str, cmd: list[str], description: str) -> None:
        commands.append((cwd, cmd, description))

    monkeypatch.setattr(app, "_run_git_bg", fake_run_git_bg)
    monkeypatch.setattr(app, "_load_git_log", lambda cwd: logs.append(cwd))

    app.action_git_fetch()
    app.action_git_push()
    app.action_git_log()

    assert commands == [
        ("/tmp/project", ["git", "fetch", "--prune"], "Fetch"),
        ("/tmp/project", ["git", "push", "-u", "origin", "feature/git-shortcuts"], "Push"),
    ]
    assert logs == ["/tmp/project"]
    assert notices[:3] == ["Fetching...", "Pushing...", "Loading git log..."]
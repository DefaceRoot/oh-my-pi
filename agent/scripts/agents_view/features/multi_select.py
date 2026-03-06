"""multi_select.py - Multi-select sessions for batch operations.
Provides v/V/ctrl+v for toggle/select-all/clear selection.
"""
from __future__ import annotations

from textual.binding import Binding

_selected_sessions: set[str] = set()


def toggle_session_selection(session_id: str) -> bool:
    """Toggle selection. Returns new selected state."""
    if session_id in _selected_sessions:
        _selected_sessions.discard(session_id)
        return False
    _selected_sessions.add(session_id)
    return True


def clear_selection() -> None:
    _selected_sessions.clear()


def get_selected_count() -> int:
    return len(_selected_sessions)


def is_selected(session_id: str) -> bool:
    return session_id in _selected_sessions


def get_selected_ids() -> frozenset[str]:
    return frozenset(_selected_sessions)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen

        AgentsViewApp._multi_selected = _selected_sessions
        AgentsViewApp._is_session_selected = staticmethod(is_selected)
        AgentsViewApp._get_selected_count = staticmethod(get_selected_count)
        AgentsViewApp._clear_multi_selection = staticmethod(clear_selection)
        AgentsViewApp._get_selected_ids = staticmethod(get_selected_ids)

        def _action_toggle_select_session(self: object) -> None:
            sessions = getattr(self, "_sessions", [])
            try:
                table = self.query_one("#session-table")  # type: ignore[attr-defined]
                cursor_row = table.cursor_row
                visible = getattr(self, "_visible_sessions", sessions)
                if 0 <= cursor_row < len(visible):
                    s = visible[cursor_row]
                    new_state = toggle_session_selection(s.session_id)
                    count = get_selected_count()
                    msg = f"✓ {count} selected" if new_state else f"Deselected ({count} remain)"
                    self.notify(msg, timeout=1)  # type: ignore[attr-defined]
            except Exception:
                pass

        def _action_select_all_sessions(self: object) -> None:
            for s in getattr(self, "_sessions", []):
                _selected_sessions.add(s.session_id)
            n = len(_selected_sessions)
            self.notify(f"Selected {n} sessions")  # type: ignore[attr-defined]

        def _action_clear_selection(self: object) -> None:
            count = len(_selected_sessions)
            clear_selection()
            self.notify(f"Cleared {count} selection(s)")  # type: ignore[attr-defined]

        AgentsViewApp.action_toggle_select_session = _action_toggle_select_session  # type: ignore[attr-defined]
        AgentsViewApp.action_select_all_sessions = _action_select_all_sessions  # type: ignore[attr-defined]
        AgentsViewApp.action_clear_selection = _action_clear_selection  # type: ignore[attr-defined]

        existing_keys = {b.key for b in AgentsViewApp.BINDINGS}
        new_bindings: list[Binding] = []
        if "v" not in existing_keys:
            new_bindings.append(Binding("v", "toggle_select_session", "Toggle select"))
        if "V" not in existing_keys:
            new_bindings.append(Binding("V", "select_all_sessions", "Select all"))
        if "ctrl+v" not in existing_keys:
            new_bindings.append(Binding("ctrl+v", "clear_selection", "Clear selection"))
        if new_bindings:
            AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + new_bindings

        for entry in [
            ("Session", "v", "Toggle multi-select"),
            ("Session", "V", "Select all sessions"),
        ]:
            if entry not in HelpScreen._BINDINGS_TABLE:
                HelpScreen._BINDINGS_TABLE.append(entry)
    except Exception:
        pass


_patch_app()

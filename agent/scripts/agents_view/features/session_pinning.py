"""session_pinning.py - Pin sessions to top and mark favorites.

Provides:
- ! key: toggle pin (session stays at top)
- * key: toggle star/favorite
- #starred filter to show only favorites
- Persistence to ~/.omp/agents-view-pins.json
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

_PINS_FILE = Path.home() / ".omp" / "agents-view-pins.json"
_FAVS_FILE = Path.home() / ".omp" / "agents-view-favorites.json"
_IDLE_DONE_STATUSES = {"idle", "done", "offline", "unknown"}

_pinned_sessions: set[str] = set()
_starred_sessions: set[str] = set()


def _load_session_set(path: Path) -> set[str]:
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()

    payload: Any = raw
    if isinstance(raw, dict):
        for key in ("sessions", "items", "pins", "favorites", "starred"):
            candidate = raw.get(key)
            if isinstance(candidate, list):
                payload = candidate
                break

    if not isinstance(payload, list):
        return set()

    normalized: set[str] = set()
    for item in payload:
        if isinstance(item, str):
            value = item.strip()
            if value:
                normalized.add(value)
    return normalized


def _save_session_set(path: Path, session_ids: set[str]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(f"{path.suffix}.tmp")
        tmp_path.write_text(json.dumps(sorted(session_ids), indent=2), encoding="utf-8")
        tmp_path.replace(path)
    except Exception:
        pass


def load_pins() -> None:
    """Load pinned and starred sessions from disk."""
    global _pinned_sessions, _starred_sessions
    _pinned_sessions = _load_session_set(_PINS_FILE)
    _starred_sessions = _load_session_set(_FAVS_FILE)


def save_pins() -> None:
    """Save pinned sessions to disk."""
    _save_session_set(_PINS_FILE, _pinned_sessions)


def save_favorites() -> None:
    """Save starred sessions to disk."""
    _save_session_set(_FAVS_FILE, _starred_sessions)


def is_pinned(session_id: str) -> bool:
    return session_id in _pinned_sessions


def is_starred(session_id: str) -> bool:
    return session_id in _starred_sessions


def toggle_pin(session_id: str) -> bool:
    """Toggle pin state for session_id and return the new state."""
    if session_id in _pinned_sessions:
        _pinned_sessions.remove(session_id)
        return False
    _pinned_sessions.add(session_id)
    return True


def toggle_star(session_id: str) -> bool:
    """Toggle favorite state for session_id and return the new state."""
    if session_id in _starred_sessions:
        _starred_sessions.remove(session_id)
        return False
    _starred_sessions.add(session_id)
    return True


def _patch_app() -> None:
    try:
        from rich.text import Text
        from textual.binding import Binding

        import agents_view.app as app_mod
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_session_pinning_feature_enabled", False):
        return

    load_pins()

    original_matches_filter = AgentsViewApp._matches_filter
    original_compute_ordered_keys = AgentsViewApp._compute_ordered_keys
    original_session_cell = AgentsViewApp._session_cell

    sort_sessions = getattr(app_mod, "_sorted_sessions", None)
    project_root_for = getattr(app_mod, "_project_root_for", None)

    def _action_toggle_pin(self: AgentsViewApp) -> None:
        session = self._current_session()
        if session is None:
            self.notify("No session selected", severity="information")
            return
        new_state = toggle_pin(session.session_id)
        save_pins()
        message = f"📌 Pinned: {session.display_title}" if new_state else f"Unpinned: {session.display_title}"
        self.notify(message)
        self._update_table()

    def _action_toggle_star(self: AgentsViewApp) -> None:
        session = self._current_session()
        if session is None:
            self.notify("No session selected", severity="information")
            return
        new_state = toggle_star(session.session_id)
        save_favorites()
        message = f"★ Starred: {session.display_title}" if new_state else f"Unstarred: {session.display_title}"
        self.notify(message)
        self._update_table()

    def _matches_filter_with_star(self: AgentsViewApp, session: Any, ft: str) -> bool:
        needle = (ft or "").strip().lower()
        if needle in {"#starred", "#favorite", "#favorites"}:
            return is_starred(session.session_id)
        return original_matches_filter(self, session, ft)

    def _priority_bucket(session: Any, visible_inactive: bool) -> int:
        status = str(getattr(session, "status", "") or "").lower()
        state = str(getattr(session, "state", "") or "")
        if state == "active" and status not in _IDLE_DONE_STATUSES:
            return 1
        if state != "active" and not visible_inactive:
            return 3
        return 2

    def _compute_ordered_keys_with_pins(self: AgentsViewApp, sessions: list[Any]) -> list[str]:
        if not any(is_pinned(getattr(session, "session_id", "")) for session in sessions):
            return original_compute_ordered_keys(self, sessions)
        if self._pivot_mode or not callable(sort_sessions):
            base_keys = original_compute_ordered_keys(self, sessions)
            pinned_keys = [
                key
                for key in base_keys
                if not app_mod._is_separator_key(key) and is_pinned(key)
            ]
            if not pinned_keys:
                return base_keys
            remainder = [
                key
                for key in base_keys
                if app_mod._is_separator_key(key) or key not in set(pinned_keys)
            ]
            return pinned_keys + remainder

        filter_text = (self._filter_text or "").lower()
        filtered = [
            session
            for session in sessions
            if (session.state == "active" or session.title)
            and self._matches_filter(session, filter_text)
        ]

        if (
            not self._pivot_mode
            and self._active_project_root is not None
            and callable(project_root_for)
        ):
            filtered = [
                session
                for session in filtered
                if project_root_for(session.cwd, self.scope_root) == self._active_project_root
            ]

        now_ts = time.time()
        pinned: list[Any] = []
        active: list[Any] = []
        idle_done: list[Any] = []
        archived: list[Any] = []

        for session in filtered:
            session_id = session.session_id
            if session_id in self._dismissed_active_session_ids and session.state == "active":
                continue

            if is_pinned(session_id):
                pinned.append(session)
                continue

            visible_inactive = True
            if session.state != "active":
                visible_inactive = self._is_visible_inactive_session(session, now_ts)

            bucket = _priority_bucket(session, visible_inactive)
            if bucket == 1:
                active.append(session)
            elif bucket == 2:
                idle_done.append(session)
            else:
                archived.append(session)

        pinned_sorted = sort_sessions(pinned, self._sort_key, self._sort_reverse)
        active_sorted = sort_sessions(active, self._sort_key, self._sort_reverse)
        idle_done_sorted = sort_sessions(idle_done, self._sort_key, self._sort_reverse)
        archived_sorted = sort_sessions(archived, self._sort_key, self._sort_reverse)

        return [
            session.session_id
            for session in (
                pinned_sorted + active_sorted + idle_done_sorted + archived_sorted
            )
        ]

    def _session_cell_with_pin(self: AgentsViewApp, session: Any) -> Text:
        cell = original_session_cell(self, session)
        prefix = Text()
        if is_pinned(session.session_id):
            prefix.append("▲ ", style="bold #f0883e")
        if is_starred(session.session_id) and not cell.plain.startswith("★ "):
            prefix.append("★ ", style="bold #d4a72c")
        if prefix.plain:
            prefix.append_text(cell)
            return prefix
        return cell

    AgentsViewApp.action_toggle_pin = _action_toggle_pin  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.action_toggle_star = _action_toggle_star  # type: ignore[attr-defined,method-assign]
    AgentsViewApp._matches_filter = _matches_filter_with_star  # type: ignore[assignment,method-assign]
    AgentsViewApp._compute_ordered_keys = _compute_ordered_keys_with_pins  # type: ignore[method-assign]
    AgentsViewApp._session_cell = _session_cell_with_pin  # type: ignore[assignment,method-assign]

    bindings = list(AgentsViewApp.BINDINGS)
    upserts = {
        "!": Binding("!", "toggle_pin", "Pin session"),
        "*": Binding("*", "toggle_star", "Star session"),
    }
    for key, binding in upserts.items():
        idx = next(
            (
                index
                for index, existing in enumerate(bindings)
                if getattr(existing, "key", None) == key
            ),
            None,
        )
        if idx is None:
            bindings.append(binding)
        else:
            bindings[idx] = binding
    AgentsViewApp.BINDINGS = bindings

    for help_entry in (("Session", "!", "Pin to top"), ("Session", "*", "Star/favorite")):
        if help_entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(help_entry)

    setattr(AgentsViewApp, "_session_pinning_feature_enabled", True)


_patch_app()

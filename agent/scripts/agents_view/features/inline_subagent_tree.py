"""inline_subagent_tree.py - Expand/collapse subagent hierarchy in session table."""
from __future__ import annotations

from typing import Any

_AUTO_EXPAND_ORCHESTRATORS = True
_IDLE_OR_DONE_STATUSES = {"idle", "done", "offline", "unknown"}

_expanded_orchestrators: set[str] = set()
_auto_initialized_orchestrators: set[str] = set()


class _SessionDisplayProxy:
    """Proxy overriding display_title while delegating all other attributes."""

    def __init__(self, session: Any, display_title: str) -> None:
        self._session = session
        self.display_title = display_title

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)


def _session_title(session: Any) -> str:
    title = str(getattr(session, "display_title", "") or "").strip()
    if title:
        return title
    fallback = str(getattr(session, "title", "") or "").strip()
    if fallback:
        return fallback
    session_id = str(getattr(session, "session_id", "") or "")
    return session_id[:12] if session_id else "untitled"


def _child_ids(session: Any) -> list[str]:
    raw = getattr(session, "child_session_ids", None)
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if isinstance(item, str) and item]


def _is_running(session: Any) -> bool:
    if str(getattr(session, "state", "") or "") != "active":
        return False
    status = str(getattr(session, "status", "") or "").lower().strip()
    if not status:
        return True
    return status not in _IDLE_OR_DONE_STATUSES


def _running_child_count(session: Any, sessions_map: dict[str, Any]) -> int:
    running = 0
    for child_id in _child_ids(session):
        child = sessions_map.get(child_id)
        if child is not None and _is_running(child):
            running += 1
    return running


def _is_orchestrator_row(session: Any) -> bool:
    return not bool(getattr(session, "parent_session_id", None)) and bool(_child_ids(session))


def _ensure_auto_expansion(ordered_ids: list[str], sessions_map: dict[str, Any]) -> None:
    for session_id in ordered_ids:
        session = sessions_map.get(session_id)
        if session is None:
            continue
        if bool(getattr(session, "parent_session_id", None)):
            continue
        if not _child_ids(session):
            continue
        if session_id in _auto_initialized_orchestrators:
            continue
        _auto_initialized_orchestrators.add(session_id)
        if _AUTO_EXPAND_ORCHESTRATORS:
            _expanded_orchestrators.add(session_id)


def get_tree_title(session: Any, sessions_map: dict[str, Any]) -> str:
    """Return display title with tree indicators and count badge."""
    title = _session_title(session)
    children = _child_ids(session)
    is_child = bool(getattr(session, "parent_session_id", None))

    if children and not is_child:
        expanded = str(getattr(session, "session_id", "") or "") in _expanded_orchestrators
        icon = "▼" if expanded else "▶"
        running = _running_child_count(session, sessions_map)
        suffix = ""
        if running > 0:
            suffix = f"({running} running)"
        elif not expanded:
            suffix = f"({len(children)})"
        if suffix:
            return f"{icon} {title} {suffix}"
        return f"{icon} {title}"

    if is_child:
        return f"  └─ {title}"

    return title


def get_ordered_sessions(sessions: list[Any], ordered_ids: list[str] | None = None) -> list[Any]:
    """Return sessions in tree order (parent first, expanded children beneath)."""
    sessions_map = {
        str(getattr(session, "session_id", "")): session
        for session in sessions
        if getattr(session, "session_id", None)
    }
    if ordered_ids is None:
        ordered_ids = [
            str(getattr(session, "session_id", ""))
            for session in sessions
            if getattr(session, "session_id", None)
        ]

    _ensure_auto_expansion(ordered_ids, sessions_map)

    visible_ids = [session_id for session_id in ordered_ids if session_id in sessions_map]
    visible_id_set = set(visible_ids)
    result_ids: list[str] = []
    processed: set[str] = set()

    for session_id in visible_ids:
        if session_id in processed:
            continue
        session = sessions_map.get(session_id)
        if session is None:
            continue
        if bool(getattr(session, "parent_session_id", None)):
            continue

        result_ids.append(session_id)
        processed.add(session_id)

        if session_id not in _expanded_orchestrators:
            continue

        for child_id in _child_ids(session):
            if child_id in visible_id_set and child_id not in processed:
                result_ids.append(child_id)
                processed.add(child_id)

    for session_id in visible_ids:
        if session_id not in processed:
            result_ids.append(session_id)
            processed.add(session_id)

    return [sessions_map[session_id] for session_id in result_ids if session_id in sessions_map]


def _patch_app() -> None:
    try:
        from textual.binding import Binding

        import agents_view.app as app_mod
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_inline_subagent_tree_feature_enabled", False):
        return

    original_compute_ordered_keys = AgentsViewApp._compute_ordered_keys
    original_session_cell = AgentsViewApp._session_cell
    is_separator_key = getattr(app_mod, "_is_separator_key", lambda key: str(key).startswith("__sep__"))

    def _reorder_chunk(chunk: list[str], sessions_map: dict[str, Any], sessions: list[Any]) -> list[str]:
        ordered = get_ordered_sessions(sessions, chunk)
        ordered_ids = [
            str(getattr(session, "session_id", ""))
            for session in ordered
            if getattr(session, "session_id", None)
        ]
        seen = set(ordered_ids)
        ordered_ids.extend([session_id for session_id in chunk if session_id not in seen])
        return ordered_ids

    def _compute_ordered_keys_with_inline_tree(
        self: "AgentsViewApp", sessions: list[Any]
    ) -> list[str]:
        base_keys = original_compute_ordered_keys(self, sessions)

        if getattr(self, "_pivot_mode", False):
            return base_keys

        sessions_map = {
            str(getattr(session, "session_id", "")): session
            for session in sessions
            if getattr(session, "session_id", None)
        }

        rebuilt: list[str] = []
        chunk: list[str] = []
        for key in base_keys:
            if is_separator_key(key):
                if chunk:
                    rebuilt.extend(_reorder_chunk(chunk, sessions_map, sessions))
                    chunk = []
                rebuilt.append(key)
            else:
                chunk.append(key)
        if chunk:
            rebuilt.extend(_reorder_chunk(chunk, sessions_map, sessions))

        return rebuilt

    def _session_cell_with_inline_tree(self: "AgentsViewApp", session: Any):
        sessions_map = getattr(self, "_session_map", None)
        if not isinstance(sessions_map, dict) or not sessions_map:
            current_sessions = getattr(self, "_sessions", [])
            sessions_map = {
                str(getattr(item, "session_id", "")): item
                for item in current_sessions
                if getattr(item, "session_id", None)
            }

        display_title = get_tree_title(session, sessions_map)
        proxied = _SessionDisplayProxy(session, display_title)
        return original_session_cell(self, proxied)

    def _action_toggle_tree(self: "AgentsViewApp") -> None:
        session = self._current_session()
        if session is None or not _is_orchestrator_row(session):
            return

        session_id = str(getattr(session, "session_id", "") or "")
        if not session_id:
            return

        if session_id in _expanded_orchestrators:
            _expanded_orchestrators.discard(session_id)
        else:
            _expanded_orchestrators.add(session_id)
            _auto_initialized_orchestrators.add(session_id)

        self._selected_session = session
        self._update_table()

    def _action_expand_all_trees(self: "AgentsViewApp") -> None:
        sessions = getattr(self, "_sessions", [])
        for session in sessions:
            if not _is_orchestrator_row(session):
                continue
            session_id = str(getattr(session, "session_id", "") or "")
            if session_id:
                _expanded_orchestrators.add(session_id)
                _auto_initialized_orchestrators.add(session_id)
        self._update_table()

    def _action_collapse_all_trees(self: "AgentsViewApp") -> None:
        _expanded_orchestrators.clear()
        self._update_table()

    AgentsViewApp._expanded_orchestrators = _expanded_orchestrators
    AgentsViewApp._get_tree_ordered_sessions = staticmethod(get_ordered_sessions)
    AgentsViewApp._get_tree_title = staticmethod(get_tree_title)

    AgentsViewApp._compute_ordered_keys = _compute_ordered_keys_with_inline_tree  # type: ignore[assignment,method-assign]
    AgentsViewApp._session_cell = _session_cell_with_inline_tree  # type: ignore[assignment,method-assign]
    AgentsViewApp.action_toggle_tree = _action_toggle_tree  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.action_expand_all_trees = _action_expand_all_trees  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.action_collapse_all_trees = _action_collapse_all_trees  # type: ignore[attr-defined,method-assign]

    bindings = list(AgentsViewApp.BINDINGS)
    desired_bindings = [
        Binding("+", "toggle_tree", "Toggle subagent tree", show=False),
        Binding("=", "toggle_tree", "Toggle subagent tree", show=False),
        Binding("ctrl+plus", "expand_all_trees", "Expand all trees", show=False),
        Binding("ctrl+=", "expand_all_trees", "Expand all trees", show=False),
        Binding("ctrl+minus", "collapse_all_trees", "Collapse all trees", show=False),
        Binding("ctrl+-", "collapse_all_trees", "Collapse all trees", show=False),
    ]
    for binding in desired_bindings:
        index = next(
            (
                idx
                for idx, existing in enumerate(bindings)
                if getattr(existing, "key", None) == getattr(binding, "key", None)
            ),
            None,
        )
        if index is None:
            bindings.append(binding)
        else:
            bindings[index] = binding
    AgentsViewApp.BINDINGS = bindings

    for help_entry in (
        ("Session", "+ / =", "Toggle subagent tree"),
        ("Session", "Ctrl++", "Expand all subagent trees"),
        ("Session", "Ctrl+-", "Collapse all subagent trees"),
    ):
        if help_entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(help_entry)

    setattr(AgentsViewApp, "_inline_subagent_tree_feature_enabled", True)


_patch_app()

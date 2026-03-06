"""enhanced_input.py - Enhanced input handling with history and readline keybindings."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from rich.text import Text

_INPUT_CHAR_LIMIT = 0
_INPUT_WARNING_THRESHOLD = 1500
_AT_TRIGGER_RE = re.compile(r"@([\w./\-]*)$")
_AT_MAX_RESULTS = 20
_HISTORY_CONTEXT_GLOBAL = "__global__"
_LABEL_UPDATE_TIMER: dict[int, Any] = {}
_LABEL_UPDATE_CONTEXT: dict[int, tuple[Any, Any]] = {}
_LABEL_DEBOUNCE_SECONDS = 0.08

def _dedupe_recent(entries: list[str], cap: int) -> list[str]:
    """Return oldest→newest entries, removing duplicates by latest occurrence."""
    seen: set[str] = set()
    deduped_reversed: list[str] = []
    for entry in reversed(entries):
        command = entry.strip()
        if not command or command in seen:
            continue
        seen.add(command)
        deduped_reversed.append(command)
    deduped = list(reversed(deduped_reversed))
    if len(deduped) > cap:
        return deduped[-cap:]
    return deduped


def _is_session_input_focused(app: Any) -> bool:
    try:
        focused = app.focused
    except Exception:
        return False
    return bool(focused and getattr(focused, "id", None) == "session-input")


def _ensure_state(app: Any, history_cap: int) -> None:
    if not hasattr(app, "_enhanced_history_state"):
        app._enhanced_history_state = {}
    if not hasattr(app, "_enhanced_global_input_history"):
        app._enhanced_global_input_history = []
    if not hasattr(app, "_enhanced_internal_input_update"):
        app._enhanced_internal_input_update = False
    if not hasattr(app, "_enhanced_multiline_extra_lines"):
        app._enhanced_multiline_extra_lines = 0
    if not hasattr(app, "_enhanced_multiline_signature"):
        app._enhanced_multiline_signature = ""
    if not hasattr(app, "_enhanced_history_cap"):
        app._enhanced_history_cap = history_cap
    if not hasattr(app, "_at_completion_visible"):
        app._at_completion_visible = False
    if not hasattr(app, "_at_completion_matches"):
        app._at_completion_matches = []
    if not hasattr(app, "_at_completion_selected_idx"):
        app._at_completion_selected_idx = 0
    if not hasattr(app, "_at_completion_span"):
        app._at_completion_span = None


def _rebuild_global_history(app: Any, history_cap: int) -> None:
    entries: list[str] = []
    histories = getattr(app, "_input_history", {})
    if isinstance(histories, dict):
        for history in histories.values():
            if isinstance(history, list):
                entries.extend(str(item) for item in history if isinstance(item, str) and item.strip())
    app._enhanced_global_input_history = _dedupe_recent(entries, history_cap)


def _context_key(app: Any) -> str:
    session = getattr(app, "_selected_session", None)
    if session is None:
        return _HISTORY_CONTEXT_GLOBAL
    session_id = getattr(session, "session_id", "")
    if isinstance(session_id, str) and session_id:
        return session_id
    return _HISTORY_CONTEXT_GLOBAL


def _history_for_context(app: Any, context_key: str, history_cap: int) -> list[str]:
    _ensure_state(app, history_cap)
    global_hist = getattr(app, "_enhanced_global_input_history", [])
    if not isinstance(global_hist, list) or not global_hist:
        _rebuild_global_history(app, history_cap)
        global_hist = getattr(app, "_enhanced_global_input_history", [])

    if context_key == _HISTORY_CONTEXT_GLOBAL:
        return list(global_hist)

    per_session = []
    histories = getattr(app, "_input_history", {})
    if isinstance(histories, dict):
        raw_session_history = histories.get(context_key, [])
        if isinstance(raw_session_history, list):
            per_session = [
                str(item)
                for item in raw_session_history
                if isinstance(item, str) and item.strip()
            ]

    return _dedupe_recent([*global_hist, *per_session], history_cap)


def _set_input_value(app: Any, input_widget: Any, value: str) -> None:
    app._enhanced_internal_input_update = True
    input_widget.value = value
    if hasattr(input_widget, "cursor_position"):
        input_widget.cursor_position = len(value)


def _schedule_label_update(app: Any, input_widget: Any, static_cls: Any) -> None:
    """Debounce label updates to avoid re-rendering on every keystroke."""
    app_key = id(app)
    _LABEL_UPDATE_CONTEXT[app_key] = (input_widget, static_cls)
    existing = _LABEL_UPDATE_TIMER.get(app_key)
    if existing is not None:
        try:
            stop = getattr(existing, "stop", None)
            if callable(stop):
                stop()
            else:
                cancel = getattr(existing, "cancel", None)
                if callable(cancel):
                    cancel()
        except Exception:
            pass
    handle = app.set_timer(_LABEL_DEBOUNCE_SECONDS, lambda: _do_label_update(app))
    _LABEL_UPDATE_TIMER[app_key] = handle


def _do_label_update(app: Any) -> None:
    app_key = id(app)
    _LABEL_UPDATE_TIMER.pop(app_key, None)
    context = _LABEL_UPDATE_CONTEXT.pop(app_key, None)
    if context is None:
        return
    input_widget, static_cls = context
    _render_input_mode_label(app, input_widget, static_cls)

def _hide_at_completion_popup(app: Any) -> None:
    app._at_completion_visible = False
    app._at_completion_matches = []
    app._at_completion_selected_idx = 0
    app._at_completion_span = None
    if bool(getattr(app, "_slash_popup_visible", False)):
        return
    try:
        popup = app.query_one("#slash-command-popup")
        popup.update("")
        popup.remove_class("visible")
    except Exception:
        pass


def _render_at_completion_popup(app: Any) -> None:
    matches = list(getattr(app, "_at_completion_matches", []))
    if not matches:
        _hide_at_completion_popup(app)
        return

    try:
        popup = app.query_one("#slash-command-popup")
    except Exception:
        return

    hide_slash = getattr(app, "_hide_slash_command_popup", None)
    if callable(hide_slash):
        hide_slash()

    selected_idx = int(getattr(app, "_at_completion_selected_idx", 0) or 0)
    selected_idx = max(0, min(selected_idx, len(matches) - 1))
    app._at_completion_selected_idx = selected_idx

    text = Text()
    for idx, candidate in enumerate(matches[:6]):
        if idx:
            text.append("\n")
        if idx == selected_idx:
            text.append("▶ ", style="bold #58a6ff")
            text.append(candidate, style="bold #cdd9e5")
        else:
            text.append("  ", style="#636e7b")
            text.append(candidate, style="#adbac7")

    popup.update(text)
    popup.add_class("visible")
    app._at_completion_visible = True


def _collect_at_completion_matches(cwd: str, partial: str, limit: int) -> list[str]:
    base_dir = Path(cwd).expanduser()
    if not base_dir.exists() or not base_dir.is_dir():
        return []

    if partial.startswith("~") or partial.startswith("/"):
        partial_path = Path(partial).expanduser()
    else:
        partial_path = base_dir / partial

    if partial.endswith("/"):
        parent_dir = partial_path
        name_prefix = ""
    else:
        parent_dir = partial_path.parent
        name_prefix = partial_path.name

    try:
        entries = sorted(
            parent_dir.iterdir(),
            key=lambda path: (not path.is_dir(), path.name.lower()),
        )
    except Exception:
        return []

    matches: list[str] = []
    lowered_prefix = name_prefix.lower()
    for entry in entries:
        if lowered_prefix and not entry.name.lower().startswith(lowered_prefix):
            continue
        candidate = str(entry.resolve())
        if entry.is_dir():
            candidate = f"{candidate}/"
        matches.append(candidate)
        if len(matches) >= limit:
            break
    return matches


def _update_at_completion_popup(app: Any, input_widget: Any) -> None:
    value = str(getattr(input_widget, "value", ""))
    if value.startswith("/"):
        _hide_at_completion_popup(app)
        return

    cursor_pos = int(getattr(input_widget, "cursor_position", len(value)))
    cursor_pos = max(0, min(cursor_pos, len(value)))
    match = _AT_TRIGGER_RE.search(value[:cursor_pos])
    if match is None:
        _hide_at_completion_popup(app)
        return

    partial = str(match.group(1) or "")
    session = getattr(app, "_selected_session", None)
    cwd = str(getattr(session, "cwd", "") or getattr(app, "scope_root", "") or os.getcwd())
    matches = _collect_at_completion_matches(cwd, partial, _AT_MAX_RESULTS)
    if not matches:
        _hide_at_completion_popup(app)
        return

    span = (match.start(1), cursor_pos)
    if matches != getattr(app, "_at_completion_matches", []) or span != getattr(app, "_at_completion_span", None):
        app._at_completion_selected_idx = 0
    app._at_completion_matches = matches
    app._at_completion_span = span
    _render_at_completion_popup(app)


def _apply_selected_at_completion(app: Any, input_widget: Any) -> bool:
    matches = list(getattr(app, "_at_completion_matches", []))
    if not matches:
        _hide_at_completion_popup(app)
        return False

    idx = int(getattr(app, "_at_completion_selected_idx", 0) or 0)
    idx = max(0, min(idx, len(matches) - 1))
    selected = matches[idx]

    span = getattr(app, "_at_completion_span", None)
    if not (isinstance(span, tuple) and len(span) == 2):
        _hide_at_completion_popup(app)
        return False

    start, end = span
    if not isinstance(start, int) or not isinstance(end, int):
        _hide_at_completion_popup(app)
        return False

    value = str(getattr(input_widget, "value", ""))
    if start < 0 or end < start or end > len(value):
        _hide_at_completion_popup(app)
        return False

    new_value = f"{value[:start]}{selected}{value[end:]}"
    _set_input_value(app, input_widget, new_value)
    if hasattr(input_widget, "cursor_position"):
        input_widget.cursor_position = start + len(selected)
    _hide_at_completion_popup(app)
    return True

def _render_input_mode_label(app: Any, input_widget: Any, static_cls: Any) -> None:
    try:
        input_label = app.query_one("#input-label", static_cls)
    except Exception:
        return

    session = getattr(app, "_selected_session", None)
    if session is None:
        target_markup = "[bold #f85149]SEND TO:[/bold #f85149] [dim](no session selected)[/dim]"
    else:
        title = str(getattr(session, "display_title", "") or getattr(session, "title", "")).strip()
        if not title:
            title = getattr(session, "session_id", "session")
        title = title[:60]
        target_markup = f"[bold #6cb6ff]SEND TO:[/bold #6cb6ff] [#adbac7]{title}[/#adbac7]"

    value = str(getattr(input_widget, "value", ""))
    char_count = len(value)
    count_style = "#d29922" if char_count > _INPUT_WARNING_THRESHOLD else "#636e7b"
    count_markup = f"[{count_style}][{char_count}][/{count_style}]"

    extra_lines = int(getattr(app, "_enhanced_multiline_extra_lines", 0) or 0)
    lines_markup = ""
    if extra_lines > 0:
        lines_markup = f" [#d29922][+{extra_lines} lines][/#d29922]"

    input_label.update(f"{target_markup}  {count_markup}{lines_markup}")


def _reset_history_cursor(app: Any, context_key: str, value: str, history_cap: int) -> None:
    _ensure_state(app, history_cap)
    history_state = getattr(app, "_enhanced_history_state")
    history = _history_for_context(app, context_key, history_cap)
    history_state[context_key] = {
        "idx": len(history),
        "draft": value,
    }


def _navigate_history(app: Any, input_widget: Any, direction: int, history_cap: int) -> bool:
    ctx = _context_key(app)
    history = _history_for_context(app, ctx, history_cap)
    if not history:
        return False

    _ensure_state(app, history_cap)
    history_state = getattr(app, "_enhanced_history_state")
    state = history_state.setdefault(ctx, {"idx": len(history), "draft": ""})

    idx = int(state.get("idx", len(history)))
    if idx < 0:
        idx = 0
    if idx > len(history):
        idx = len(history)

    if direction < 0:
        if idx == len(history):
            state["draft"] = str(getattr(input_widget, "value", ""))
        new_idx = max(0, idx - 1)
    else:
        new_idx = min(len(history), idx + 1)

    if new_idx == len(history):
        next_value = str(state.get("draft", ""))
    else:
        next_value = history[new_idx]

    state["idx"] = new_idx
    history_state[ctx] = state
    _set_input_value(app, input_widget, next_value)
    return True


def _delete_word_before_cursor(value: str, cursor_pos: int) -> tuple[str, int]:
    if cursor_pos <= 0:
        return value, cursor_pos

    left = value[:cursor_pos]
    right = value[cursor_pos:]

    idx = len(left)
    while idx > 0 and left[idx - 1].isspace():
        idx -= 1
    while idx > 0 and not left[idx - 1].isspace():
        idx -= 1

    return left[:idx] + right, idx


def _move_cursor_word_backward(value: str, cursor_pos: int) -> int:
    idx = max(0, min(cursor_pos, len(value)))
    while idx > 0 and value[idx - 1].isspace():
        idx -= 1
    while idx > 0 and not value[idx - 1].isspace():
        idx -= 1
    return idx


def _move_cursor_word_forward(value: str, cursor_pos: int) -> int:
    idx = max(0, min(cursor_pos, len(value)))
    while idx < len(value) and value[idx].isspace():
        idx += 1
    while idx < len(value) and not value[idx].isspace():
        idx += 1
    return idx


def _patch_app() -> None:
    try:
        from textual.widgets import Input, Static

        from agents_view import app as app_module
        from agents_view.app import AgentsViewApp, HelpScreen

        history_cap = int(getattr(app_module, "_INPUT_HISTORY_CAP", 200))

        original_on_key = getattr(AgentsViewApp, "on_key", None)
        original_on_input_changed = getattr(AgentsViewApp, "on_input_changed", None)
        original_on_input_submitted = getattr(AgentsViewApp, "on_input_submitted", None)
        original_on_row_highlighted = getattr(AgentsViewApp, "on_data_table_row_highlighted", None)
        original_action_select_session = getattr(AgentsViewApp, "action_select_session", None)
        original_clear_tag_mode = getattr(AgentsViewApp, "_clear_tag_input_mode", None)
        original_push_input_history = getattr(AgentsViewApp, "_push_input_history", None)

        def _enhanced_on_key(self: Any, event: Any) -> None:
            key = str(getattr(event, "key", ""))
            if _is_session_input_focused(self):
                try:
                    input_widget = self.query_one("#session-input", Input)
                except Exception:
                    input_widget = None

                if input_widget is not None:
                    if key in {"up", "down"} and bool(getattr(self, "_at_completion_visible", False)) and getattr(
                        self,
                        "_at_completion_matches",
                        [],
                    ):
                        delta = -1 if key == "up" else 1
                        matches = list(getattr(self, "_at_completion_matches", []))
                        if matches:
                            self._at_completion_selected_idx = (
                                int(getattr(self, "_at_completion_selected_idx", 0) or 0) + delta
                            ) % len(matches)
                            _render_at_completion_popup(self)
                        event.prevent_default()
                        event.stop()
                        return

                    if key in {"up", "down", "ctrl+p", "ctrl+n"}:
                        if key in {"up", "down"} and getattr(self, "_slash_popup_visible", False) and getattr(self, "_slash_matches", []):
                            if callable(original_on_key):
                                original_on_key(self, event)
                            return

                        direction = -1 if key in {"up", "ctrl+p"} else 1
                        if _navigate_history(self, input_widget, direction, history_cap) or key in {"ctrl+p", "ctrl+n"}:
                            _render_input_mode_label(self, input_widget, Static)
                            event.prevent_default()
                            event.stop()
                            return

                    if key in {"enter", "tab"} and bool(getattr(self, "_at_completion_visible", False)):
                        if _apply_selected_at_completion(self, input_widget):
                            _schedule_label_update(self, input_widget, Static)
                            event.prevent_default()
                            event.stop()
                            return

                    if key == "escape" and bool(getattr(self, "_at_completion_visible", False)):
                        _hide_at_completion_popup(self)
                        event.prevent_default()
                        event.stop()
                        return

                    if key == "ctrl+a":
                        if hasattr(input_widget, "cursor_position"):
                            input_widget.cursor_position = 0
                        event.prevent_default()
                        event.stop()
                        return

                    if key == "ctrl+e":
                        if hasattr(input_widget, "cursor_position"):
                            input_widget.cursor_position = len(input_widget.value)
                        event.prevent_default()
                        event.stop()
                        return

                    if key == "ctrl+k":
                        cursor_pos = int(getattr(input_widget, "cursor_position", len(input_widget.value)))
                        value = str(input_widget.value)
                        if cursor_pos < len(value):
                            _set_input_value(self, input_widget, value[:cursor_pos])
                            if hasattr(input_widget, "cursor_position"):
                                input_widget.cursor_position = cursor_pos
                            _render_input_mode_label(self, input_widget, Static)
                        event.prevent_default()
                        event.stop()
                        return

                    if key == "ctrl+u":
                        if str(input_widget.value):
                            _set_input_value(self, input_widget, "")
                            self._enhanced_multiline_extra_lines = 0
                            self._enhanced_multiline_signature = ""
                            _render_input_mode_label(self, input_widget, Static)
                        event.prevent_default()
                        event.stop()
                        return

                    if key == "ctrl+w":
                        cursor_pos = int(getattr(input_widget, "cursor_position", len(input_widget.value)))
                        new_value, new_cursor = _delete_word_before_cursor(str(input_widget.value), cursor_pos)
                        if new_value != input_widget.value:
                            _set_input_value(self, input_widget, new_value)
                            if hasattr(input_widget, "cursor_position"):
                                input_widget.cursor_position = new_cursor
                            _render_input_mode_label(self, input_widget, Static)
                        event.prevent_default()
                        event.stop()
                        return

                    if key in {"alt+f", "meta+f"}:
                        if hasattr(input_widget, "cursor_position"):
                            input_widget.cursor_position = _move_cursor_word_forward(
                                str(input_widget.value),
                                int(getattr(input_widget, "cursor_position", len(input_widget.value))),
                            )
                        event.prevent_default()
                        event.stop()
                        return

                    if key in {"alt+b", "meta+b"}:
                        if hasattr(input_widget, "cursor_position"):
                            input_widget.cursor_position = _move_cursor_word_backward(
                                str(input_widget.value),
                                int(getattr(input_widget, "cursor_position", len(input_widget.value))),
                            )
                        event.prevent_default()
                        event.stop()
                        return

            if callable(original_on_key):
                original_on_key(self, event)

        def _enhanced_on_input_changed(self: Any, event: Any) -> None:
            if callable(original_on_input_changed):
                original_on_input_changed(self, event)

            if getattr(event.input, "id", None) != "session-input":
                return

            _ensure_state(self, history_cap)
            if bool(getattr(self, "_enhanced_internal_input_update", False)):
                self._enhanced_internal_input_update = False
                _schedule_label_update(self, event.input, Static)
                return

            value = str(getattr(event.input, "value", ""))
            if "\n" in value:
                lines = value.splitlines()
                normalized = "\\n".join(lines)
                if normalized != value:
                    self._enhanced_multiline_extra_lines = max(len(lines) - 1, 0)
                    self._enhanced_multiline_signature = normalized
                    _set_input_value(self, event.input, normalized)
                    if hasattr(self, "_update_slash_command_popup"):
                        self._update_slash_command_popup(normalized)
                    _hide_at_completion_popup(self)
                    _schedule_label_update(self, event.input, Static)
                    return
            else:
                signature = str(getattr(self, "_enhanced_multiline_signature", ""))
                if signature and value != signature:
                    self._enhanced_multiline_signature = ""
                    self._enhanced_multiline_extra_lines = 0

            _reset_history_cursor(self, _context_key(self), value, history_cap)
            _update_at_completion_popup(self, event.input)
            _schedule_label_update(self, event.input, Static)

        def _enhanced_on_input_submitted(self: Any, event: Any) -> None:
            target_is_session_input = getattr(event.input, "id", None) == "session-input"
            if target_is_session_input and bool(getattr(self, "_at_completion_visible", False)) and getattr(
                self,
                "_at_completion_matches",
                [],
            ):
                try:
                    input_widget = self.query_one("#session-input", Input)
                except Exception:
                    input_widget = None
                if input_widget is not None and _apply_selected_at_completion(self, input_widget):
                    _schedule_label_update(self, input_widget, Static)
                    return

            if callable(original_on_input_submitted):
                original_on_input_submitted(self, event)

            if not target_is_session_input:
                return

            _hide_at_completion_popup(self)
            _ensure_state(self, history_cap)
            self._enhanced_multiline_extra_lines = 0
            self._enhanced_multiline_signature = ""

            try:
                input_widget = self.query_one("#session-input", Input)
            except Exception:
                return

            _reset_history_cursor(self, _context_key(self), str(getattr(input_widget, "value", "")), history_cap)
            _render_input_mode_label(self, input_widget, Static)

        def _enhanced_on_row_highlighted(self: Any, event: Any) -> None:
            if callable(original_on_row_highlighted):
                original_on_row_highlighted(self, event)
            try:
                input_widget = self.query_one("#session-input", Input)
            except Exception:
                return
            _render_input_mode_label(self, input_widget, Static)

        def _enhanced_action_select_session(self: Any) -> None:
            if callable(original_action_select_session):
                original_action_select_session(self)
            try:
                input_widget = self.query_one("#session-input", Input)
            except Exception:
                return
            _render_input_mode_label(self, input_widget, Static)
            _hide_at_completion_popup(self)

        def _enhanced_clear_tag_input_mode(self: Any) -> None:
            if callable(original_clear_tag_mode):
                original_clear_tag_mode(self)
            try:
                input_widget = self.query_one("#session-input", Input)
            except Exception:
                return
            _render_input_mode_label(self, input_widget, Static)

        def _enhanced_push_input_history(self: Any, session_id: str, text: str) -> None:
            if callable(original_push_input_history):
                original_push_input_history(self, session_id, text)

            command = str(text).strip()
            if not command:
                return

            _ensure_state(self, history_cap)
            global_history = list(getattr(self, "_enhanced_global_input_history", []))
            global_history = _dedupe_recent([*global_history, command], history_cap)
            self._enhanced_global_input_history = global_history
            _reset_history_cursor(self, _context_key(self), "", history_cap)

        AgentsViewApp.on_key = _enhanced_on_key  # type: ignore[method-assign]
        AgentsViewApp.on_input_changed = _enhanced_on_input_changed  # type: ignore[method-assign]
        AgentsViewApp.on_input_submitted = _enhanced_on_input_submitted  # type: ignore[method-assign]
        AgentsViewApp.on_data_table_row_highlighted = _enhanced_on_row_highlighted  # type: ignore[method-assign]
        AgentsViewApp.action_select_session = _enhanced_action_select_session  # type: ignore[method-assign]
        AgentsViewApp._clear_tag_input_mode = _enhanced_clear_tag_input_mode  # type: ignore[method-assign]
        AgentsViewApp._push_input_history = _enhanced_push_input_history  # type: ignore[method-assign]


        if ("Input", "↑/↓, Ctrl+P/N", "History navigation") not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(("Input", "↑/↓, Ctrl+P/N", "History navigation"))
        if ("Input", "Ctrl+A/E", "Start/end of line") not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(("Input", "Ctrl+A/E", "Start/end of line"))
        if ("Input", "Ctrl+K/U/W", "Kill to end, clear line, delete word") not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(("Input", "Ctrl+K/U/W", "Kill to end, clear line, delete word"))
        if ("Input", "Alt+F/B", "Move by word") not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(("Input", "Alt+F/B", "Move by word"))

    except Exception:
        pass


_patch_app()

"""quick_actions.py - Quick actions context menu for agent sessions."""

from __future__ import annotations

import importlib
import os
import shlex
import subprocess
from dataclasses import dataclass
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Static


@dataclass(frozen=True)
class QuickAction:
    hotkey: str
    label: str
    action_name: str


class QuickActionsScreen(Screen["str | None"]):
    BINDINGS = [Binding("escape,q", "dismiss", "Close")]

    CSS = """
    QuickActionsScreen {
        align: center middle;
        background: rgba(0,0,0,0.6);
    }

    #qa-container {
        width: 56;
        height: auto;
        max-height: 26;
        border: double #444c56;
        background: #22272e;
        padding: 0;
    }

    #qa-title {
        background: #2d333b;
        color: #6cb6ff;
        padding: 0 1;
        border-bottom: solid #444c56;
    }

    #qa-table {
        height: auto;
        max-height: 21;
    }
    """

    def __init__(self, session: Any) -> None:
        super().__init__()
        self._session = session
        self._actions = self._build_actions()

    def _build_actions(self) -> list[QuickAction]:
        return [
            QuickAction("1", "Jump to session", "jump"),
            QuickAction("2", "Resume / send message", "resume_or_send"),
            QuickAction("3", "Kill session", "kill"),
            QuickAction("4", "Copy session ID", "copy_id"),
            QuickAction("5", "Copy last message", "copy_last_message"),
            QuickAction("6", "Export to Markdown", "export_markdown"),
            QuickAction("7", "View git log", "git_log"),
            QuickAction("8", "View session log", "session_log"),
            QuickAction("9", "Open worktree in terminal", "open_terminal"),
            QuickAction("l", "Set label", "set_label"),
            QuickAction("n", "Set notes", "set_notes"),
            QuickAction("p", "Pin / unpin", "toggle_pin"),
            QuickAction("a", "Archive session", "archive"),
            QuickAction("c", "Compare with another session", "compare"),
        ]

    def compose(self) -> ComposeResult:
        with Vertical(id="qa-container"):
            title = str(getattr(self._session, "title", "") or "Session")[:42]
            yield Static(f"Quick Actions: {title}", id="qa-title")
            yield DataTable(id="qa-table", cursor_type="row", show_header=False)

    def on_mount(self) -> None:
        table = self.query_one("#qa-table", DataTable)
        table.add_columns("Key", "Action")
        for entry in self._actions:
            table.add_row(f"[{entry.hotkey}]", entry.label)
        table.focus()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        row = int(getattr(event, "cursor_row", -1))
        if 0 <= row < len(self._actions):
            self.dismiss(self._actions[row].action_name)

    def on_key(self, event) -> None:
        key = str(getattr(event, "character", "") or "").lower()
        if not key:
            return
        for entry in self._actions:
            if key == entry.hotkey.lower():
                event.stop()
                self.dismiss(entry.action_name)
                return

    def action_dismiss(self) -> None:
        self.dismiss(None)


def _patch_app() -> None:
    try:
        app_mod = importlib.import_module("agents_view.app")
        AgentsViewApp = getattr(app_mod, "AgentsViewApp", None)
        HelpScreen = getattr(app_mod, "HelpScreen", None)
        if AgentsViewApp is None or HelpScreen is None:
            return
    except Exception:
        return

    if getattr(AgentsViewApp, "_quick_actions_feature_patched", False):
        return

    copy_to_clipboard = getattr(app_mod, "_copy_to_clipboard", None)
    extract_last_messages = getattr(app_mod, "_extract_last_user_messages", None)
    extract_session_path = getattr(app_mod, "_extract_session_file_path", None)

    def _selected_session(app: Any) -> Any | None:
        current = getattr(app, "_current_session", None)
        if callable(current):
            try:
                session = current()
                if session is not None:
                    return session
            except Exception:
                pass

        selected = getattr(app, "_selected_session", None)
        if selected is not None:
            return selected

        try:
            table = app.query_one("#session-table", DataTable)
            row = int(getattr(table, "cursor_row", -1))
            ordered_keys = list(getattr(app, "_ordered_keys", []) or [])
            session_map = dict(getattr(app, "_session_map", {}) or {})
            if 0 <= row < len(ordered_keys):
                key = ordered_keys[row]
                return session_map.get(key)
        except Exception:
            pass
        return None

    def _invoke(app: Any, *method_names: str) -> bool:
        for method_name in method_names:
            method = getattr(app, method_name, None)
            if callable(method):
                method()
                return True
        return False

    def _notify(app: Any, message: str, severity: str = "information") -> None:
        notify = getattr(app, "notify", None)
        if callable(notify):
            notify(message, severity=severity)

    def _copy_text(app: Any, text: str, label: str) -> None:
        payload = text.strip()
        if not payload:
            _notify(app, f"{label}: nothing to copy", severity="warning")
            return

        copied = False
        if callable(copy_to_clipboard):
            try:
                copied = bool(copy_to_clipboard(payload))
            except Exception:
                copied = False

        if not copied:
            for cmd in (
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
                ["pbcopy"],
            ):
                try:
                    result = subprocess.run(
                        cmd,
                        input=payload.encode(),
                        capture_output=True,
                        timeout=2,
                        check=False,
                    )
                except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
                    continue
                except Exception:
                    continue
                if result.returncode == 0:
                    copied = True
                    break

        if copied:
            _notify(app, f"Copied {label}")
        else:
            preview = payload[:40]
            suffix = "..." if len(payload) > 40 else ""
            _notify(app, f"Clipboard unavailable ({label}: {preview}{suffix})", severity="warning")

    def _resolve_session_log_path(app: Any, session: Any) -> str | None:
        path_getter = getattr(app, "_session_file_path", None)
        if callable(path_getter):
            try:
                result = path_getter(session)
                if isinstance(result, str) and result.strip():
                    return result.strip()
            except Exception:
                pass

        resume_command = str(getattr(session, "resume_command", "") or "")
        if callable(extract_session_path):
            try:
                result = extract_session_path(resume_command)
            except Exception:
                result = None
            if isinstance(result, str) and result.strip():
                return result.strip()
        return None

    def _dispatch(app: Any, session: Any, action_name: str | None) -> None:
        if not action_name:
            return

        setattr(app, "_selected_session", session)

        try:
            if action_name == "jump":
                if not _invoke(app, "action_select_session", "action_open_session_window"):
                    _notify(app, "Jump action is unavailable", severity="warning")
                return

            if action_name == "resume_or_send":
                if _invoke(app, "action_select_session"):
                    return
                try:
                    input_widget = app.query_one("#session-input")
                    focus = getattr(input_widget, "focus", None)
                    if callable(focus):
                        focus()
                    _notify(app, "Session input focused")
                except Exception:
                    _notify(app, "Resume/send action is unavailable", severity="warning")
                return

            if action_name == "kill":
                if not _invoke(app, "action_kill_session"):
                    _notify(app, "Kill action is unavailable", severity="warning")
                return

            if action_name == "copy_id":
                _copy_text(app, str(getattr(session, "session_id", "") or ""), "session ID")
                return

            if action_name == "copy_last_message":
                log_path = _resolve_session_log_path(app, session)
                if not log_path or not os.path.exists(log_path):
                    _notify(app, "Session log is unavailable", severity="warning")
                    return

                copied_message = ""
                if callable(extract_last_messages):
                    try:
                        tail = extract_last_messages(log_path, n=1)
                        if isinstance(tail, list) and tail:
                            copied_message = str(tail[-1] or "")
                    except Exception:
                        copied_message = ""

                if not copied_message:
                    _notify(app, "No recent message found", severity="warning")
                    return

                _copy_text(app, copied_message, "last message")
                return

            if action_name == "export_markdown":
                if not _invoke(app, "action_export_session", "action_export_sessions"):
                    _notify(app, "Export action is unavailable", severity="warning")
                return

            if action_name == "git_log":
                if not _invoke(app, "action_git_log"):
                    _notify(app, "Git log action is unavailable", severity="warning")
                return

            if action_name == "session_log":
                if not _invoke(app, "action_view_session_log"):
                    _notify(app, "Session log action is unavailable", severity="warning")
                return

            if action_name == "open_terminal":
                cwd = str(getattr(session, "cwd", "") or "").strip()
                tmux = getattr(app, "_tmux", None)
                if cwd and tmux is not None:
                    new_window = getattr(tmux, "new_window", None)
                    current_tmux = getattr(tmux, "get_current_session", lambda: "")() or ""
                    if callable(new_window):
                        shell = os.environ.get("SHELL", "bash")
                        command = f"cd {shlex.quote(cwd)} && exec {shlex.quote(shell)} -i"
                        new_window(command, session=current_tmux, name="worktree")
                        _notify(app, f"Opened terminal in {cwd}")
                        return
                if not _invoke(app, "action_open_worktree_screen", "action_open_session_window"):
                    _notify(app, "Open terminal action is unavailable", severity="warning")
                return

            if action_name == "set_label":
                if not _invoke(app, "action_set_label"):
                    _notify(app, "Set label action is unavailable", severity="warning")
                return

            if action_name == "set_notes":
                if _invoke(app, "action_edit_description"):
                    return
                try:
                    input_widget = app.query_one("#session-input")
                    value = str(getattr(session, "quick_note", "") or "")
                    setattr(input_widget, "value", value)
                    cursor_position = getattr(input_widget, "cursor_position", None)
                    if isinstance(cursor_position, int):
                        setattr(input_widget, "cursor_position", len(value))
                    placeholder = "Set note, then press N to save"
                    setattr(input_widget, "placeholder", placeholder)
                    focus = getattr(input_widget, "focus", None)
                    if callable(focus):
                        focus()
                    _notify(app, "Note editor focused")
                except Exception:
                    _notify(app, "Set notes action is unavailable", severity="warning")
                return

            if action_name == "toggle_pin":
                if not _invoke(app, "action_toggle_pin"):
                    _notify(app, "Pin toggle action is unavailable", severity="warning")
                return

            if action_name == "archive":
                if _invoke(app, "action_mark_done"):
                    _notify(app, "Session archived from active list")
                    return
                if not _invoke(app, "action_open_archive"):
                    _notify(app, "Archive action is unavailable", severity="warning")
                return

            if action_name == "compare":
                if not _invoke(app, "action_select_for_compare"):
                    _notify(app, "Compare action is unavailable", severity="warning")
                return

            _notify(app, f"Unknown quick action: {action_name}", severity="warning")
        except Exception as exc:
            _notify(app, str(exc), severity="error")

    def _action_quick_actions(self: Any) -> None:
        session = _selected_session(self)
        if session is None:
            _notify(self, "No session selected", severity="warning")
            return

        def _on_close(result: str | None) -> None:
            _dispatch(self, session, result)

        self.push_screen(QuickActionsScreen(session), callback=_on_close)

    AgentsViewApp.action_quick_actions = _action_quick_actions  # type: ignore[attr-defined,method-assign]

    existing_keys = {str(getattr(binding, "key", "")).lower() for binding in AgentsViewApp.BINDINGS}
    existing_actions = {
        str(getattr(binding, "action", "")).lower() for binding in AgentsViewApp.BINDINGS
    }

    chosen_key = ""
    if "quick_actions" not in existing_actions:
        for candidate in ("space", "ctrl+space", "q"):
            if candidate not in existing_keys:
                chosen_key = candidate
                break
        if chosen_key:
            AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
                Binding(chosen_key, "quick_actions", "Quick actions", show=False)
            ]

    if chosen_key:
        display_key = {
            "space": "Space",
            "ctrl+space": "Ctrl+Space",
            "q": "Q",
        }.get(chosen_key, chosen_key)
        help_entry = ("Session", display_key, "Quick actions menu")
        if help_entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(help_entry)

    AgentsViewApp._quick_actions_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

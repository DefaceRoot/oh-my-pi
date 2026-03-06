"""session_labels.py - Custom labels and emoji for agent sessions.

Provides:
- Label picker for selected sessions
- Label display as prefix in session table
- Persistence to ~/.omp/agents-view-labels.json
- #label: filter support
"""

from __future__ import annotations

import json
from pathlib import Path

from rich.text import Text
from textual import events
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Input, Static

_LABELS_FILE = Path("~/.omp/agents-view-labels.json").expanduser()
_MAX_LABEL_LEN = 20
_session_labels: dict[str, str] = {}

_COMMON_LABELS = [
    "🔥",
    "⚡",
    "🎯",
    "🐛",
    "✨",
    "📝",
    "🔍",
    "🚀",
    "🔧",
    "💡",
    "⚠️",
    "✅",
]

# Required quick shortcuts mapping (1-9).
_QUICK_LABELS = ["🔥", "⚡", "🎯", "🐛", "✨", "📝", "🔍", "🚀", "✅"]


def _sanitize_label(value: str) -> str:
    collapsed = " ".join(value.strip().split())
    if len(collapsed) > _MAX_LABEL_LEN:
        return collapsed[:_MAX_LABEL_LEN]
    return collapsed


def load_labels() -> None:
    """Load labels from disk with corruption-safe fallback."""
    global _session_labels

    try:
        raw = json.loads(_LABELS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _session_labels = {}
        return
    except Exception:
        _session_labels = {}
        return

    if not isinstance(raw, dict):
        _session_labels = {}
        return

    cleaned: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        label = _sanitize_label(value)
        if label:
            cleaned[key] = label
    _session_labels = cleaned


def save_labels() -> None:
    """Persist labels to disk, silently ignoring IO failures."""
    try:
        _LABELS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LABELS_FILE.write_text(
            json.dumps(_session_labels, ensure_ascii=False, sort_keys=True, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def get_label(session_id: str) -> str:
    return _session_labels.get(session_id, "")


def set_label(session_id: str, label: str) -> None:
    normalized = _sanitize_label(label)
    if normalized:
        _session_labels[session_id] = normalized
    else:
        _session_labels.pop(session_id, None)
    save_labels()


def get_display_title(session_id: str, title: str) -> str:
    """Return title with label prefix for display in the table."""
    label = get_label(session_id)
    if not label:
        return title
    return f"{label} {title}" if title else label


class LabelPickerScreen(Screen):
    """Small popup to assign an emoji or custom text label."""

    BINDINGS = [
        Binding("escape", "dismiss_picker", "Cancel"),
        Binding("ctrl+x", "clear_label", "Clear"),
    ]

    CSS = """
    LabelPickerScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.45);
    }
    #label-dialog {
        width: 72;
        height: auto;
        border: round #444c56;
        background: #2d333b;
        padding: 1 2;
    }
    #label-quick {
        color: #adbac7;
    }
    #label-common {
        color: #768390;
        padding-top: 1;
    }
    #label-help {
        color: #636e7b;
        padding-top: 1;
    }
    """

    def __init__(self, session_id: str, current_label: str = "") -> None:
        super().__init__()
        self._session_id = session_id
        self._current_label = current_label

    def compose(self) -> ComposeResult:
        quick = "  ".join(f"[{idx + 1}] {emoji}" for idx, emoji in enumerate(_QUICK_LABELS))
        common = "  ".join(_COMMON_LABELS)
        with Vertical(id="label-dialog"):
            yield Static(f"Set label (current: {self._current_label or 'none'})")
            yield Static(quick, id="label-quick")
            yield Static(common, id="label-common")
            yield Input(
                value=self._current_label,
                placeholder="Custom label or emoji...",
                id="label-input",
            )
            yield Static("Enter save • 1-9 quick emoji • Ctrl+X clear • Esc cancel", id="label-help")

    def on_mount(self) -> None:
        try:
            self.query_one("#label-input", Input).focus()
        except Exception:
            pass

    def on_input_submitted(self, event: Input.Submitted) -> None:
        value = _sanitize_label(event.value)
        set_label(self._session_id, value)
        self.dismiss(value)

    def action_clear_label(self) -> None:
        set_label(self._session_id, "")
        self.dismiss("")

    def action_dismiss_picker(self) -> None:
        self.dismiss(None)

    def on_key(self, event: events.Key) -> None:
        """Handle 1-9 shortcuts for instant emoji assignment."""
        ch = event.character or ""
        if not ch.isdigit():
            return
        idx = int(ch) - 1
        if not (0 <= idx < len(_QUICK_LABELS)):
            return
        label = _QUICK_LABELS[idx]
        set_label(self._session_id, label)
        event.stop()
        event.prevent_default()
        self.dismiss(label)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_session_labels_feature_patched", False):
        return

    load_labels()

    def _selected_session(self: "AgentsViewApp"):
        current = getattr(self, "_current_session", None)
        if callable(current):
            try:
                resolved = current()
                if resolved is not None:
                    return resolved
            except Exception:
                pass
        return getattr(self, "_selected_session", None)

    def _refresh_after_label_change(self: "AgentsViewApp") -> None:
        try:
            self._update_table()
        except Exception:
            pass
        try:
            self._update_preview()
        except Exception:
            pass

    def _action_set_label(self: "AgentsViewApp") -> None:
        session = _selected_session(self)
        if session is None:
            try:
                self.notify("No session selected", severity="warning")
            except Exception:
                pass
            return

        session_id = str(getattr(session, "session_id", ""))
        if not session_id:
            return

        current_label = get_label(session_id)

        def _handle_label_result(result: str | None) -> None:
            if result is None:
                return
            _refresh_after_label_change(self)

        self.push_screen(LabelPickerScreen(session_id, current_label), callback=_handle_label_result)

    _original_matches_filter = AgentsViewApp._matches_filter

    def _matches_filter_with_labels(self: "AgentsViewApp", s, ft: str) -> bool:
        if ft.startswith("#label:"):
            target = ft.split(":", 1)[1].strip()
            current = get_label(getattr(s, "session_id", "")).strip()
            if not target:
                return bool(current)
            return current.casefold() == target.casefold()
        return _original_matches_filter(self, s, ft)

    def _session_cell_with_labels(self: "AgentsViewApp", s) -> Text:
        title = get_display_title(getattr(s, "session_id", ""), s.display_title)
        if s.session_id in self._broadcast_selected_ids:
            title = f"{title} [B]"
        title = title[:35] if len(title) > 35 else title
        style = "bold #cdd9e5" if s.state == "active" else "#636e7b"
        cell = Text()
        if s.session_id in self._bookmarks:
            cell.append("★ ", style="bold #d4a72c")
        cell.append(title, style=style)
        for tag in s.tags:
            cell.append(f" [{tag}]", style="dim #636e7b")
        return cell

    _original_preview_status_line = AgentsViewApp._preview_status_line

    def _preview_status_line_with_label(self: "AgentsViewApp", s) -> Text:
        line = _original_preview_status_line(self, s)
        label = get_label(getattr(s, "session_id", ""))
        if not label:
            return line
        prefixed = Text()
        prefixed.append("Label: ", style="bold #636e7b")
        prefixed.append(label, style="bold #f0883e")
        if line.plain:
            prefixed.append("   ", style="#444c56")
            prefixed.append_text(line)
        return prefixed

    def _apply_label_to_preview_header(self: "AgentsViewApp") -> None:
        session = getattr(self, "_selected_session", None)
        if session is None:
            return
        label = get_label(getattr(session, "session_id", ""))
        if not label:
            return
        try:
            panel = self.query_one("#right-panel")
        except Exception:
            return
        current_title = str(getattr(panel, "border_title", "") or "").strip()
        if not current_title:
            panel.border_title = label
            return
        prefix = f"{label} "
        if current_title.startswith(prefix):
            return
        panel.border_title = f"{label} {current_title}"

    _original_update_preview = AgentsViewApp._update_preview

    def _update_preview_with_labels(self: "AgentsViewApp") -> None:
        _original_update_preview(self)
        _apply_label_to_preview_header(self)

    _original_apply_worker_preview = AgentsViewApp._apply_worker_preview

    def _apply_worker_preview_with_labels(
        self: "AgentsViewApp",
        session_id: str,
        rendered,
        preview_render_key,
        panel_title: str,
        status_line,
    ) -> None:
        _original_apply_worker_preview(
            self,
            session_id,
            rendered,
            preview_render_key,
            panel_title,
            status_line,
        )
        _apply_label_to_preview_header(self)

    AgentsViewApp.action_set_label = _action_set_label
    AgentsViewApp._matches_filter = _matches_filter_with_labels
    AgentsViewApp._session_cell = _session_cell_with_labels
    AgentsViewApp._preview_status_line = _preview_status_line_with_label
    AgentsViewApp._update_preview = _update_preview_with_labels
    AgentsViewApp._apply_worker_preview = _apply_worker_preview_with_labels

    existing_keys = {getattr(binding, "key", "") for binding in AgentsViewApp.BINDINGS}
    binding_key = "l"
    if binding_key in existing_keys:
        binding_key = "ctrl+l"
    if binding_key in existing_keys:
        binding_key = "ctrl+shift+l"

    if not any(getattr(binding, "action", "") == "set_label" for binding in AgentsViewApp.BINDINGS):
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding(binding_key, "set_label", "Label session")
        ]

    display_key = {
        "l": "l",
        "ctrl+l": "Ctrl+L",
        "ctrl+shift+l": "Ctrl+Shift+L",
    }.get(binding_key, binding_key)

    help_row = ("Session", display_key, "Set label/emoji")
    if help_row not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(help_row)

    label_filter_help = ("Search", "#label:🔥", "Filter sessions by label")
    if label_filter_help not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(label_filter_help)

    setattr(AgentsViewApp, "_session_labels_feature_patched", True)


_patch_app()

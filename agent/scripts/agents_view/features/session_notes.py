"""session_notes.py - Per-session notes and bookmarks."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Input, Static

_NOTES_FILE = Path.home() / ".omp" / "agents-view-notes.json"
_MAX_PREVIEW_LINES = 10
_MIN_SECTION_WIDTH = 34
_MAX_SECTION_WIDTH = 88
_DEFAULT_SECTION_WIDTH = 44

_session_notes: dict[str, dict[str, Any]] = {}


def _normalize_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _normalize_timestamp(value: object) -> float:
    if isinstance(value, (int, float)):
        ts = float(value)
        return ts if ts > 0 else 0.0
    return 0.0


def load_notes() -> None:
    """Load note payload from disk with corruption-safe fallback."""
    global _session_notes

    try:
        raw = json.loads(_NOTES_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _session_notes = {}
        return
    except Exception:
        _session_notes = {}
        return

    if not isinstance(raw, dict):
        _session_notes = {}
        return

    cleaned: dict[str, dict[str, Any]] = {}
    for raw_key, raw_value in raw.items():
        if not isinstance(raw_key, str):
            continue

        if isinstance(raw_value, str):
            text = _normalize_text(raw_value)
            if text:
                cleaned[raw_key] = {"text": text, "ts": 0.0}
            continue

        if not isinstance(raw_value, dict):
            continue

        text = _normalize_text(raw_value.get("text", ""))
        if not text:
            continue

        cleaned[raw_key] = {
            "text": text,
            "ts": _normalize_timestamp(raw_value.get("ts", 0.0)),
        }

    _session_notes = cleaned


def save_notes() -> None:
    """Persist note payload to disk, ignoring write failures."""
    try:
        _NOTES_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            key: {"text": value.get("text", ""), "ts": value.get("ts", 0.0)}
            for key, value in sorted(_session_notes.items())
            if isinstance(key, str)
            and isinstance(value, dict)
            and _normalize_text(value.get("text", ""))
        }
        _NOTES_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _entry_for(session_id: str) -> dict[str, Any]:
    entry = _session_notes.get(str(session_id), {})
    return entry if isinstance(entry, dict) else {}


def get_note(session_id: str) -> str:
    """Return current note text for a session."""
    return _normalize_text(_entry_for(session_id).get("text", ""))


def set_note(session_id: str, text: str) -> None:
    """Save note text and modification timestamp for a session."""
    key = str(session_id)
    normalized = _normalize_text(text)
    if normalized:
        _session_notes[key] = {"text": normalized, "ts": time.time()}
    else:
        _session_notes.pop(key, None)
    save_notes()


def has_note(session_id: str) -> bool:
    return bool(get_note(session_id))


def _format_note_age(ts: float) -> str:
    if ts <= 0:
        return "now"
    seconds = max(0, int(time.time() - ts))
    if seconds < 60:
        return "now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    return f"{seconds // 86400}d ago"


def render_notes_section(session_id: str, width: int = _DEFAULT_SECTION_WIDTH) -> str:
    """Render note text in a bordered preview section."""
    text = get_note(session_id)
    if not text:
        return ""

    safe_width = max(_MIN_SECTION_WIDTH, min(_MAX_SECTION_WIDTH, int(width)))
    inner = safe_width - 2
    title = " Notes "
    title_left = max(0, (inner - len(title)) // 2)
    title_right = max(0, inner - len(title) - title_left)

    entry = _entry_for(session_id)
    age = _format_note_age(_normalize_timestamp(entry.get("ts", 0.0)))
    header = f"📝 {age}"

    body_width = max(1, inner - 2)
    lines = text.splitlines()[:_MAX_PREVIEW_LINES]
    if not lines:
        lines = [text]

    block: list[str] = [
        f"╒{'═' * title_left}{title}{'═' * title_right}╕",
        f"║ {header[:body_width]:<{body_width}} ║",
        f"╞{'═' * inner}╟",
    ]
    for raw_line in lines:
        line = raw_line[:body_width]
        block.append(f"║ {line:<{body_width}} ║")
    block.append(f"╘{'═' * inner}╛")
    return "\n".join(block)


def _prepend_notes(rendered: object, section: str) -> object:
    if not section:
        return rendered

    if isinstance(rendered, Text):
        if rendered.plain.startswith(section):
            return rendered
        prefixed = Text(f"{section}\n\n", style="bold #adbac7")
        prefixed.append_text(rendered)
        return prefixed

    plain = str(rendered or "")
    if plain.startswith(section):
        return plain
    return f"{section}\n\n{plain}" if plain else section


def _preview_section_width(app: Any) -> int:
    try:
        preview = app.query_one("#preview-content", Static)
        width = int(getattr(getattr(preview, "size", None), "width", 0))
        if width > 4:
            return width - 2
    except Exception:
        pass
    return _DEFAULT_SECTION_WIDTH


def _extract_input_text(widget: object) -> str:
    text_value = getattr(widget, "text", None)
    if isinstance(text_value, str):
        return text_value
    value = getattr(widget, "value", None)
    if isinstance(value, str):
        return value
    return ""


class NotesScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss_screen", "Cancel"),
        Binding("ctrl+s", "save_note", "Save"),
    ]

    CSS = """
    NotesScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.45);
    }
    #notes-dialog {
        width: 72;
        height: auto;
        border: round #444c56;
        background: #2d333b;
        padding: 1 2;
    }
    #notes-input {
        height: 12;
        border: solid #444c56;
        background: #1c2128;
    }
    #notes-help {
        color: #636e7b;
        padding-top: 1;
    }
    """

    def __init__(self, session_id: str, session_title: str) -> None:
        super().__init__()
        self._session_id = str(session_id)
        self._session_title = session_title

    def compose(self) -> ComposeResult:
        current = get_note(self._session_id)
        with Vertical(id="notes-dialog"):
            title = self._session_title or self._session_id[:16]
            yield Static(f"📝 Notes: {title[:46]}", id="notes-title")

            text_area_cls: Any = None
            try:
                from textual.widgets import TextArea as _TextArea

                text_area_cls = _TextArea
            except Exception:
                text_area_cls = None

            if text_area_cls is not None:
                try:
                    yield text_area_cls(current, id="notes-input")
                except Exception:
                    try:
                        yield text_area_cls(text=current, id="notes-input")
                    except Exception:
                        yield Input(value=current, placeholder="Enter notes...", id="notes-input")
            else:
                yield Input(value=current, placeholder="Enter notes...", id="notes-input")

            yield Static("Ctrl+S save • Esc cancel", id="notes-help")

    def on_mount(self) -> None:
        try:
            self.query_one("#notes-input").focus()
        except Exception:
            pass

    def action_save_note(self) -> None:
        try:
            widget = self.query_one("#notes-input")
            text = _extract_input_text(widget)
            set_note(self._session_id, text)
            self.dismiss(text)
        except Exception:
            self.dismiss(None)

    def action_dismiss_screen(self) -> None:
        self.dismiss(None)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_session_notes_feature_patched", False):
        return

    original_session_cell = getattr(AgentsViewApp, "_session_cell", None)
    original_update_preview = getattr(AgentsViewApp, "_update_preview", None)
    original_apply_worker_preview = getattr(AgentsViewApp, "_apply_worker_preview", None)

    if not callable(original_session_cell) or not callable(original_update_preview):
        return

    load_notes()

    def _selected_session(self: Any) -> Any:
        current_fn = getattr(self, "_current_session", None)
        if callable(current_fn):
            try:
                resolved = current_fn()
                if resolved is not None:
                    return resolved
            except Exception:
                pass
        return getattr(self, "_selected_session", None)

    def _refresh_after_change(self: Any) -> None:
        try:
            self._update_table()
        except Exception:
            pass
        try:
            self._preview_last_render_key = None
        except Exception:
            pass
        try:
            self._update_preview()
        except Exception:
            pass

    def _action_session_notes(self: Any) -> None:
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

        session_title = str(getattr(session, "display_title", "") or getattr(session, "title", ""))

        def _handle_result(result: str | None) -> None:
            if result is None:
                return
            _refresh_after_change(self)

        self.push_screen(NotesScreen(session_id, session_title), callback=_handle_result)

    def _session_cell_with_notes(self: Any, session: Any) -> Text:
        cell = original_session_cell(self, session)
        session_id = str(getattr(session, "session_id", ""))
        if not session_id or not has_note(session_id):
            return cell

        if isinstance(cell, Text):
            if cell.plain.startswith("📝 "):
                return cell
            prefixed = Text("📝 ", style="bold #d4a72c")
            prefixed.append_text(cell)
            return prefixed

        text_cell = Text("📝 ", style="bold #d4a72c")
        text_cell.append(str(cell), style="#adbac7")
        return text_cell

    def _update_preview_with_notes(self: Any) -> None:
        original_update_preview(self)

        session = _selected_session(self)
        if session is None:
            return

        session_id = str(getattr(session, "session_id", ""))
        section = render_notes_section(session_id, width=_preview_section_width(self))
        if not section:
            return

        try:
            preview_widget = self.query_one("#preview-content", Static)
            current = getattr(preview_widget, "renderable", "")
            preview_widget.update(_prepend_notes(current, section))
        except Exception:
            return

    def _apply_worker_preview_with_notes(
        self: Any,
        session_id: str,
        rendered: object,
        preview_render_key: tuple[object, ...],
        panel_title: str,
        status_line: object,
    ) -> None:
        section = render_notes_section(
            str(session_id),
            width=_preview_section_width(self),
        )
        if section:
            rendered = _prepend_notes(rendered, section)
            entry = _entry_for(str(session_id))
            note_stamp = (
                _normalize_text(entry.get("text", "")),
                _normalize_timestamp(entry.get("ts", 0.0)),
            )
            preview_render_key = tuple(preview_render_key) + ("session-notes", note_stamp)

        if callable(original_apply_worker_preview):
            original_apply_worker_preview(
                self,
                session_id,
                rendered,
                preview_render_key,
                panel_title,
                status_line,
            )

    AgentsViewApp.action_session_notes = _action_session_notes
    AgentsViewApp._session_cell = _session_cell_with_notes
    AgentsViewApp._update_preview = _update_preview_with_notes
    if callable(original_apply_worker_preview):
        AgentsViewApp._apply_worker_preview = _apply_worker_preview_with_notes

    AgentsViewApp._get_session_note = staticmethod(get_note)
    AgentsViewApp._set_session_note = staticmethod(set_note)
    AgentsViewApp._has_session_note = staticmethod(has_note)
    AgentsViewApp._render_notes_section = staticmethod(render_notes_section)

    rewritten_bindings: list[Any] = []
    has_notes_binding = False
    for binding in list(AgentsViewApp.BINDINGS):
        key = str(getattr(binding, "key", ""))
        if key == "N":
            if not has_notes_binding:
                rewritten_bindings.append(
                    Binding("N", "session_notes", "Session notes", show=False)
                )
                has_notes_binding = True
            continue
        rewritten_bindings.append(binding)

    if not has_notes_binding:
        rewritten_bindings.append(Binding("N", "session_notes", "Session notes", show=False))

    AgentsViewApp.BINDINGS = rewritten_bindings

    cleaned_help = [
        row
        for row in list(HelpScreen._BINDINGS_TABLE)
        if row != ("Input", "N", "Save quick note")
    ]
    HelpScreen._BINDINGS_TABLE = cleaned_help

    help_row = ("Session", "N", "Session notes")
    if help_row not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(help_row)

    AgentsViewApp._session_notes_feature_patched = True


_patch_app()

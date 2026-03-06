"""preview_search.py - Search within the session preview pane.

Provides:
- ctrl+f: activate preview search
- /: activate search when preview pane has focus
- n / N: navigate next / previous match
- escape: clear preview search and restore normal preview
- ctrl+c: toggle case sensitivity while search is active
"""

from __future__ import annotations

import inspect
import re
from typing import Any, cast

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_MATCH_HIGHLIGHT = "\x1b[7m"
_CURRENT_MATCH_HIGHLIGHT = "\x1b[30;103m"
_RESET = "\x1b[0m"


def _strip_ansi(text: str) -> str:
    if not text:
        return ""
    return _ANSI_ESCAPE_RE.sub("", text)


def highlight_matches(text: str, query: str, case_sensitive: bool = False) -> str:
    """Add ANSI highlight escapes around all matches of query in text."""
    if not text or not query:
        return text
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(re.escape(query), flags)
        return pattern.sub(lambda m: f"{_MATCH_HIGHLIGHT}{m.group(0)}{_RESET}", text)
    except Exception:
        return text


def count_matches(text: str, query: str, case_sensitive: bool = False) -> int:
    """Count matches of query in text."""
    if not text or not query:
        return 0
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return len(re.findall(re.escape(query), text, flags))
    except Exception:
        return 0


def _renderable_to_plain(renderable: object) -> str:
    if renderable is None:
        return ""

    plain = getattr(renderable, "plain", None)
    if isinstance(plain, str):
        return _strip_ansi(plain)

    return _strip_ansi(str(renderable))


def _ensure_state(app: Any) -> None:
    if not hasattr(app, "_preview_search_active"):
        app._preview_search_active = False
    if not hasattr(app, "_preview_search_query"):
        app._preview_search_query = ""
    if not hasattr(app, "_preview_search_case_sensitive"):
        app._preview_search_case_sensitive = False
    if not hasattr(app, "_preview_search_matches"):
        app._preview_search_matches = []
    if not hasattr(app, "_preview_search_current"):
        app._preview_search_current = -1
    if not hasattr(app, "_preview_search_plain"):
        app._preview_search_plain = ""
    if not hasattr(app, "_preview_search_last_zero_query"):
        app._preview_search_last_zero_query = ""


def _preview_has_focus(app: Any) -> bool:
    if getattr(app, "_panel_tab", 0) != 0:
        return False
    try:
        focused = app.focused
    except Exception:
        return False
    if focused is None:
        return True
    focused_id = getattr(focused, "id", "")
    return focused_id in {"preview-panel", "preview-content", "preview-search-bar"}


def _ensure_search_bar(app: Any) -> object | None:
    _ensure_state(app)
    try:
        return app.query_one("#preview-search-bar")
    except Exception:
        pass

    try:
        from textual.widgets import Static

        panel = app.query_one("#right-panel")
        preview_status = app.query_one("#preview-status")

        bar = Static("", id="preview-search-bar", markup=False)
        bar.display = False
        try:
            bar.styles.height = 1
            bar.styles.border_top = ("solid", "#384048")
            bar.styles.padding = (0, 1)
            bar.styles.color = "#adbac7"
            bar.styles.background = "#22272e"
        except Exception:
            pass

        panel.mount(bar, before=preview_status)
        return bar
    except Exception:
        return None


def _capture_preview_plain(app: Any) -> None:
    _ensure_state(app)
    try:
        preview = app.query_one("#preview-content")
        renderable = getattr(preview, "renderable", "")
        app._preview_search_plain = _renderable_to_plain(renderable)
    except Exception:
        app._preview_search_plain = ""


def _find_matches(text: str, query: str, case_sensitive: bool) -> list[tuple[int, int]]:
    if not text or not query:
        return []
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(re.escape(query), flags)
        return [(match.start(), match.end()) for match in pattern.finditer(text)]
    except Exception:
        return []


def _build_highlighted_text(
    text: str, matches: list[tuple[int, int]], current_index: int
) -> str:
    if not matches:
        return text

    rendered: list[str] = []
    cursor = 0
    for idx, (start, end) in enumerate(matches):
        if start > cursor:
            rendered.append(text[cursor:start])

        rendered.append(
            _CURRENT_MATCH_HIGHLIGHT if idx == current_index else _MATCH_HIGHLIGHT
        )
        rendered.append(text[start:end])
        rendered.append(_RESET)
        cursor = end

    if cursor < len(text):
        rendered.append(text[cursor:])

    return "".join(rendered)


def _scroll_to_current_match(app: Any) -> None:
    matches = cast(list[tuple[int, int]], getattr(app, "_preview_search_matches", []))
    current = int(getattr(app, "_preview_search_current", -1))
    text = str(getattr(app, "_preview_search_plain", ""))
    if not matches or current < 0 or current >= len(matches):
        return

    line_number = text.count("\n", 0, matches[current][0])
    try:
        app.query_one("#preview-panel").scroll_to(y=max(0, line_number - 2), animate=False)
    except Exception:
        pass


def _update_search_bar(app: Any) -> None:
    bar_obj = _ensure_search_bar(app)
    if bar_obj is None:
        return

    bar = cast(Any, bar_obj)
    active = bool(getattr(app, "_preview_search_active", False)) and getattr(
        app, "_panel_tab", 0
    ) == 0
    bar.display = active
    if not active:
        return

    query = str(getattr(app, "_preview_search_query", ""))
    matches = cast(list[tuple[int, int]], getattr(app, "_preview_search_matches", []))
    current = int(getattr(app, "_preview_search_current", -1))
    case_sensitive = bool(getattr(app, "_preview_search_case_sensitive", False))
    mode = "Aa" if case_sensitive else "aa"

    if not query:
        bar.update(
            f"Search [{mode}] | type to search | n/N next/prev | Ctrl+C case | Esc close"
        )
        return

    total = len(matches)
    if total == 0:
        bar.update(f"Search [{mode}] {query!r} | 0 matches")
        return

    current_human = max(1, min(total, current + 1))
    bar.update(f"Search [{mode}] {query!r} | {current_human} of {total} matches")


def _render_search(app: Any) -> None:
    _ensure_state(app)
    _update_search_bar(app)

    if not getattr(app, "_preview_search_active", False):
        return

    query = str(getattr(app, "_preview_search_query", ""))
    text = str(getattr(app, "_preview_search_plain", ""))

    try:
        preview = app.query_one("#preview-content")
    except Exception:
        return

    if not query:
        try:
            preview.update(text)
        except Exception:
            pass
        return

    matches = _find_matches(
        text,
        query,
        bool(getattr(app, "_preview_search_case_sensitive", False)),
    )
    app._preview_search_matches = matches

    if matches:
        current = int(getattr(app, "_preview_search_current", 0))
        if current < 0 or current >= len(matches):
            current = 0
        app._preview_search_current = current
        app._preview_search_last_zero_query = ""
    else:
        app._preview_search_current = -1
        if getattr(app, "_preview_search_last_zero_query", "") != query:
            app._preview_search_last_zero_query = query
            try:
                app.notify("Preview search: 0 matches", timeout=1.0)
            except Exception:
                pass

    _update_search_bar(app)

    if not matches:
        try:
            preview.update(text)
        except Exception:
            pass
        return

    highlighted = _build_highlighted_text(
        text,
        matches,
        int(getattr(app, "_preview_search_current", 0)),
    )

    try:
        from rich.text import Text as RichText

        preview.update(RichText.from_ansi(highlighted))
    except Exception:
        preview.update(highlighted)

    _scroll_to_current_match(app)


def _activate_search(app: Any) -> None:
    _ensure_state(app)
    _ensure_search_bar(app)

    try:
        if getattr(app, "_panel_tab", 0) != 0:
            app._apply_panel_tab(0)
    except Exception:
        pass

    app._preview_search_active = True
    app._preview_search_query = ""
    app._preview_search_matches = []
    app._preview_search_current = -1
    app._preview_search_last_zero_query = ""

    _capture_preview_plain(app)
    _update_search_bar(app)


def _clear_search(app: Any, *, refresh_preview: bool = True) -> None:
    _ensure_state(app)
    app._preview_search_active = False
    app._preview_search_query = ""
    app._preview_search_matches = []
    app._preview_search_current = -1
    app._preview_search_last_zero_query = ""

    _update_search_bar(app)
    if not refresh_preview:
        return

    try:
        app._update_preview()
    except Exception:
        pass


def _next_match(app: Any, direction: int) -> None:
    matches = cast(list[tuple[int, int]], getattr(app, "_preview_search_matches", []))
    if not matches:
        try:
            app.notify("Preview search: 0 matches", timeout=1.0)
        except Exception:
            pass
        return

    current = int(getattr(app, "_preview_search_current", 0))
    app._preview_search_current = (current + direction) % len(matches)
    _render_search(app)


def _toggle_case_sensitive(app: Any) -> None:
    app._preview_search_case_sensitive = not bool(
        getattr(app, "_preview_search_case_sensitive", False)
    )
    app._preview_search_current = 0
    _render_search(app)


def _append_query_char(app: Any, character: str) -> None:
    if not character:
        return
    app._preview_search_query = f"{app._preview_search_query}{character}"
    app._preview_search_current = 0
    _render_search(app)


def _backspace_query(app: Any) -> None:
    query = str(getattr(app, "_preview_search_query", ""))
    if not query:
        return

    app._preview_search_query = query[:-1]
    app._preview_search_current = 0 if app._preview_search_query else -1
    _render_search(app)


def _patch_app() -> None:
    try:
        from textual.binding import Binding
        from textual.widgets import DataTable, Input

        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_preview_search_feature_patched", False):
        return

    original_on_mount: Any = getattr(AgentsViewApp, "on_mount", None)
    original_on_key: Any = getattr(AgentsViewApp, "on_key", None)
    original_update_preview: Any = getattr(AgentsViewApp, "_update_preview", None)
    original_apply_worker_preview: Any = getattr(AgentsViewApp, "_apply_worker_preview", None)
    original_apply_panel_tab: Any = getattr(AgentsViewApp, "_apply_panel_tab", None)
    original_cycle_focus: Any = getattr(AgentsViewApp, "action_cycle_focus", None)

    async def _patched_on_mount(self: Any) -> None:
        if callable(original_on_mount):
            result = original_on_mount(self)
            if inspect.isawaitable(result):
                await cast(Any, result)
        _ensure_state(self)
        _ensure_search_bar(self)
        _update_search_bar(self)

    def _patched_cycle_focus(self: Any) -> None:
        if not getattr(self, "_preview_search_active", False):
            if callable(original_cycle_focus):
                original_cycle_focus(self)
                return

        try:
            input_widget = self.query_one("#session-input", Input)
            table = self.query_one("#session-table", DataTable)
            preview_panel = self.query_one("#preview-panel")
            preview_content = self.query_one("#preview-content")

            if table.has_focus:
                preview_panel.focus()
                return
            if preview_panel.has_focus or preview_content.has_focus:
                input_widget.focus()
                return
            if input_widget.has_focus:
                table.focus()
                return
            table.focus()
            return
        except Exception:
            if callable(original_cycle_focus):
                original_cycle_focus(self)

    def _patched_apply_panel_tab(self: Any, tab_index: int) -> None:
        if callable(original_apply_panel_tab):
            original_apply_panel_tab(self, tab_index)
        _ensure_state(self)
        if getattr(self, "_panel_tab", 0) != 0 and getattr(
            self, "_preview_search_active", False
        ):
            _clear_search(self, refresh_preview=False)
        _update_search_bar(self)

    def _patched_apply_worker_preview(
        self: Any,
        session_id: str,
        rendered: object,
        preview_render_key: tuple[object, ...],
        panel_title: str,
        status_line: str,
    ) -> None:
        if callable(original_apply_worker_preview):
            original_apply_worker_preview(
                self,
                session_id,
                rendered,
                preview_render_key,
                panel_title,
                status_line,
            )
        _capture_preview_plain(self)
        if getattr(self, "_preview_search_active", False):
            _render_search(self)

    def _patched_update_preview(self: Any) -> None:
        if callable(original_update_preview):
            original_update_preview(self)
        _capture_preview_plain(self)
        if getattr(self, "_preview_search_active", False):
            _render_search(self)

    def _patched_on_key(self: Any, event: Any) -> None:
        _ensure_state(self)
        key = str(getattr(event, "key", ""))

        if getattr(self, "_preview_search_active", False):
            if key == "escape":
                _clear_search(self)
                event.prevent_default()
                event.stop()
                return
            if key == "ctrl+c":
                _toggle_case_sensitive(self)
                event.prevent_default()
                event.stop()
                return
            if key == "backspace":
                _backspace_query(self)
                event.prevent_default()
                event.stop()
                return
            if key == "delete":
                self._preview_search_query = ""
                self._preview_search_matches = []
                self._preview_search_current = -1
                self._preview_search_last_zero_query = ""
                _render_search(self)
                event.prevent_default()
                event.stop()
                return
            if key == "n":
                _next_match(self, 1)
                event.prevent_default()
                event.stop()
                return
            if key == "N":
                _next_match(self, -1)
                event.prevent_default()
                event.stop()
                return

            character = getattr(event, "character", None)
            if isinstance(character, str) and character.isprintable() and character:
                _append_query_char(self, character)
                event.prevent_default()
                event.stop()
                return

        if key == "/" and _preview_has_focus(self):
            _activate_search(self)
            event.prevent_default()
            event.stop()
            return

        if callable(original_on_key):
            original_on_key(self, event)

    def _action_preview_search(self: Any) -> None:
        _activate_search(self)

    def _action_preview_search_next(self: Any) -> None:
        if not getattr(self, "_preview_search_active", False):
            return
        _next_match(self, 1)

    def _action_preview_search_prev(self: Any) -> None:
        if not getattr(self, "_preview_search_active", False):
            return
        _next_match(self, -1)

    AgentsViewApp.on_mount = _patched_on_mount  # type: ignore[method-assign,assignment]
    AgentsViewApp.on_key = _patched_on_key  # type: ignore[method-assign,assignment]
    AgentsViewApp._update_preview = _patched_update_preview  # type: ignore[method-assign,assignment]
    AgentsViewApp._apply_worker_preview = _patched_apply_worker_preview  # type: ignore[method-assign,assignment]
    AgentsViewApp._apply_panel_tab = _patched_apply_panel_tab  # type: ignore[method-assign,assignment]
    AgentsViewApp.action_cycle_focus = _patched_cycle_focus  # type: ignore[method-assign,assignment]
    AgentsViewApp.action_preview_search = _action_preview_search  # type: ignore[attr-defined]
    AgentsViewApp.action_preview_search_next = _action_preview_search_next  # type: ignore[attr-defined]
    AgentsViewApp.action_preview_search_prev = _action_preview_search_prev  # type: ignore[attr-defined]

    AgentsViewApp._highlight_preview_matches = staticmethod(highlight_matches)  # type: ignore[attr-defined]
    AgentsViewApp._count_preview_matches = staticmethod(count_matches)  # type: ignore[attr-defined]
    AgentsViewApp._preview_search_feature_patched = True  # type: ignore[attr-defined]

    rewritten_bindings: list[Any] = []
    replaced_ctrl_f = False
    for binding in list(AgentsViewApp.BINDINGS):
        if getattr(binding, "key", "") == "ctrl+f":
            rewritten_bindings.append(Binding("ctrl+f", "preview_search", "Search preview"))
            replaced_ctrl_f = True
        else:
            rewritten_bindings.append(binding)

    if not replaced_ctrl_f:
        rewritten_bindings.append(Binding("ctrl+f", "preview_search", "Search preview"))

    AgentsViewApp.BINDINGS = rewritten_bindings  # type: ignore[assignment]

    help_entries = [
        ("Preview", "ctrl+f", "Search preview"),
        ("Preview", "/", "Search preview (focused)"),
        ("Preview", "n / N", "Next / previous search match"),
        ("Preview", "Ctrl+C", "Toggle preview search case mode"),
        ("Preview", "Esc", "Exit preview search"),
    ]
    for row in help_entries:
        if row not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(row)


_patch_app()

"""theme_enhancements.py - Adds extra color themes and a theme picker screen."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Static

_NEW_THEMES: dict[str, dict[str, str]] = {
    "tokyo-night": {
        "bg_primary": "#1a1b26",
        "bg_secondary": "#16161e",
        "bg_tertiary": "#13131b",
        "border": "#2a2b3d",
        "text_primary": "#a9b1d6",
        "text_dim": "#444b6a",
        "text_bright": "#c0caf5",
        "accent_blue": "#7aa2f7",
        "accent_green": "#9ece6a",
        "accent_amber": "#e0af68",
        "accent_red": "#f7768e",
        "accent_orange": "#ff9e64",
        "accent_cyan": "#2ac3de",
        "accent_purple": "#bb9af7",
    },
    "gruvbox": {
        "bg_primary": "#282828",
        "bg_secondary": "#1d2021",
        "bg_tertiary": "#141617",
        "border": "#504945",
        "text_primary": "#ebdbb2",
        "text_dim": "#928374",
        "text_bright": "#fbf1c7",
        "accent_blue": "#83a598",
        "accent_green": "#b8bb26",
        "accent_amber": "#fabd2f",
        "accent_red": "#fb4934",
        "accent_orange": "#fe8019",
        "accent_cyan": "#8ec07c",
        "accent_purple": "#d3869b",
    },
    "dracula": {
        "bg_primary": "#282a36",
        "bg_secondary": "#21222c",
        "bg_tertiary": "#1a1c25",
        "border": "#44475a",
        "text_primary": "#f8f8f2",
        "text_dim": "#6272a4",
        "text_bright": "#ffffff",
        "accent_blue": "#6272a4",
        "accent_green": "#50fa7b",
        "accent_amber": "#f1fa8c",
        "accent_red": "#ff5555",
        "accent_orange": "#ffb86c",
        "accent_cyan": "#8be9fd",
        "accent_purple": "#bd93f9",
    },
    "solarized-dark": {
        "bg_primary": "#002b36",
        "bg_secondary": "#073642",
        "bg_tertiary": "#001e26",
        "border": "#586e75",
        "text_primary": "#839496",
        "text_dim": "#586e75",
        "text_bright": "#93a1a1",
        "accent_blue": "#268bd2",
        "accent_green": "#859900",
        "accent_amber": "#b58900",
        "accent_red": "#dc322f",
        "accent_orange": "#cb4b16",
        "accent_cyan": "#2aa198",
        "accent_purple": "#6c71c4",
    },
}


class ThemePickerScreen(Screen[str | None]):
    """Popup screen that lets users choose a theme from a table."""

    BINDINGS = [
        Binding("escape,q", "dismiss_picker", "Cancel"),
        Binding("enter", "apply_selected", "Apply"),
    ]

    CSS = """
    ThemePickerScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.45);
    }

    #theme-picker-dialog {
        width: 78;
        height: auto;
        max-height: 32;
        border: round #444c56;
        background: #2d333b;
        padding: 1 1;
    }

    #theme-picker-title {
        color: #adbac7;
        padding: 0 1;
    }

    #theme-picker-help {
        color: #768390;
        padding: 0 1;
    }

    #theme-picker-table {
        height: auto;
        max-height: 24;
    }
    """

    def __init__(
        self,
        theme_order: list[str],
        themes: dict[str, dict[str, str]],
        current_theme: str | None,
    ) -> None:
        super().__init__()
        self._themes = themes
        self._theme_names = [name for name in theme_order if name in themes]
        self._current_theme = current_theme

    def compose(self) -> ComposeResult:
        with Vertical(id="theme-picker-dialog"):
            yield Static("Theme Picker", id="theme-picker-title")
            yield Static("Enter apply • Esc cancel", id="theme-picker-help")
            yield DataTable(id="theme-picker-table", cursor_type="row")

    def on_mount(self) -> None:
        table = self.query_one("#theme-picker-table", DataTable)
        table.add_columns("Theme", "Background", "Text", "Accent")

        for name in self._theme_names:
            palette = self._themes.get(name, {})
            table.add_row(
                name,
                palette.get("bg_primary", ""),
                palette.get("text_primary", ""),
                palette.get("accent_blue", ""),
            )

        if self._current_theme in self._theme_names:
            idx = self._theme_names.index(str(self._current_theme))
            move_cursor = getattr(table, "move_cursor", None)
            if callable(move_cursor):
                move_cursor(row=idx, column=0)

        table.focus()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        row = int(getattr(event, "cursor_row", -1))
        if 0 <= row < len(self._theme_names):
            self.dismiss(self._theme_names[row])

    def action_apply_selected(self) -> None:
        table = self.query_one("#theme-picker-table", DataTable)
        row = int(getattr(table, "cursor_row", -1))
        if 0 <= row < len(self._theme_names):
            self.dismiss(self._theme_names[row])
            return
        self.dismiss(None)

    def action_dismiss_picker(self) -> None:
        self.dismiss(None)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
        import agents_view.app as app_mod
    except Exception:
        return

    if getattr(AgentsViewApp, "_theme_enhancements_feature_patched", False):
        return

    themes = getattr(app_mod, "_THEMES", None)
    theme_order = getattr(app_mod, "_THEME_ORDER", None)
    if not isinstance(themes, dict) or not isinstance(theme_order, list):
        return

    for theme_name, palette in _NEW_THEMES.items():
        themes[theme_name] = dict(palette)
        if theme_name not in theme_order:
            theme_order.append(theme_name)

    def _theme_name_from_state(app: Any) -> str | None:
        active_theme = getattr(app, "_theme", {})
        if isinstance(active_theme, dict):
            for name in theme_order:
                candidate = themes.get(name)
                if isinstance(candidate, dict) and dict(candidate) == active_theme:
                    return name

        idx = int(getattr(app, "_current_theme_idx", 0) or 0)
        if 0 <= idx < len(theme_order):
            return str(theme_order[idx])

        if theme_order:
            return str(theme_order[0])
        return None

    def _apply_theme_by_name(app: Any, theme_name: str) -> None:
        palette = themes.get(theme_name)
        if not isinstance(palette, dict):
            return

        apply_theme = getattr(app, "_apply_theme", None)
        if callable(apply_theme):
            apply_theme(dict(palette))

        if theme_name in theme_order:
            app._current_theme_idx = theme_order.index(theme_name)

        save_pref = getattr(app, "_save_theme_preference", None)
        if callable(save_pref):
            save_pref(theme_name)

        notify = getattr(app, "notify", None)
        if callable(notify):
            notify(f"Theme: {theme_name}", timeout=2)

    def _action_theme_picker(self: Any) -> None:
        current_theme = _theme_name_from_state(self)

        def _on_theme_selected(selected: str | None) -> None:
            if not selected:
                return
            _apply_theme_by_name(self, selected)

        self.push_screen(
            ThemePickerScreen(list(theme_order), themes, current_theme),
            callback=_on_theme_selected,
        )

    AgentsViewApp.action_theme_picker = _action_theme_picker  # type: ignore[attr-defined,method-assign]

    bindings = list(getattr(AgentsViewApp, "BINDINGS", []))
    existing_keys = {str(getattr(binding, "key", "")) for binding in bindings}
    existing_actions = {str(getattr(binding, "action", "")) for binding in bindings}

    if "theme_picker" not in existing_actions and "T" not in existing_keys:
        AgentsViewApp.BINDINGS = bindings + [
            Binding("T", "theme_picker", "Theme picker", show=False)
        ]
        help_row = ("View", "T", "Theme picker")
        if help_row not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(help_row)

    setattr(AgentsViewApp, "_theme_enhancements_feature_patched", True)


_patch_app()

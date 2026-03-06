"""help_screen_v2.py - Enhanced help screen with visual grouping and colors."""

from __future__ import annotations

from collections import defaultdict
from typing import ClassVar

from rich.markup import escape
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.screen import Screen
from textual.widgets import Input, Static

_DEFAULT_THEME = {
    "bg_primary": "#22272e",
    "bg_secondary": "#2d333b",
    "bg_tertiary": "#1c2128",
    "border": "#444c56",
    "text_primary": "#adbac7",
    "text_dim": "#636e7b",
    "text_bright": "#cdd9e5",
    "accent_blue": "#6cb6ff",
    "accent_amber": "#d4a72c",
    "accent_cyan": "#57c4f8",
}

_COLUMN_LAYOUT: dict[str, list[str]] = {
    "left": ["Navigation", "Session", "View"],
    "right": ["Git", "Broadcast", "Filter"],
}

_CATEGORY_ALIASES: dict[str, str] = {
    "Navigation": "Navigation",
    "Projects": "Navigation",
    "Session": "Session",
    "Input": "Session",
    "View": "View",
    "Panel": "View",
    "Screens": "View",
    "App": "View",
    "Git": "Git",
    "Broadcast": "Broadcast",
    "Filter": "Filter",
    "Search": "Filter",
    "Sort": "Filter",
}

_SECTION_TITLES: dict[str, str] = {
    "Navigation": "Navigation",
    "Session": "Session Actions",
    "View": "View",
    "Git": "Git",
    "Broadcast": "Broadcast",
    "Filter": "Filter",
}


class EnhancedHelpScreen(Screen):
    """Visual, searchable keybinding reference."""

    BINDINGS = [
        Binding("escape,q,question_mark", "dismiss", "Close"),
        Binding("/", "focus_search", "Search", show=False),
    ]

    CSS = """
    EnhancedHelpScreen {
        align: center middle;
        background: #00000066;
    }

    #help-container {
        width: 132;
        height: 44;
        border: double #444c56;
        background: #22272e;
        padding: 0;
    }

    #help-title {
        background: #2d333b;
        text-align: center;
        padding: 1 0;
    }

    #help-search {
        margin: 1 2 0 2;
        border: solid #444c56;
        background: #1c2128;
        color: #cdd9e5;
    }

    #help-body {
        margin: 1 1 0 1;
        height: 1fr;
    }

    #help-columns {
        height: auto;
        width: 1fr;
    }

    #help-left,
    #help-right {
        width: 1fr;
        padding: 0 1;
    }

    #help-footer {
        height: 1;
        text-align: center;
        background: #2d333b;
        padding: 0 1;
    }
    """

    _BINDINGS_TABLE: ClassVar[list[tuple[str, str, str]]] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="help-container"):
            yield Static("", id="help-title", markup=True)
            yield Input(placeholder="Search shortcuts...", id="help-search")
            with ScrollableContainer(id="help-body"):
                with Horizontal(id="help-columns"):
                    yield Static("", id="help-left", markup=True)
                    yield Static("", id="help-right", markup=True)
            yield Static("", id="help-footer", markup=True)

    def on_mount(self) -> None:
        self._render_help("")

    def _theme(self) -> dict[str, str]:
        palette = dict(_DEFAULT_THEME)
        app_theme = getattr(self.app, "_theme", None)
        if isinstance(app_theme, dict):
            for key, value in app_theme.items():
                if isinstance(value, str):
                    palette[key] = value
        return palette

    def _bindings_table(self) -> list[tuple[str, str, str]]:
        table = getattr(type(self), "_BINDINGS_TABLE", None)
        if isinstance(table, list):
            return [row for row in table if isinstance(row, tuple) and len(row) == 3]
        return []

    def _canonical_category(self, category: str) -> str:
        return _CATEGORY_ALIASES.get(category, "View")

    def _render_column(
        self,
        grouped: dict[str, list[tuple[str, str]]],
        categories: list[str],
        palette: dict[str, str],
    ) -> str:
        lines: list[str] = []

        for category in categories:
            rows = grouped.get(category, [])
            if not rows:
                continue

            section_title = _SECTION_TITLES.get(category, category).upper()
            lines.append(f"[bold {palette['accent_blue']}]{escape(section_title)}[/]")
            lines.append(f"[{palette['text_dim']}]────────────────────────────────────────[/]")

            for key_name, description in rows:
                key_color = (
                    palette["accent_cyan"]
                    if ("+" in key_name or "ctrl" in key_name.lower())
                    else palette["accent_amber"]
                )
                key_markup = f"[bold {key_color}]{escape(key_name):<14}[/]"
                desc_markup = f"[{palette['text_primary']}]{escape(description)}[/]"
                lines.append(f"{key_markup} {desc_markup}")

            lines.append("")

        if not lines:
            lines.append(f"[{palette['text_dim']}]No matches in this column[/]")

        return "\n".join(lines).rstrip()

    def _render_help(self, filter_text: str = "") -> None:
        palette = self._theme()
        filter_norm = filter_text.strip().lower()

        grouped: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for raw_category, key_name, description in self._bindings_table():
            haystack = f"{raw_category} {key_name} {description}".lower()
            if filter_norm and filter_norm not in haystack:
                continue
            category = self._canonical_category(raw_category)
            grouped[category].append((key_name, description))

        title = "\n".join(
            [
                f"[bold {palette['accent_blue']}]╔══════════════════════════════════════════════════╗[/]",
                f"[bold {palette['accent_blue']}]║  ⌨  Agents View Keyboard Reference               ║[/]",
                f"[bold {palette['accent_blue']}]╚══════════════════════════════════════════════════╝[/]",
            ]
        )

        footer = (
            f"[bold {palette['accent_cyan']}]"
            "Press / to filter sessions  │  ? to close help  │  Ctrl+T to cycle themes"
            "[/]"
        )

        left_markup = self._render_column(grouped, _COLUMN_LAYOUT["left"], palette)
        right_markup = self._render_column(grouped, _COLUMN_LAYOUT["right"], palette)

        self.query_one("#help-title", Static).update(title)
        self.query_one("#help-left", Static).update(left_markup)
        self.query_one("#help-right", Static).update(right_markup)
        self.query_one("#help-footer", Static).update(footer)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "help-search":
            self._render_help(event.value)

    def action_focus_search(self) -> None:
        self.query_one("#help-search", Input).focus()



def _patch_app() -> None:
    try:
        from agents_view import app as app_mod

        agents_view_app = app_mod.AgentsViewApp
        original_help_screen = app_mod.HelpScreen

        bindings_table = getattr(original_help_screen, "_BINDINGS_TABLE", [])
        if isinstance(bindings_table, list):
            EnhancedHelpScreen._BINDINGS_TABLE = bindings_table

        app_mod.HelpScreen = EnhancedHelpScreen  # type: ignore[assignment,misc]

        def _action_help(self) -> None:
            self.push_screen(EnhancedHelpScreen())

        agents_view_app.action_show_help = _action_help  # type: ignore[method-assign]
        agents_view_app.action_help = _action_help  # type: ignore[attr-defined,method-assign]
    except Exception:
        pass


_patch_app()

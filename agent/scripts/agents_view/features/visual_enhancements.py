"""visual_enhancements.py - Visual improvements for agents view.

Enhances status icons, adds animated spinners, context bars,
and improves the overall color scheme and layout.
"""

from __future__ import annotations

import math
import time
from typing import Any

from rich.text import Text

STATUS_ICONS = {
    "running": "⟳",
    "asking": "❓",
    "review": "👁",
    "stalled": "⚠",
    "idle": "○",
    "done": "✓",
    "unknown": "·",
    "error": "✗",
}

ROLE_BADGES = {
    "orchestrator": "◎",
    "default": "○",
    "": "·",
}

SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

_RUNNING_STATUSES = {"running", "delegating", "test_running", "build_running"}


def _status_key(status: str) -> str:
    key = (status or "").strip().lower()
    if key in _RUNNING_STATUSES:
        return "running"
    if key in {"waiting", "wait", "asking"}:
        return "asking"
    if key in {"agent_done", "done"}:
        return "done"
    if key in {"error_state", "error"}:
        return "error"
    return key if key in STATUS_ICONS else "unknown"


def _normalize_pct(pct: float | None) -> float | None:
    if pct is None:
        return None
    try:
        value = float(pct)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    if value <= 1.0:
        value *= 100.0
    return max(0.0, min(100.0, value))


def _theme_value(owner: Any, key: str, default: str) -> str:
    palette = getattr(owner, "_theme", {})
    if isinstance(palette, dict):
        value = palette.get(key)
        if isinstance(value, str) and value:
            return value
    return default


def get_status_icon(status: str, animated: bool = False) -> str:
    """Get status icon, optionally animated for running status."""
    normalized = _status_key(status)
    if normalized == "running" and animated:
        frame_idx = int(time.time() * 10) % len(SPINNER_FRAMES)
        return SPINNER_FRAMES[frame_idx]
    return STATUS_ICONS.get(normalized, "·")


def render_context_bar(pct: float | None, width: int = 8) -> str:
    """Render a compact context usage bar like [████░░░░]."""
    safe_width = max(1, int(width))
    normalized = _normalize_pct(pct)
    if normalized is None:
        return f"[{'░' * safe_width}]"
    filled = int((normalized / 100.0) * safe_width)
    bar = "█" * filled + "░" * (safe_width - filled)
    return f"[{bar}]"


def format_session_age(ts: float | None) -> str:
    if ts is None:
        return "—"
    try:
        delta = max(0.0, time.time() - float(ts))
    except (TypeError, ValueError):
        return "—"
    if delta < 3600:
        return f"{int(delta // 60)}m"
    if delta < 86400:
        return f"{int(delta // 3600)}h"
    return f"{int(delta // 86400)}d"


def render_cost_display(cost: float | None) -> str:
    try:
        value = float(cost or 0.0)
    except (TypeError, ValueError):
        value = 0.0
    if not math.isfinite(value):
        value = 0.0
    return f"${max(0.0, value):.2f}"


def _status_style(app: Any, status: str) -> str:
    style_map = {
        "running": _theme_value(app, "accent_blue", "#6cb6ff"),
        "asking": _theme_value(app, "accent_amber", "#d4a72c"),
        "stalled": _theme_value(app, "accent_red", "#f85149"),
        "done": _theme_value(app, "accent_green", "#3fb950"),
        "idle": _theme_value(app, "text_dim", "#636e7b"),
        "review": _theme_value(app, "accent_cyan", "#57c4f8"),
        "unknown": _theme_value(app, "text_dim", "#636e7b"),
        "error": _theme_value(app, "accent_red", "#f85149"),
    }
    color = style_map.get(_status_key(status), _theme_value(app, "text_dim", "#636e7b"))
    return f"bold {color}" if _status_key(status) in {"running", "asking", "stalled", "done", "error"} else color


def _context_style(app: Any, pct: float | None) -> str:
    normalized = _normalize_pct(pct)
    if normalized is None:
        return _theme_value(app, "text_dim", "#636e7b")
    if normalized < 50.0:
        return _theme_value(app, "accent_green", "#3fb950")
    if normalized <= 80.0:
        return _theme_value(app, "accent_amber", "#d4a72c")
    return _theme_value(app, "accent_red", "#f85149")


def _patch_app() -> None:
    try:
        from agents_view.app import (
            AgentsViewApp,
            ProjectTabBar,
            ResourceBar,
            _is_separator_key,
            _get_sys_resources,
        )
        from textual.widgets import DataTable
    except Exception:
        return

    if getattr(AgentsViewApp, "_visual_enhancements_patched", False):
        return

    original_column_cell = getattr(AgentsViewApp, "_column_cell", None)
    original_session_table_columns = getattr(AgentsViewApp, "_session_table_columns", None)
    original_apply_theme = getattr(AgentsViewApp, "_apply_theme", None)
    original_on_mount = getattr(AgentsViewApp, "on_mount", None)

    def _visual_status_cell(self: Any, session: Any) -> Text:
        status = _status_key(getattr(session, "status", "unknown"))
        is_active = getattr(session, "state", "") == "active"
        icon = get_status_icon(status, animated=is_active)
        return Text(icon, style=_status_style(self, status))

    def _visual_role_cell(self: Any, session: Any) -> Text:
        role = (getattr(session, "role", "") or "").strip().lower()
        badge = ROLE_BADGES.get(role, "·")
        if role == "orchestrator":
            style = f"bold {_theme_value(self, 'accent_orange', '#f0883e')}"
        elif role == "default":
            style = f"bold {_theme_value(self, 'accent_blue', '#6cb6ff')}"
        else:
            style = _theme_value(self, "text_dim", "#636e7b")
        return Text(badge, style=style)

    def _visual_ctx_cell(self: Any, session: Any) -> Text:
        pct = getattr(session, "context_usage_pct", None)
        normalized = _normalize_pct(pct)
        bar = render_context_bar(pct, width=5)
        styled = Text(bar, style=_context_style(self, pct))
        if normalized is not None:
            pct_label = f"{int(round(normalized)):>2d}%"
            styled.append(pct_label, style=_context_style(self, pct))
        return styled

    def _visual_age_cell(self: Any, session: Any) -> Text:
        start_ts = getattr(session, "session_start_ts", None)
        fallback_ts = getattr(session, "last_activity_ts", None)
        label = format_session_age(start_ts if start_ts is not None else fallback_ts)
        style = _theme_value(self, "text_primary", "#adbac7") if label != "—" else _theme_value(self, "text_dim", "#636e7b")
        return Text(label, style=style)

    def _visual_cost_cell(self: Any, session: Any) -> Text:
        cost = getattr(session, "cost_usd", 0.0)
        rendered = render_cost_display(cost)
        style = _theme_value(self, "accent_orange", "#f0883e") if rendered != "$0.00" else _theme_value(self, "text_dim", "#636e7b")
        return Text(rendered, style=style)

    def _visual_column_cell(self: Any, column_key: str, session: Any) -> Text:
        if column_key == "cost":
            return _visual_cost_cell(self, session)
        if callable(original_column_cell):
            return original_column_cell(self, column_key, session)
        return Text("", style=_theme_value(self, "text_dim", "#636e7b"))

    def _visual_session_table_columns(self: Any) -> list[tuple[str, str, int]]:
        if callable(original_session_table_columns):
            return list(original_session_table_columns(self))

        column_defs: list[tuple[str, str, int]] = [
            ("status", "STATUS", 8),
            ("harness", "HARNESS", 8),
            ("role", "ROLE", 7),
            ("session", "SESSION", 28),
            ("branch", "BRANCH", 36),
            ("age", "AGE", 5),
            ("elapsed", "ELAPSED", 7),
            ("ctx", "CTX", 8),
            ("repo", "REPO", 16),
        ]

        enabled = getattr(self, "_column_config", {})
        locked = {"status", "session"}
        visible: list[tuple[str, str, int]] = []
        for key, label, width in column_defs:
            if key in locked or enabled.get(key, True):
                visible.append((key, label, width))
        return visible

    def _animate_running_status_icons(self: Any) -> None:
        try:
            table = self.query_one("#session-table", DataTable)
        except Exception:
            return
        ordered_keys = list(getattr(self, "_ordered_keys", []))
        session_map = dict(getattr(self, "_session_map", {}))
        for key in ordered_keys:
            if _is_separator_key(str(key)):
                continue
            session = session_map.get(key)
            if session is None:
                continue
            if _status_key(getattr(session, "status", "")) != "running":
                continue
            try:
                table.update_cell(key, "status", self._status_cell(session), update_width=False)
            except Exception:
                continue

    async def _visual_on_mount(self: Any) -> None:
        if callable(original_on_mount):
            await original_on_mount(self)
        if getattr(self, "_visual_spinner_timer_started", False):
            return
        try:
            self.set_interval(0.1, self._animate_running_status_icons)
            self._visual_spinner_timer_started = True
        except Exception:
            pass

    def _visual_apply_theme(self: Any, theme: dict[str, str]) -> None:
        if callable(original_apply_theme):
            original_apply_theme(self, theme)

        palette = dict(theme) if isinstance(theme, dict) else {}
        for key, fallback in (
            ("bg_primary", "#22272e"),
            ("bg_secondary", "#2d333b"),
            ("border", "#444c56"),
            ("text_dim", "#636e7b"),
            ("text_primary", "#adbac7"),
            ("accent_blue", "#6cb6ff"),
        ):
            palette.setdefault(key, fallback)

        try:
            tab_bar = self.query_one(ProjectTabBar)
            tab_bar.styles.background = palette["bg_secondary"]
            tab_bar.styles.color = palette["text_dim"]
            tab_bar.styles.border = ("round", palette["border"])
            setattr(tab_bar, "_ve_theme", palette)
            tab_bar.refresh()
        except Exception:
            pass

        try:
            resource_bar = self.query_one(ResourceBar)
            resource_bar.styles.background = palette["bg_primary"]
            resource_bar.styles.color = palette["text_primary"]
            resource_bar.styles.border = ("round", palette["border"])
            setattr(resource_bar, "_ve_theme", palette)
            resource_bar.refresh()
        except Exception:
            pass

    def _resource_update_stats(
        self: Any,
        sessions: list[Any],
        follow_mode: bool | None = None,
        pivot_mode: bool | None = None,
    ) -> None:
        running_count = 0
        stalled_count = 0
        done_count = 0
        idle_count = 0
        total_cost = 0.0

        for session in sessions:
            status = _status_key(getattr(session, "status", "unknown"))
            state = (getattr(session, "state", "") or "").strip().lower()
            if status == "running" and state == "active":
                running_count += 1
            elif status == "stalled":
                stalled_count += 1
            elif status == "done" or state == "inactive":
                done_count += 1
            else:
                idle_count += 1

            try:
                parsed = float(getattr(session, "cost_usd", 0.0) or 0.0)
            except (TypeError, ValueError):
                parsed = 0.0
            if math.isfinite(parsed) and parsed > 0:
                total_cost += parsed

        self._ve_running = running_count
        self._ve_stalled = stalled_count
        self._ve_done = done_count
        self._ve_idle = idle_count
        self._ve_total_cost = total_cost

        if follow_mode is not None:
            self._follow_mode = follow_mode
        if pivot_mode is not None:
            self._pivot_mode = pivot_mode

        self.refresh()

    def _resource_render(self: Any) -> Text:
        palette = getattr(self, "_ve_theme", {})
        if not isinstance(palette, dict):
            palette = {}

        text_dim = palette.get("text_dim", "#636e7b")
        accent_blue = palette.get("accent_blue", "#6cb6ff")
        accent_red = palette.get("accent_red", "#f85149")
        accent_green = palette.get("accent_green", "#3fb950")
        accent_amber = palette.get("accent_amber", "#d4a72c")

        resources: dict[str, float] = {}
        try:
            resources = _get_sys_resources()  # type: ignore[assignment]
        except Exception:
            resources = {}

        mem = resources.get("mem")
        cpu = resources.get("cpu")

        def _pct(value: object) -> str:
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                return f"{float(value):.0f}%"
            return "--"

        mem_pct = _pct(mem)
        cpu_pct = _pct(cpu)

        mem_style = text_dim
        if isinstance(mem, (int, float)):
            mem_value = float(mem)
            mem_style = accent_green if mem_value < 50 else accent_amber if mem_value <= 80 else accent_red

        cpu_style = text_dim
        if isinstance(cpu, (int, float)):
            cpu_value = float(cpu)
            cpu_style = accent_green if cpu_value < 40 else accent_amber if cpu_value <= 80 else accent_red

        text = Text()
        text.append(f"● {getattr(self, '_ve_running', 0)} running", style=f"bold {accent_blue}")
        text.append("  ", style=text_dim)
        text.append(f"⚠ {getattr(self, '_ve_stalled', 0)} stalled", style=f"bold {accent_red}")
        text.append("  ", style=text_dim)
        text.append(f"✓ {getattr(self, '_ve_done', 0)} done", style=f"bold {accent_green}")
        text.append("  ", style=text_dim)
        text.append(f"○ {getattr(self, '_ve_idle', 0)} idle", style=text_dim)
        text.append("  │  ", style=text_dim)
        text.append(render_cost_display(getattr(self, "_ve_total_cost", 0.0)), style=accent_amber)
        text.append("  │  ", style=text_dim)
        text.append(f"mem: {mem_pct}", style=mem_style)
        text.append("  ", style=text_dim)
        text.append(f"cpu: {cpu_pct}", style=cpu_style)

        if getattr(self, "_follow_mode", False):
            text.append("  │  ", style=text_dim)
            text.append("FOLLOW", style=accent_amber)
        if getattr(self, "_pivot_mode", False):
            text.append("  │  ", style=text_dim)
            text.append("PIVOT", style=accent_blue)

        return text

    def _project_tab_render(self: Any) -> Text:
        palette = getattr(self, "_ve_theme", {})
        if not isinstance(palette, dict):
            palette = {}

        accent = palette.get("accent_blue", "#6cb6ff")
        muted = palette.get("text_dim", "#636e7b")
        bright = palette.get("text_primary", "#adbac7")
        divider = palette.get("border", "#444c56")

        tabs = list(getattr(self, "_tabs", []))
        active_idx = int(getattr(self, "_active_idx", 0))

        rendered = Text()
        for index, (label, _) in enumerate(tabs):
            marker = "◉" if index == active_idx else "○"
            if index == active_idx:
                rendered.append(f" {marker} {label} ", style=f"bold {bright} on {accent} underline")
            else:
                rendered.append(f" {marker} {label} ", style=muted)
            if index < len(tabs) - 1:
                rendered.append("│", style=divider)
        return rendered

    AgentsViewApp._session_table_columns = _visual_session_table_columns  # type: ignore[attr-defined,method-assign,assignment]
    AgentsViewApp._animate_running_status_icons = _animate_running_status_icons  # type: ignore[attr-defined,method-assign,assignment]
    AgentsViewApp._apply_theme = _visual_apply_theme  # type: ignore[attr-defined,method-assign,assignment]
    AgentsViewApp.on_mount = _visual_on_mount  # type: ignore[attr-defined,method-assign,assignment]


    AgentsViewApp._visual_enhancements_patched = True  # type: ignore[attr-defined]


_patch_app()

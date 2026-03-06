"""status_bar_enhancements.py - Enhanced stats bar and footer display."""

from __future__ import annotations

from datetime import datetime
import math
import re
from typing import Any

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

_RESET = "\x1b[0m"
_DIM = "\x1b[2m"
_BOLD = "\x1b[1m"
_RED = "\x1b[31m"
_GREEN = "\x1b[32m"
_AMBER = "\x1b[33m"
_BLUE = "\x1b[34m"
_CYAN = "\x1b[36m"

_SEPARATOR = f"  {_DIM}│{_RESET}  "
_FOOTER_HINT = "↑↓ Navigate  Enter Jump  / Filter  ? Help  ctrl+n New  ctrl+k Kill  ctrl+t Theme"

_STATUS_ICON = {
    "running": "⟳",
    "delegating": "⟳",
    "stalled": "⚠",
    "done": "✓",
    "wait": "⌛",
    "waiting": "⌛",
    "asking": "❓",
    "review": "❓",
    "idle": "○",
    "unknown": "·",
}


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return parsed


def _plain_len(value: str) -> int:
    return len(_ANSI_RE.sub("", value))


def _truncate_text(value: str, width: int) -> str:
    compact = " ".join(str(value).split())
    if width <= 0:
        return ""
    if len(compact) <= width:
        return compact
    if width <= 1:
        return "…"
    return compact[: width - 1] + "…"


def _status_key(session: Any) -> str:
    status = str(getattr(session, "status", "unknown") or "unknown").strip().lower()
    if status in {"complete", "completed", "success"}:
        return "done"
    if status == "offline":
        return "idle"
    return status


def _session_title(session: Any) -> str:
    for attr in ("display_title", "title", "session_id"):
        value = str(getattr(session, attr, "") or "").strip()
        if value:
            return value
    return "session"


def _session_segment(session: Any, title_limit: int = 48) -> str:
    status = _status_key(session)
    icon = _STATUS_ICON.get(status, _STATUS_ICON["unknown"])
    title = _truncate_text(_session_title(session), title_limit)
    return f"{_BOLD}Session:{_RESET} {title} [{status} {icon}]"


def _render_line(parts: list[str], clock_segment: str) -> str:
    visible_parts = [part for part in parts if part]
    if visible_parts:
        return f"  {_SEPARATOR.join([*visible_parts, clock_segment])}"
    return f"  {clock_segment}"


def _with_footer_hints(base: str) -> str:
    text = str(base or "").strip()
    if _FOOTER_HINT in text:
        return text
    if not text:
        return _FOOTER_HINT
    return f"{text}  │  {_FOOTER_HINT}"


def format_stats_bar(
    sessions: list[Any],
    system_resources: dict[str, Any],
    follow_mode: bool = False,
    pivot_mode: bool = False,
    filter_active: bool = False,
    selected_session: Any = None,
    width: int = 120,
) -> str:
    """Render an enhanced stats bar string with ANSI colors."""
    current_time = f"{_DIM}{datetime.now().strftime('%H:%M:%S')}{_RESET}"

    if not sessions:
        empty_mode_labels: list[str] = []
        if filter_active:
            empty_mode_labels.append(f"{_CYAN}FILTER{_RESET}")
        if follow_mode:
            empty_mode_labels.append(f"{_GREEN}FOLLOW{_RESET}")
        if pivot_mode:
            empty_mode_labels.append(f"{_AMBER}PIVOT{_RESET}")
        if not empty_mode_labels:
            return "No sessions"
        empty_text = f"{_DIM}No sessions{_RESET}"
        parts = [" ".join(empty_mode_labels).strip(), empty_text]
        return _render_line(parts, current_time)

    counts: dict[str, int] = {}
    total_cost = 0.0
    total_tokens = 0

    for session in sessions:
        key = _status_key(session)
        counts[key] = counts.get(key, 0) + 1
        total_cost += max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0))
        total_tokens += max(0, _safe_int(getattr(session, "total_tokens_in", 0), 0))
        total_tokens += max(0, _safe_int(getattr(session, "total_tokens_out", 0), 0))

    running = counts.get("running", 0) + counts.get("delegating", 0)
    stalled = counts.get("stalled", 0)
    done = counts.get("done", 0)
    idle = counts.get("idle", 0) + counts.get("offline", 0)
    waiting_up = counts.get("asking", 0) + counts.get("review", 0)
    waiting_down = counts.get("wait", 0) + counts.get("waiting", 0)

    status_bits: list[str] = []
    if running:
        status_bits.append(f"{_CYAN}● {running} running{_RESET}")
    if stalled:
        status_bits.append(f"{_RED}⚠ {stalled} stalled{_RESET}")
    if done:
        status_bits.append(f"{_GREEN}✓ {done} done{_RESET}")

    if idle or not status_bits:
        status_bits.append(f"{_DIM}○ {idle} idle{_RESET}")

    status_segment = "  ".join(status_bits)

    waiting_segment = ""
    if waiting_up or waiting_down:
        waiting_segment = (
            f"{_BLUE}⬆ {waiting_up}{_RESET} "
            f"{_AMBER}⬇ {waiting_down} waiting{_RESET}"
        )

    cost_segment = ""
    if total_cost > 0:
        cost_segment = f"{_AMBER}${total_cost:.2f}/day{_RESET}"

    token_segment = ""
    if total_tokens > 0:
        token_segment = f"{_DIM}{total_tokens / 1000:.0f}K tok{_RESET}"

    mem = _safe_float(system_resources.get("mem", 0.0), 0.0)
    cpu = _safe_float(system_resources.get("cpu", 0.0), 0.0)
    mem_color = _RED if mem >= 80 else (_AMBER if mem >= 60 else _DIM)
    cpu_color = _RED if cpu >= 80 else (_AMBER if cpu >= 60 else _DIM)
    resources_segment = f"{mem_color}mem: {mem:.0f}%{_RESET}  {cpu_color}cpu: {cpu:.0f}%{_RESET}"

    mode_labels: list[str] = []
    if filter_active:
        mode_labels.append(f"{_CYAN}FILTER{_RESET}")
    if follow_mode:
        mode_labels.append(f"{_GREEN}FOLLOW{_RESET}")
    if pivot_mode:
        mode_labels.append(f"{_AMBER}PIVOT{_RESET}")
    mode_segment = " ".join(mode_labels)

    session_segment = _session_segment(selected_session) if selected_session is not None else ""

    ordered_parts: list[tuple[str, bool, str]] = [
        (session_segment, False, "session"),
        (mode_segment, False, "mode"),
        (status_segment, True, "status"),
        (waiting_segment, False, "waiting"),
        (cost_segment, False, "cost"),
        (token_segment, False, "tokens"),
        (resources_segment, False, "resources"),
    ]

    active = [entry for entry in ordered_parts if entry[0]]

    def _line_from_active() -> str:
        return _render_line([part for part, _, _ in active], current_time)

    rendered = _line_from_active()
    max_width = max(40, _safe_int(width, 120))

    if _plain_len(rendered) > max_width and selected_session is not None:
        for title_limit in (40, 32, 24, 18, 12, 10, 8, 6):
            reduced_session = _session_segment(selected_session, title_limit=title_limit)
            active = [
                (reduced_session, False, "session") if tag == "session" else (part, required, tag)
                for part, required, tag in active
            ]
            rendered = _line_from_active()
            if _plain_len(rendered) <= max_width:
                break

    drop_priority = ["resources", "tokens", "cost", "waiting", "mode", "session"]
    while _plain_len(rendered) > max_width:
        removed = False
        for tag in drop_priority:
            idx = next((i for i, (_, required, t) in enumerate(active) if t == tag and not required), None)
            if idx is None:
                continue
            active.pop(idx)
            removed = True
            break
        rendered = _line_from_active()
        if not removed:
            plain = _ANSI_RE.sub("", rendered)
            if len(plain) <= max_width:
                return plain
            if max_width <= 1:
                return "…"
            return plain[: max_width - 1] + "…"

    return rendered


def _patch_app() -> None:
    try:
        from textual.widgets import Input, Static

        from agents_view.app import AgentsViewApp, _get_sys_resources
    except Exception:
        return

    if getattr(AgentsViewApp, "_status_bar_enhancements_patched", False):
        return

    original_update_stats_bar = getattr(AgentsViewApp, "_update_stats_bar", None)
    original_on_mount = getattr(AgentsViewApp, "on_mount", None)
    original_update_scope_subtitle = getattr(AgentsViewApp, "_update_scope_subtitle", None)
    original_update_subtitle = getattr(AgentsViewApp, "_update_subtitle", None)

    def _is_filter_active(app: Any) -> bool:
        try:
            focused = getattr(app, "focused", None)
            if focused is not None and getattr(focused, "id", None) == "filter-input":
                return True
        except Exception:
            pass
        try:
            return bool(app.query_one("#filter-input", Input).has_focus)
        except Exception:
            return False

    def _selected_session_for_stats(app: Any) -> Any:
        current = getattr(app, "_current_session", None)
        if callable(current):
            try:
                selected = current()
            except Exception:
                selected = None
            if selected is not None:
                return selected
        return getattr(app, "_selected_session", None)

    def _status_modes_enabled(app: Any) -> bool:
        return bool(
            getattr(app, "_auto_follow", False)
            or getattr(app, "_pivot_mode", False)
            or _is_filter_active(app)
        )

    def _update_footer_hint_line(self: Any) -> None:
        if not _status_modes_enabled(self):
            return
        try:
            current = str(getattr(self, "sub_title", "") or "")
            self.sub_title = _with_footer_hints(current)
        except Exception:
            return

    def _update_stats_bar_enhanced(self: Any) -> None:
        if callable(original_update_stats_bar):
            original_update_stats_bar(self)

        follow_mode = bool(getattr(self, "_auto_follow", False))
        pivot_mode = bool(getattr(self, "_pivot_mode", False))
        filter_active = _is_filter_active(self)
        if callable(original_update_stats_bar) and not (follow_mode or pivot_mode or filter_active):
            return

        try:
            stats_bar = self.query_one("#stats-bar", Static)
        except Exception:
            return

        sessions = list(getattr(self, "_sessions", []))
        resources: dict[str, Any] = {}
        try:
            resources = dict(_get_sys_resources() or {})
        except Exception:
            resources = {}

        width = max(40, _safe_int(getattr(getattr(self, "size", None), "width", 120), 120))
        line = format_stats_bar(
            sessions=sessions,
            system_resources=resources,
            follow_mode=follow_mode,
            pivot_mode=pivot_mode,
            filter_active=filter_active,
            selected_session=_selected_session_for_stats(self),
            width=width,
        )
        stats_bar.update(line)

    async def _enhanced_on_mount(self: Any) -> None:
        if callable(original_on_mount):
            await original_on_mount(self)

        if not getattr(self, "_status_bar_clock_timer_started", False):
            try:
                self.set_interval(1.0, self._update_stats_bar)
                self._status_bar_clock_timer_started = True
            except Exception:
                pass

        self._update_footer_hint_line()

    def _enhanced_update_scope_subtitle(self: Any) -> None:
        if callable(original_update_scope_subtitle):
            original_update_scope_subtitle(self)
        self._update_footer_hint_line()

    def _enhanced_update_subtitle(self: Any) -> None:
        if callable(original_update_subtitle):
            original_update_subtitle(self)
        self._update_footer_hint_line()

    AgentsViewApp._format_stats_bar = staticmethod(format_stats_bar)  # type: ignore[attr-defined]
    AgentsViewApp._update_footer_hint_line = _update_footer_hint_line  # type: ignore[attr-defined,method-assign]
    AgentsViewApp._update_stats_bar = _update_stats_bar_enhanced  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.on_mount = _enhanced_on_mount  # type: ignore[attr-defined,method-assign]

    if callable(original_update_scope_subtitle):
        AgentsViewApp._update_scope_subtitle = _enhanced_update_scope_subtitle  # type: ignore[attr-defined,method-assign]
    if callable(original_update_subtitle):
        AgentsViewApp._update_subtitle = _enhanced_update_subtitle  # type: ignore[attr-defined,method-assign]

    AgentsViewApp._status_bar_enhancements_patched = True  # type: ignore[attr-defined]


_patch_app()

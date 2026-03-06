"""cost_tracker.py - Budget tracking and cost alerts for agents view.

Provides:
- Configurable daily and total budgets with alert thresholds
- Cost progress indicator in the stats bar
- Per-session cost/tokens/tools display in preview status
- Cost breakdown screen and daily cost reset action
"""

from __future__ import annotations

import json
import math
import time
from datetime import date
from pathlib import Path
from typing import Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Static

_SETTINGS_FILE = Path.home() / ".omp" / "agents-view-settings.json"
_DEFAULT_DAILY_BUDGET = 10.0
_DEFAULT_TOTAL_BUDGET = 0.0
_RESET_DATE_KEY = "daily_cost_reset_date"
_RESET_OFFSET_KEY = "daily_cost_reset_offset_usd"

_ALERT_WARNED_AT: str | None = None
_ALERT_CRITICAL_AT: str | None = None
_BANNER_ACTIVE = False


def _today_key() -> str:
    return date.today().isoformat()


def _safe_float(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float, str)):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return default
        if not math.isfinite(parsed):
            return default
        return parsed
    return default


def _safe_non_negative_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return max(0, int(float(value)))
        except (TypeError, ValueError):
            return 0
    return 0


def _load_settings() -> dict[str, Any]:
    try:
        payload = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _save_settings(payload: dict[str, Any]) -> None:
    try:
        _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_path = _SETTINGS_FILE.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temp_path.replace(_SETTINGS_FILE)
    except Exception:
        pass


def get_daily_budget() -> float:
    """Get configured daily budget from settings."""
    payload = _load_settings()
    budget = _safe_float(payload.get("daily_budget_usd"), _DEFAULT_DAILY_BUDGET)
    return budget if budget >= 0 else _DEFAULT_DAILY_BUDGET


def get_total_budget() -> float:
    """Get optional total budget from settings (0 disables total-budget alerts)."""
    payload = _load_settings()
    budget = _safe_float(payload.get("total_budget_usd"), _DEFAULT_TOTAL_BUDGET)
    return budget if budget >= 0 else _DEFAULT_TOTAL_BUDGET


def get_today_cost(sessions: list[object]) -> float:
    """Calculate total cost across all sessions for today."""
    today_start = time.mktime(date.today().timetuple())
    today_end = today_start + 86_400
    total = 0.0
    with_start_ts = 0
    for session in sessions:
        ts = getattr(session, "session_start_ts", None)
        if ts is None:
            continue
        with_start_ts += 1
        ts_value = _safe_float(ts, -1.0)
        if today_start <= ts_value < today_end:
            total += max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0))

    # Approximation fallback when timestamps are absent on all sessions.
    if with_start_ts == 0:
        total = sum(max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0)) for session in sessions)
    return total


def _today_reset_offset() -> float:
    payload = _load_settings()
    if str(payload.get(_RESET_DATE_KEY, "")) != _today_key():
        return 0.0
    return max(0.0, _safe_float(payload.get(_RESET_OFFSET_KEY), 0.0))


def get_effective_today_cost(sessions: list[object]) -> float:
    """Return today's cost minus any manual reset baseline for the current day."""
    raw_today = get_today_cost(sessions)
    return max(0.0, raw_today - _today_reset_offset())


def get_total_cost(sessions: list[object]) -> float:
    """Return total cost across all visible sessions."""
    return sum(max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0)) for session in sessions)


def render_cost_bar(cost: float, budget: float, width: int = 10) -> str:
    """Render a compact Unicode progress bar for budget usage."""
    if budget <= 0:
        return ""
    pct = min(max(cost / budget, 0.0), 1.0)
    filled = int(round(pct * width))
    filled = min(width, max(0, filled))
    return f"[{('█' * filled) + ('░' * (width - filled))}]"


def _cost_style(pct: float) -> str:
    if pct < 0.5:
        return "#3fb950"
    if pct < 0.8:
        return "#d4a72c"
    return "bold #f85149"


def _append_text(base: object, extra: Text) -> Text:
    if isinstance(base, Text):
        merged = base.copy()
    elif base is None:
        merged = Text()
    else:
        merged = Text(str(base), style="#adbac7")
    if merged.plain:
        merged.append("  │  ", style="#636e7b")
    merged.append_text(extra)
    return merged


def _set_alert_banner(app: Any, message: str) -> None:
    global _BANNER_ACTIVE
    scope_subtitle = ""
    scope_fn = getattr(app, "_scope_subtitle", None)
    if callable(scope_fn):
        try:
            scope_subtitle = str(scope_fn())
        except Exception:
            scope_subtitle = ""
    try:
        subtitle = f"{scope_subtitle} | {message}" if scope_subtitle else message
        setattr(app, "sub_title", subtitle)
        _BANNER_ACTIVE = True
    except Exception:
        pass

def _clear_alert_banner(app: Any) -> None:
    global _BANNER_ACTIVE
    if not _BANNER_ACTIVE:
        return
    refresh_subtitle = getattr(app, "_update_scope_subtitle", None)
    if callable(refresh_subtitle):
        try:
            refresh_subtitle()
        except Exception:
            pass
    else:
        try:
            setattr(app, "sub_title", "")
        except Exception:
            pass
    _BANNER_ACTIVE = False

def _maybe_emit_budget_alerts(app: Any, ratio: float, cost: float, budget: float) -> None:
    global _ALERT_WARNED_AT, _ALERT_CRITICAL_AT

    if budget <= 0:
        _ALERT_WARNED_AT = None
        _ALERT_CRITICAL_AT = None
        _clear_alert_banner(app)
        return

    day_key = _today_key()

    if ratio < 0.8:
        _ALERT_WARNED_AT = None
    if ratio < 0.95:
        _ALERT_CRITICAL_AT = None

    notify = getattr(app, "notify", None)
    if ratio >= 0.8 and _ALERT_WARNED_AT != day_key and callable(notify):
        notify(
            f"Budget warning: ${cost:.2f} / ${budget:.2f} ({int(ratio * 100)}%)",
            severity="warning",
            timeout=5,
        )
        _ALERT_WARNED_AT = day_key

    if ratio >= 0.95:
        if _ALERT_CRITICAL_AT != day_key and callable(notify):
            notify(
                f"Budget critical: ${cost:.2f} / ${budget:.2f} ({int(ratio * 100)}%)",
                severity="error",
                timeout=8,
            )
            _ALERT_CRITICAL_AT = day_key
        _set_alert_banner(app, f"🔴 BUDGET ALERT: ${cost:.2f} / ${budget:.2f}")
    else:
        _clear_alert_banner(app)


class CostBreakdownScreen(Screen):
    """Shows cost breakdown by session."""

    BINDINGS = [Binding("escape,q", "dismiss", "Close")]

    CSS = """
    CostBreakdownScreen {
        align: center middle;
        background: #22272e80;
    }

    #cost-container {
        width: 96;
        height: 36;
        border: round #444c56;
        background: #22272e;
        padding: 1;
    }

    #cost-title {
        content-align: center middle;
        text-style: bold;
        color: #cdd9e5;
        margin-bottom: 1;
    }

    #cost-table {
        height: 1fr;
    }

    #cost-total {
        color: #adbac7;
        margin-top: 1;
    }
    """

    def __init__(self, sessions: list[object]) -> None:
        super().__init__()
        self._sessions = sessions

    def compose(self) -> ComposeResult:
        with Vertical(id="cost-container"):
            yield Static("💰 Cost Breakdown", id="cost-title")
            yield DataTable(id="cost-table")
            yield Static("", id="cost-total")

    def on_mount(self) -> None:
        table = self.query_one("#cost-table", DataTable)
        table.cursor_type = "row"
        table.add_columns("Session", "Cost", "Tokens In", "Tokens Out", "Tools")

        sessions_sorted = sorted(
            self._sessions,
            key=lambda session: _safe_float(getattr(session, "cost_usd", 0.0), 0.0),
            reverse=True,
        )

        total_cost = 0.0
        total_in = 0
        total_out = 0
        total_tools = 0

        for session in sessions_sorted:
            title = str(getattr(session, "title", "")) or str(getattr(session, "session_id", "session"))
            cost = max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0))
            tok_in = _safe_non_negative_int(getattr(session, "total_tokens_in", 0))
            tok_out = _safe_non_negative_int(getattr(session, "total_tokens_out", 0))
            tools = _safe_non_negative_int(getattr(session, "total_tool_calls", 0))

            total_cost += cost
            total_in += tok_in
            total_out += tok_out
            total_tools += tools

            table.add_row(
                title[:42],
                f"${cost:.4f}",
                f"{tok_in:,}",
                f"{tok_out:,}",
                f"{tools:,}",
            )

        table.add_row(
            "TOTAL",
            f"${total_cost:.4f}",
            f"{total_in:,}",
            f"{total_out:,}",
            f"{total_tools:,}",
        )

        self.query_one("#cost-total", Static).update(
            f"Sessions: {len(self._sessions)}   Total cost: ${total_cost:.4f}"
        )

    async def action_dismiss(self, result: object | None = None) -> None:
        self.dismiss(result)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    original_preview_status_line = getattr(AgentsViewApp, "_preview_status_line", None)

    if callable(original_preview_status_line):

        def _preview_status_line_with_cost(self: Any, session: object) -> Text:
            original_line = original_preview_status_line(self, session)
            preview_line = Text()

            cost = max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0))
            tokens_in = _safe_non_negative_int(getattr(session, "total_tokens_in", 0))
            tokens_out = _safe_non_negative_int(getattr(session, "total_tokens_out", 0))
            total_tokens = tokens_in + tokens_out
            tool_calls = _safe_non_negative_int(getattr(session, "total_tool_calls", 0))

            preview_line.append(f"💰 ${cost:.2f}", style="bold #f0883e")
            preview_line.append(" | ", style="#636e7b")
            preview_line.append(
                f"{total_tokens:,} tokens",
                style="#79c0ff" if total_tokens else "#636e7b",
            )
            preview_line.append(" | ", style="#636e7b")
            preview_line.append(
                f"{tool_calls:,} tool calls",
                style="#adbac7" if tool_calls else "#636e7b",
            )

            if isinstance(original_line, Text) and original_line.plain.strip():
                preview_line.append("   ", style="#444c56")
                preview_line.append_text(original_line)
            return preview_line

        AgentsViewApp._preview_status_line = _preview_status_line_with_cost  # type: ignore[attr-defined,method-assign,assignment]

    def _action_cost_breakdown(self: Any) -> None:
        sessions = list(getattr(self, "_sessions", []))
        self.push_screen(CostBreakdownScreen(sessions))

    def _action_reset_daily_cost(self: Any) -> None:
        sessions = list(getattr(self, "_sessions", []))
        payload = _load_settings()
        payload[_RESET_DATE_KEY] = _today_key()
        payload[_RESET_OFFSET_KEY] = get_today_cost(sessions)
        _save_settings(payload)

        global _ALERT_WARNED_AT, _ALERT_CRITICAL_AT
        _ALERT_WARNED_AT = None
        _ALERT_CRITICAL_AT = None
        _clear_alert_banner(self)

        refresh = getattr(self, "_update_stats_bar", None)
        if callable(refresh):
            refresh()

        notify = getattr(self, "notify", None)
        if callable(notify):
            notify("Today's cost counter reset", severity="information", timeout=4)

    AgentsViewApp.action_cost_breakdown = _action_cost_breakdown  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.action_reset_daily_cost = _action_reset_daily_cost  # type: ignore[attr-defined,method-assign]

    existing_actions = {getattr(binding, "action", "") for binding in list(AgentsViewApp.BINDINGS)}
    if "cost_breakdown" not in existing_actions:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding("$,ctrl+shift+4", "cost_breakdown", "Cost breakdown")
        ]
    if "reset_daily_cost" not in existing_actions:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding("ctrl+shift+r", "reset_daily_cost", "Reset today cost", show=False)
        ]

    if ("Screens", "$", "Cost breakdown") not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(("Screens", "$", "Cost breakdown"))
    if ("Session", "Ctrl+Shift+R", "Reset today cost") not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(("Session", "Ctrl+Shift+R", "Reset today cost"))


_patch_app()

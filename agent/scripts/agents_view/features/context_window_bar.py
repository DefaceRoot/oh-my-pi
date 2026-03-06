"""context_window_bar.py - Visual context window usage bar in preview header."""
from __future__ import annotations

import re
import time
from typing import Any

_MODEL_CONTEXT_SIZES: dict[str, int] = {
    "claude-opus-4-5": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-haiku-4-5": 200_000,
    "claude-3-opus": 200_000,
    "claude-3-sonnet": 200_000,
    "claude-opus": 200_000,
    "claude-sonnet": 200_000,
    "claude-haiku": 200_000,
    "gpt-4o": 128_000,
    "gpt-4": 128_000,
    "gpt-3.5": 16_385,
}

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _safe_float(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float, str)):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return default
        if parsed != parsed or parsed in (float("inf"), float("-inf")):
            return default
        return parsed
    return default


def _safe_non_negative_int(value: object) -> int:
    return max(0, int(_safe_float(value, 0.0)))


def _normalize_pct(value: object) -> float:
    raw = _safe_float(value, 0.0)
    pct = raw * 100.0 if raw <= 1.0 else raw
    return max(0.0, min(pct, 100.0))


def _format_tokens(tokens: int) -> str:
    if tokens >= 1_000_000:
        return f"{tokens / 1_000_000:.1f}M"
    if tokens >= 1_000:
        return f"{tokens / 1_000:.1f}K"
    return str(tokens)


def _format_runtime(session: Any) -> str:
    elapsed = str(getattr(session, "elapsed_str", "") or "").strip()
    if elapsed:
        return elapsed

    start_ts = _safe_float(getattr(session, "session_start_ts", 0.0), 0.0)
    if start_ts <= 0:
        return "—"

    delta = max(0, int(time.time() - start_ts))
    hours, rem = divmod(delta, 3600)
    minutes = rem // 60
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m"
    return f"{delta}s"


def _visible_length(text: str) -> int:
    return len(_ANSI_RE.sub("", text))


def _fit_visible(text: str, width: int) -> str:
    if width <= 0:
        return ""

    visible = _visible_length(text)
    if visible <= width:
        return text + (" " * (width - visible))

    plain = _ANSI_RE.sub("", text)
    if width == 1:
        return "…"
    return (plain[: width - 1] + "…").ljust(width)


def _box_line(content: str, inner_width: int) -> str:
    content_width = max(1, inner_width - 2)
    return f"│ {_fit_visible(content, content_width)} │"


def get_context_window_size(model: str) -> int:
    """Get context window size for a model."""
    model_lower = model.lower() if model else ""
    for key, size in _MODEL_CONTEXT_SIZES.items():
        if key in model_lower:
            return size
    return 200_000


def render_progress_bar(pct: float, width: int = 20) -> str:
    """Render a Unicode block progress bar."""
    safe_width = max(1, int(width))
    safe_pct = max(0.0, min(_safe_float(pct, 0.0), 100.0))
    filled = int(round((safe_pct / 100.0) * safe_width))
    filled = max(0, min(filled, safe_width))
    bar = "█" * filled + "░" * (safe_width - filled)
    return f"[{bar}]"


def get_context_color(pct: float) -> str:
    """Get ANSI color escape for context percentage."""
    safe_pct = max(0.0, min(_safe_float(pct, 0.0), 100.0))
    if safe_pct >= 95:
        return "\x1b[31m"  # Red
    if safe_pct >= 80:
        return "\x1b[38;5;208m"  # Orange
    if safe_pct >= 50:
        return "\x1b[33m"  # Yellow
    return "\x1b[32m"  # Green


def get_context_icon(pct: float) -> str:
    safe_pct = max(0.0, _safe_float(pct, 0.0))
    if safe_pct >= 100:
        return "⛔"
    if safe_pct >= 95:
        return "❗"
    if safe_pct >= 80:
        return "⚠"
    return ""


def render_context_header(session: Any, width: int = 80) -> str:
    """Render a context usage header block for the preview pane."""
    pct = _normalize_pct(getattr(session, "context_usage_pct", None))
    model = str(getattr(session, "model", "") or "")
    ctx_size = get_context_window_size(model)

    tokens_in = _safe_non_negative_int(getattr(session, "total_tokens_in", 0))
    tokens_out = _safe_non_negative_int(getattr(session, "total_tokens_out", 0))
    cost = max(0.0, _safe_float(getattr(session, "cost_usd", 0.0), 0.0))
    tools = _safe_non_negative_int(getattr(session, "total_tool_calls", 0))

    color = get_context_color(pct)
    reset = "\x1b[0m"
    icon = get_context_icon(pct)
    bar = render_progress_bar(pct, width=20)

    icon_prefix = f"{icon} " if icon else ""
    ctx_display = f"{ctx_size // 1000}K"

    line1 = (
        f"{icon_prefix}Context  {color}{bar}{reset}  {pct:.0f}%  of {ctx_display}"
        f"  │  Tokens: {_format_tokens(tokens_in)} in / {_format_tokens(tokens_out)} out"
    )
    line2 = f"Cost: ${cost:.2f}  │  Tools: {tools}  │  ⏱ Running {_format_runtime(session)}"

    total_width = max(48, int(width))
    inner_width = total_width - 2
    separator = "─" * inner_width

    return "\n".join(
        [
            f"╭{separator}╮",
            _box_line(line1, inner_width),
            _box_line(line2, inner_width),
            f"╰{separator}╯",
        ]
    )


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    if getattr(AgentsViewApp, "_context_window_bar_feature_patched", False):
        return

    AgentsViewApp._render_context_header = staticmethod(render_context_header)
    AgentsViewApp._get_context_window_size = staticmethod(get_context_window_size)
    AgentsViewApp._context_window_bar_feature_patched = True


_patch_app()

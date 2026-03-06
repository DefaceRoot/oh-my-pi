"""token_budget_bar.py - Token budget tracking and velocity estimation.
Exposes helpers for total-token counts, tok/hr velocity, and progress bars.
"""
from __future__ import annotations

import time
from typing import Optional

_DEFAULT_DAILY_TOKEN_BUDGET = 1_000_000


def get_total_tokens(sessions: list) -> int:
    """Sum total tokens across all sessions."""
    total = 0
    for session in sessions:
        total += getattr(session, "total_tokens_in", 0) or 0
        total += getattr(session, "total_tokens_out", 0) or 0
    return total


def get_token_velocity(sessions: list, window_hours: float = 1.0) -> float:
    """Estimate tokens per hour from sessions started in the last window."""
    if window_hours <= 0:
        return 0.0
    now = time.time()
    window_start = now - window_hours * 3600
    recent = 0
    for session in sessions:
        ts = getattr(session, "session_start_ts", None)
        if ts and ts >= window_start:
            recent += getattr(session, "total_tokens_in", 0) or 0
            recent += getattr(session, "total_tokens_out", 0) or 0
    return recent / window_hours


def estimate_remaining_hours(
    sessions: list,
    budget: int = _DEFAULT_DAILY_TOKEN_BUDGET,
) -> Optional[float]:
    """Estimate hours until token budget is exhausted."""
    velocity = get_token_velocity(sessions)
    if velocity <= 0:
        return None
    used = get_total_tokens(sessions)
    remaining = budget - used
    if remaining <= 0:
        return 0.0
    return remaining / velocity


def render_token_bar(
    sessions: list,
    budget: int = _DEFAULT_DAILY_TOKEN_BUDGET,
    width: int = 12,
) -> str:
    """Render a compact token-usage progress bar."""
    total = get_total_tokens(sessions)
    pct = min(total / budget * 100, 100.0) if budget > 0 else 0.0
    filled = int(pct / 100 * width)
    bar = "█" * filled + "░" * (width - filled)
    total_k = total / 1000
    budget_k = budget / 1000
    return f"[{bar}] {total_k:.0f}K/{budget_k:.0f}K"


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp

        AgentsViewApp._get_total_tokens = staticmethod(get_total_tokens)
        AgentsViewApp._get_token_velocity = staticmethod(get_token_velocity)
        AgentsViewApp._render_token_bar = staticmethod(render_token_bar)
        AgentsViewApp._estimate_remaining_hours = staticmethod(estimate_remaining_hours)
    except Exception:
        pass


_patch_app()

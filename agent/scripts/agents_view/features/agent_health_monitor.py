"""agent_health_monitor.py - Health scoring for agent sessions.

Computes a 0-100 score based on activity age, status, and context usage.
Exposes compute_health() and render_health_section() for other features.
"""

from __future__ import annotations

import time
from typing import NamedTuple


class HealthReport(NamedTuple):
    score: int
    grade: str  # GOOD / WARN / POOR / CRITICAL
    factors: list[str]
    color: str  # ANSI escape


def compute_health(session: object) -> HealthReport:
    """Compute health report for a session."""
    score = 100
    factors: list[str] = []

    # Factor 1: time since last activity
    last_ts = getattr(session, "last_activity_ts", None)
    if last_ts:
        age = time.time() - last_ts
        if age < 60:
            factors.append(f"✓ Active {int(age)}s ago")
        elif age < 300:
            score -= 10
            factors.append(f"⚠ Last active {int(age / 60)}m ago")
        elif age < 600:
            score -= 30
            factors.append(f"❗ Inactive {int(age / 60)}m")
        else:
            score -= 50
            factors.append(f"⛔ Stalled {int(age / 60)}m")

    # Factor 2: status
    status = getattr(session, "status", "unknown")
    if status == "running":
        factors.append("✓ Running")
    elif status == "asking":
        score -= 5
        factors.append("ℹ Waiting for input")
    elif status == "stalled":
        score -= 40
        factors.append("⛔ STALLED")
    elif status == "done":
        score = 100
        factors.append("✅ Completed")

    # Factor 3: context usage
    ctx_pct = float(getattr(session, "context_usage_pct", None) or 0)
    if ctx_pct >= 95:
        score -= 20
        factors.append(f"❗ Context critical {ctx_pct:.0f}%")
    elif ctx_pct >= 80:
        score -= 10
        factors.append(f"⚠ Context high {ctx_pct:.0f}%")
    else:
        factors.append(f"✓ Context {ctx_pct:.0f}%")

    score = max(0, min(100, score))
    if score >= 80:
        grade, color = "GOOD", "\x1b[32m"
    elif score >= 50:
        grade, color = "WARN", "\x1b[33m"
    elif score >= 20:
        grade, color = "POOR", "\x1b[31m"
    else:
        grade, color = "CRITICAL", "\x1b[31;1m"

    return HealthReport(score=score, grade=grade, factors=factors, color=color)


def render_health_section(session: object) -> str:
    """Render health as a multi-line string for the preview/info panel."""
    report = compute_health(session)
    reset = "\x1b[0m"
    lines = [f"Health: {report.color}{report.grade}{reset} [{report.score}/100]"]
    for factor in report.factors[:5]:
        lines.append(f"  {factor}")
    return "\n".join(lines)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp

        AgentsViewApp._compute_session_health = staticmethod(compute_health)
        AgentsViewApp._render_health_section = staticmethod(render_health_section)
    except Exception:
        pass


_patch_app()

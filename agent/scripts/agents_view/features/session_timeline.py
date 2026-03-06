"""session_timeline.py - Activity sparkline and timeline for sessions."""
from __future__ import annotations

import importlib
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SPARK_CHARS = ("▁", "▂", "▃", "▄", "▅", "▆", "▇", "█")
_TIMESTAMP_KEYS = ("timestamp", "ts", "time", "created_at", "createdAt")
_STATUS_KEYS = ("status", "to", "state", "nextStatus")


def _coerce_timestamp(value: object) -> float | None:
    if isinstance(value, (int, float)):
        numeric = float(value)
        return numeric if numeric > 0 else None

    if not isinstance(value, str):
        return None

    text = value.strip()
    if not text:
        return None

    numeric_val: float | None
    try:
        numeric_val = float(text)
    except ValueError:
        numeric_val = None
    if numeric_val is not None:
        return numeric_val if numeric_val > 0 else None

    iso_value = text
    if text.endswith("Z"):
        iso_value = f"{text[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(iso_value)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _read_recent_jsonl_records(jsonl_path: str | Path, *, max_bytes: int = 32_768) -> list[dict[str, Any]]:
    path = Path(jsonl_path)
    if not path.is_file():
        return []

    try:
        size = path.stat().st_size
    except OSError:
        return []

    offset = max(0, size - max(1, int(max_bytes)))
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            payload = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return []

    if offset > 0 and "\n" in payload:
        payload = payload.split("\n", 1)[1]

    records: list[dict[str, Any]] = []
    for line in payload.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            records.append(parsed)
    return records


def generate_sparkline(
    timestamps: list[float],
    minutes: int = 60,
    width: int = 30,
) -> str:
    """Generate a sparkline from a list of event timestamps.

    Args:
        timestamps: Unix timestamps of events
        minutes: Time window in minutes
        width: Number of sparkline characters
    """
    safe_width = max(1, int(width))
    safe_minutes = max(1, int(minutes))

    if not timestamps:
        return _SPARK_CHARS[0] * safe_width

    now = time.time()
    cutoff = now - safe_minutes * 60
    bucket_duration = (safe_minutes * 60) / safe_width

    buckets: dict[int, int] = defaultdict(int)
    for value in timestamps:
        try:
            ts = float(value)
        except (TypeError, ValueError):
            continue

        if ts < cutoff or ts > now:
            continue

        bucket = int((ts - cutoff) / bucket_duration)
        bucket = max(0, min(bucket, safe_width - 1))
        buckets[bucket] += 1

    if not buckets:
        return _SPARK_CHARS[0] * safe_width

    max_count = max(buckets.values())
    if max_count <= 0:
        return _SPARK_CHARS[0] * safe_width

    spark: list[str] = []
    max_level = len(_SPARK_CHARS) - 1
    for idx in range(safe_width):
        count = buckets.get(idx, 0)
        if count <= 0:
            spark.append(_SPARK_CHARS[0])
            continue
        level = int(round((count / max_count) * max_level))
        level = max(0, min(max_level, level))
        spark.append(_SPARK_CHARS[level])

    return "".join(spark)


def get_session_timestamps(jsonl_path: str | Path) -> list[float]:
    """Extract timestamps from a JSONL session file."""
    now = time.time()
    timestamps: list[float] = []

    for record in _read_recent_jsonl_records(jsonl_path):
        raw_ts: object = None
        for key in _TIMESTAMP_KEYS:
            candidate = record.get(key)
            if candidate is not None:
                raw_ts = candidate
                break

        ts = _coerce_timestamp(raw_ts)
        if ts is None or ts > now:
            continue
        timestamps.append(ts)

    return sorted(timestamps)


def _normalize_status(value: object) -> str | None:
    if not isinstance(value, str):
        return None

    text = value.strip().lower().replace("_", " ")
    if not text:
        return None

    aliases = {
        "running": "running",
        "active": "running",
        "working": "running",
        "stalled": "stalled",
        "idle": "stalled",
        "waiting": "stalled",
        "paused": "stalled",
        "done": "completed",
        "completed": "completed",
        "finished": "completed",
        "failed": "failed",
        "error": "failed",
    }

    if text in aliases:
        return aliases[text]

    head = text.split(" ", 1)[0]
    return aliases.get(head, head)


def get_status_transitions(jsonl_path: str | Path) -> list[tuple[float, str]]:
    """Collect normalized status transitions from a JSONL session file."""
    transitions: list[tuple[float, str]] = []

    for record in _read_recent_jsonl_records(jsonl_path, max_bytes=65_536):
        raw_ts: object = None
        for key in _TIMESTAMP_KEYS:
            candidate = record.get(key)
            if candidate is not None:
                raw_ts = candidate
                break

        timestamp = _coerce_timestamp(raw_ts)
        if timestamp is None:
            continue

        status_value: object = record.get("status")
        event_type = str(record.get("type") or "").strip().lower()
        if event_type == "status_change":
            for key in _STATUS_KEYS:
                candidate = record.get(key)
                if candidate is not None:
                    status_value = candidate
                    break

        status = _normalize_status(status_value)
        if not status:
            continue

        if transitions and transitions[-1][1] == status:
            continue
        transitions.append((timestamp, status))

    return transitions


def _format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)

    if hours > 0:
        return f"{hours}h"
    if minutes > 0:
        return f"{minutes}m"
    return f"{secs}s"


def _timeline_window_minutes(session: object, default_minutes: int = 60) -> int:
    safe_default = max(1, int(default_minutes))
    start_ts = _coerce_timestamp(getattr(session, "session_start_ts", None))
    if start_ts is None:
        return safe_default

    elapsed_seconds = max(0.0, time.time() - start_ts)
    elapsed_minutes = max(1, int(elapsed_seconds // 60) + 1)
    return min(safe_default, elapsed_minutes)


def render_timeline_line(session: object, jsonl_path: str | Path | None = None) -> str:
    """Render a one-line activity timeline for a session."""
    timestamps: list[float]
    if jsonl_path:
        timestamps = get_session_timestamps(jsonl_path)
    else:
        last_activity = _coerce_timestamp(getattr(session, "last_activity_ts", None))
        timestamps = [last_activity] if last_activity is not None else []

    window_minutes = _timeline_window_minutes(session, default_minutes=60)
    spark = generate_sparkline(timestamps, minutes=window_minutes, width=30)
    return f"  Activity: {spark}  ({window_minutes} min)"


def render_status_transitions_line(session: object, jsonl_path: str | Path | None = None) -> str:
    """Render condensed status transitions for long-running sessions."""
    if not jsonl_path:
        return ""

    transitions = get_status_transitions(jsonl_path)
    if len(transitions) < 2:
        return ""

    duration = transitions[-1][0] - transitions[0][0]
    if duration < 3600:
        return ""

    labels = [status for _, status in transitions[-3:]]
    if not labels:
        return ""

    sequence = labels[0]
    for idx, label in enumerate(labels[1:], start=1):
        arrow = " ─────────────────▶ " if idx == 1 else " ─▶ "
        sequence = f"{sequence}{arrow}{label}"

    return f"  {_format_duration(duration)}  {sequence}"


def _patch_app() -> None:
    try:
        app_module = importlib.import_module("agents_view.app")
        AgentsViewApp = getattr(app_module, "AgentsViewApp", None)
        if AgentsViewApp is None:
            return
    except Exception:
        return

    if getattr(AgentsViewApp, "_session_timeline_feature_patched", False):
        return

    AgentsViewApp._generate_sparkline = staticmethod(generate_sparkline)  # type: ignore[attr-defined]
    AgentsViewApp._render_timeline_line = staticmethod(render_timeline_line)  # type: ignore[attr-defined]
    AgentsViewApp._render_status_transitions_line = staticmethod(  # type: ignore[attr-defined]
        render_status_transitions_line
    )
    AgentsViewApp._get_session_timestamps = staticmethod(get_session_timestamps)  # type: ignore[attr-defined]
    AgentsViewApp._session_timeline_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

"""activity_heatmap.py - 24-hour activity heatmap for agent sessions."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Static

_DENSITY_CHARS = ["░", "▒", "▓", "█"]
_TIMELINE_EMPTY = "."
_MAX_TAIL_BYTES = 50 * 1024


@dataclass(frozen=True)
class ActivitySnapshot:
    buckets: dict[tuple[int, int], int]
    timeline_chars: str
    total_sessions_today: int
    total_tokens_today: int
    total_cost_today: float
    most_active_hour: int
    longest_running_hours: float
    stats_text: str


def _clamp_int(value: int, *, minimum: int, maximum: int, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _safe_float(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float, str)):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default
    return default


def _safe_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default
    return default


def _session_id_from_path(path: Path) -> str:
    stem = path.stem
    if "_" in stem:
        return stem.rsplit("_", 1)[-1]
    return stem


def _tail_jsonl_lines(path: Path, tail_bytes: int = _MAX_TAIL_BYTES) -> list[str]:
    size = path.stat().st_size
    start = max(0, size - max(1, int(tail_bytes)))

    with path.open("rb") as handle:
        handle.seek(start)
        payload = handle.read().decode("utf-8", errors="replace")

    lines = payload.splitlines()
    if start > 0 and lines:
        # The first line may be a partial JSON record because we started mid-file.
        lines = lines[1:]
    return lines


def _parse_timestamp(value: object) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value))
        except Exception:
            return None

    text = str(value).strip()
    if not text:
        return None

    normalized = text[:-1] if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed


def _record_timestamp(record: dict[str, Any]) -> datetime | None:
    for key in ("timestamp", "ts", "created_at", "time"):
        parsed = _parse_timestamp(record.get(key))
        if parsed is not None:
            return parsed

    message = record.get("message")
    if isinstance(message, dict):
        for key in ("timestamp", "ts", "created_at"):
            parsed = _parse_timestamp(message.get(key))
            if parsed is not None:
                return parsed

    return None


def _count_tool_calls(record: dict[str, Any]) -> int:
    count = 0

    if str(record.get("type") or "").strip().lower() == "tool_call":
        count += 1

    tool_calls = record.get("tool_calls")
    if isinstance(tool_calls, list):
        count += sum(1 for item in tool_calls if isinstance(item, dict))

    message = record.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            count += sum(
                1
                for block in content
                if isinstance(block, dict)
                and str(block.get("type") or "").strip().lower() == "tool_use"
            )

    return count


def _extract_usage(record: dict[str, Any]) -> tuple[int, float]:
    usage_candidates: list[dict[str, Any]] = []

    usage = record.get("usage")
    if isinstance(usage, dict):
        usage_candidates.append(usage)

    message = record.get("message")
    if isinstance(message, dict):
        message_usage = message.get("usage")
        if isinstance(message_usage, dict):
            usage_candidates.append(message_usage)

    tokens_total = 0
    for candidate in usage_candidates:
        tokens_total += _safe_int(
            candidate.get("input_tokens")
            or candidate.get("prompt_tokens")
            or candidate.get("tokens_in")
            or candidate.get("total_input_tokens")
            or 0
        )
        tokens_total += _safe_int(
            candidate.get("output_tokens")
            or candidate.get("completion_tokens")
            or candidate.get("tokens_out")
            or candidate.get("total_output_tokens")
            or 0
        )

    cost = 0.0
    for source in (record, message if isinstance(message, dict) else None):
        if not isinstance(source, dict):
            continue
        cost += max(
            0.0,
            _safe_float(
                source.get("cost_usd")
                or source.get("cost")
                or source.get("costUsd")
                or 0.0
            ),
        )

    if cost <= 0:
        for candidate in usage_candidates:
            cost += max(
                0.0,
                _safe_float(
                    candidate.get("cost_usd")
                    or candidate.get("cost")
                    or candidate.get("costUsd")
                    or 0.0
                ),
            )

    return max(0, tokens_total), max(0.0, cost)


def _density_char(count: int, max_count: int, *, empty_char: str) -> str:
    if count <= 0 or max_count <= 0:
        return empty_char
    ratio = count / max_count
    if ratio <= 0.25:
        return _DENSITY_CHARS[0]
    if ratio <= 0.5:
        return _DENSITY_CHARS[1]
    if ratio <= 0.75:
        return _DENSITY_CHARS[2]
    return _DENSITY_CHARS[3]


def _iter_session_files(session_dirs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for session_dir in session_dirs:
        try:
            if not session_dir.is_dir():
                continue
            files.extend(path for path in session_dir.rglob("*.jsonl") if path.is_file())
        except Exception:
            continue
    return files


def _collect_activity(
    session_dirs: list[Path],
    *,
    days: int,
    hours: int,
) -> tuple[dict[tuple[int, int], int], list[int], set[str], int, float, float]:
    now = datetime.now()
    cutoff = now - timedelta(days=days)

    buckets: dict[tuple[int, int], int] = defaultdict(int)
    today_hourly = [0] * hours
    sessions_today: set[str] = set()
    tokens_today = 0
    cost_today = 0.0
    ranges: dict[str, tuple[datetime, datetime]] = {}

    for jsonl_file in _iter_session_files(session_dirs):
        fallback_session_id = _session_id_from_path(jsonl_file)
        try:
            lines = _tail_jsonl_lines(jsonl_file)
        except Exception:
            continue

        for line in lines:
            payload = line.strip()
            if not payload:
                continue

            try:
                record = json.loads(payload)
            except Exception:
                continue
            if not isinstance(record, dict):
                continue

            ts = _record_timestamp(record)
            if ts is None or ts < cutoff:
                continue

            day_offset = (now.date() - ts.date()).days
            if not 0 <= day_offset < days:
                continue
            if not 0 <= ts.hour < hours:
                continue

            units = 1 + _count_tool_calls(record)
            buckets[(day_offset, ts.hour)] += units

            if day_offset != 0:
                continue

            today_hourly[ts.hour] += units

            record_session_id = str(record.get("session_id") or "").strip()
            session_id = record_session_id or fallback_session_id
            sessions_today.add(session_id)

            tokens, cost = _extract_usage(record)
            tokens_today += tokens
            cost_today += cost

            current_range = ranges.get(session_id)
            if current_range is None:
                ranges[session_id] = (ts, ts)
            else:
                start_ts, end_ts = current_range
                if ts < start_ts:
                    start_ts = ts
                if ts > end_ts:
                    end_ts = ts
                ranges[session_id] = (start_ts, end_ts)

    longest_running_hours = 0.0
    for start_ts, end_ts in ranges.values():
        duration_h = max(0.0, (end_ts - start_ts).total_seconds() / 3600.0)
        if duration_h > longest_running_hours:
            longest_running_hours = duration_h

    return dict(buckets), today_hourly, sessions_today, tokens_today, cost_today, longest_running_hours


def compute_activity_grid(
    session_dirs: list[Path],
    days: int = 7,
    hours: int = 24,
) -> dict[tuple[int, int], int]:
    """Compute hourly activity buckets from session JSONL files."""
    clamped_days = _clamp_int(days, minimum=1, maximum=30, fallback=7)
    clamped_hours = _clamp_int(hours, minimum=1, maximum=24, fallback=24)
    buckets, _, _, _, _, _ = _collect_activity(
        session_dirs,
        days=clamped_days,
        hours=clamped_hours,
    )
    return buckets


def render_heatmap(buckets: dict[tuple[int, int], int], days: int = 7, hours: int = 24) -> str:
    """Render the 24xN activity heatmap as plain text."""
    clamped_days = _clamp_int(days, minimum=1, maximum=30, fallback=7)
    clamped_hours = _clamp_int(hours, minimum=1, maximum=24, fallback=24)

    if not buckets:
        return "No activity data found."

    max_value = max(buckets.values(), default=0)
    day_offsets = list(range(clamped_days - 1, -1, -1))
    labels = [
        (datetime.now() - timedelta(days=day_offset)).strftime("%a")
        for day_offset in day_offsets
    ]

    lines = ["Hour  " + "  ".join(f"{label:>3}" for label in labels)]
    lines.append("────  " + "  ".join("───" for _ in labels))

    for hour in range(clamped_hours):
        cells = []
        for day_offset in day_offsets:
            count = buckets.get((day_offset, hour), 0)
            cells.append(_density_char(count, max_value, empty_char="░"))
        lines.append(f"{hour:>2}h   " + "    ".join(cells))

    return "\n".join(lines)


def _render_timeline(timeline_chars: str) -> str:
    timeline = timeline_chars or (_TIMELINE_EMPTY * 24)
    return "\n".join(
        [
            f"Today: |{timeline}|",
            "       0h          6h          12h          18h         23h",
        ]
    )


def _render_stats_text(
    *,
    total_sessions_today: int,
    total_tokens_today: int,
    total_cost_today: float,
    most_active_hour: int,
    longest_running_hours: float,
) -> str:
    active_hour = f"{most_active_hour:02}h" if most_active_hour >= 0 else "—"
    return "\n".join(
        [
            f"Total sessions today: {total_sessions_today}",
            f"Total tokens today: {total_tokens_today:,}",
            f"Total cost today: ${total_cost_today:.4f}",
            f"Most active hour: {active_hour}",
            f"Longest running session: {longest_running_hours:.1f} hours",
        ]
    )


def build_activity_snapshot(
    session_dirs: list[Path],
    days: int = 7,
    hours: int = 24,
) -> ActivitySnapshot:
    clamped_days = _clamp_int(days, minimum=1, maximum=30, fallback=7)
    clamped_hours = _clamp_int(hours, minimum=1, maximum=24, fallback=24)

    buckets, today_hourly, sessions_today, tokens_today, cost_today, longest_running_hours = _collect_activity(
        session_dirs,
        days=clamped_days,
        hours=clamped_hours,
    )

    max_today = max(today_hourly, default=0)
    timeline_chars = "".join(
        _density_char(count, max_today, empty_char=_TIMELINE_EMPTY)
        for count in today_hourly
    )

    most_active_hour = -1
    if max_today > 0:
        most_active_hour = max(
            range(clamped_hours),
            key=lambda idx: today_hourly[idx],
        )

    stats_text = _render_stats_text(
        total_sessions_today=len(sessions_today),
        total_tokens_today=tokens_today,
        total_cost_today=cost_today,
        most_active_hour=most_active_hour,
        longest_running_hours=longest_running_hours,
    )

    return ActivitySnapshot(
        buckets=buckets,
        timeline_chars=timeline_chars,
        total_sessions_today=len(sessions_today),
        total_tokens_today=tokens_today,
        total_cost_today=cost_today,
        most_active_hour=most_active_hour,
        longest_running_hours=longest_running_hours,
        stats_text=stats_text,
    )


class ActivityHeatmapScreen(Screen):
    BINDINGS = [Binding("escape,q,h", "dismiss", "Close")]

    CSS = """
    ActivityHeatmapScreen {
        align: center middle;
        background: #22272e99;
    }

    #heatmap-container {
        width: 104;
        height: 44;
        border: double #444c56;
        background: #22272e;
        padding: 1 2;
    }

    #heatmap-title {
        background: #2d333b;
        color: #6cb6ff;
        text-align: center;
        text-style: bold;
        padding: 0 1;
        margin-bottom: 1;
    }

    #heatmap-content {
        color: #adbac7;
    }
    """

    def __init__(self, sessions: list[object] | None = None) -> None:
        super().__init__()
        self._sessions = sessions or []

    def compose(self) -> ComposeResult:
        with Vertical(id="heatmap-container"):
            yield Static("Activity Heatmap (7 days)", id="heatmap-title")
            yield Static("", id="heatmap-content")

    def on_mount(self) -> None:
        self._render_heatmap()

    def _render_heatmap(self) -> None:
        session_dirs = [
            Path.home() / ".omp" / "agent" / "sessions",
            Path.home() / ".claude" / "projects",
        ]

        snapshot = build_activity_snapshot(session_dirs, days=7, hours=24)
        heatmap = render_heatmap(snapshot.buckets, days=7, hours=24)
        timeline = _render_timeline(snapshot.timeline_chars)
        combined = "\n\n".join([heatmap, timeline, snapshot.stats_text])

        self.query_one("#heatmap-content", Static).update(combined)

    def action_dismiss(self) -> None:
        self.dismiss()


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
    except Exception:
        return

    if getattr(AgentsViewApp, "_activity_heatmap_feature_patched", False):
        return

    def _action_activity_heatmap(self: object) -> None:
        sessions = list(getattr(self, "_sessions", []))
        push_screen = getattr(self, "push_screen", None)
        if callable(push_screen):
            push_screen(ActivityHeatmapScreen(sessions))

    AgentsViewApp.action_activity_heatmap = _action_activity_heatmap  # type: ignore[attr-defined,method-assign]

    bindings = list(AgentsViewApp.BINDINGS)
    existing_keys = {str(getattr(binding, "key", "")) for binding in bindings}
    existing_actions = {str(getattr(binding, "action", "")) for binding in bindings}

    if "activity_heatmap" not in existing_actions and "H" not in existing_keys:
        bindings.append(Binding("H", "activity_heatmap", "Activity heatmap"))
        AgentsViewApp.BINDINGS = bindings

        help_entry = ("View", "H", "Activity heatmap")
        if help_entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(help_entry)

    setattr(AgentsViewApp, "_activity_heatmap_feature_patched", True)


_patch_app()


__all__ = [
    "ActivityHeatmapScreen",
    "ActivitySnapshot",
    "build_activity_snapshot",
    "compute_activity_grid",
    "render_heatmap",
]

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.features.activity_heatmap import (
    build_activity_snapshot,
    compute_activity_grid,
    render_heatmap,
)


def _write_jsonl(path: Path, records: list[dict]) -> None:
    payload = "\n".join(json.dumps(record) for record in records) + "\n"
    path.write_text(payload, encoding="utf-8")


def test_compute_activity_grid_counts_messages_and_tool_calls(tmp_path: Path) -> None:
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()

    today = date.today()
    noon = datetime(today.year, today.month, today.day, 12, 0, 0)
    old = noon - timedelta(days=10)

    _write_jsonl(
        session_dir / "agent_session-alpha.jsonl",
        [
            {
                "timestamp": noon.isoformat() + "Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "running"},
                        {"type": "tool_use", "name": "bash", "input": {"command": "echo hi"}},
                    ],
                },
            },
            {"timestamp": old.isoformat() + "Z", "message": {"role": "user", "content": "old"}},
            {"not": "jsonl timestamp"},
        ],
    )

    buckets = compute_activity_grid([session_dir], days=7)

    # One assistant message + one tool use in the same record.
    assert buckets[(0, 12)] == 2


def test_render_heatmap_handles_no_data() -> None:
    rendered = render_heatmap({}, days=7, hours=24)

    assert "No activity data found" in rendered


def test_build_activity_snapshot_computes_timeline_and_today_stats(tmp_path: Path) -> None:
    root = tmp_path / "sessions"
    root.mkdir()

    today = date.today()
    t08 = datetime(today.year, today.month, today.day, 8, 0, 0)
    t10 = datetime(today.year, today.month, today.day, 10, 0, 0)
    t11 = datetime(today.year, today.month, today.day, 11, 0, 0)
    t12 = datetime(today.year, today.month, today.day, 12, 0, 0)

    _write_jsonl(
        root / "agent_session-alpha.jsonl",
        [
            {
                "timestamp": t08.isoformat() + "Z",
                "session_id": "alpha",
                "usage": {"input_tokens": 100, "output_tokens": 30},
                "cost_usd": 0.1,
                "message": {"role": "user", "content": "start"},
            },
            {
                "timestamp": t12.isoformat() + "Z",
                "session_id": "alpha",
                "usage": {"input_tokens": 200, "output_tokens": 50},
                "cost_usd": 0.2,
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "done"},
                        {"type": "tool_use", "name": "grep", "input": {"pattern": "x"}},
                    ],
                },
            },
        ],
    )

    _write_jsonl(
        root / "agent_session-beta.jsonl",
        [
            {
                "timestamp": t10.isoformat() + "Z",
                "session_id": "beta",
                "usage": {"input_tokens": 50, "output_tokens": 20},
                "cost_usd": 0.05,
                "message": {"role": "user", "content": "hello"},
            },
            {
                "timestamp": t11.isoformat() + "Z",
                "session_id": "beta",
                "usage": {"input_tokens": 75, "output_tokens": 25},
                "cost_usd": 0.075,
                "message": {"role": "assistant", "content": "world"},
            },
        ],
    )

    snapshot = build_activity_snapshot([root], days=7)

    assert snapshot.total_sessions_today == 2
    assert snapshot.total_tokens_today == 550
    assert abs(snapshot.total_cost_today - 0.425) < 1e-9
    assert snapshot.most_active_hour == 12
    assert snapshot.longest_running_hours >= 4.0
    assert len(snapshot.timeline_chars) == 24
    assert "Total sessions today: 2" in snapshot.stats_text

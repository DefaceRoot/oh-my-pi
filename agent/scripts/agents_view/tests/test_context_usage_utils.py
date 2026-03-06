"""Tests for shared context usage computation helpers."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.model import AgentSession
from agents_view.utils import (
    context_window_for_model,
    parse_context_usage_from_jsonl_lines,
    parse_session_start_time,
    parse_token_usage_from_jsonl,
 )


def test_context_window_uses_model_override_substring_match() -> None:
    # models.yml overrides claude-sonnet-4-6 to a 1M context window.
    assert context_window_for_model("anthropic/claude-sonnet-4-6-20260205") == 1_000_000


def test_parse_session_start_time_reads_first_timestamp_in_head(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "session.jsonl"
    records = [
        json.dumps({"cwd": "/tmp/project"}),
        json.dumps({"type": "system", "timestamp": "2026-02-26T01:02:03Z"}),
        json.dumps({"type": "message", "ts": 9999999999}),
    ]
    jsonl_path.write_text("\n".join(records) + "\n", encoding="utf-8")

    parsed = parse_session_start_time(str(jsonl_path))
    expected = datetime.fromisoformat("2026-02-26T01:02:03+00:00").timestamp()
    assert parsed == pytest.approx(expected)


def test_parse_session_start_time_handles_missing_files() -> None:
    assert parse_session_start_time("/tmp/does-not-exist/session.jsonl") is None

def test_parse_context_usage_includes_output_tokens_with_fallback_model() -> None:
    lines = [
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 1_000,
                        "output": 500,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        )
    ]

    pct = parse_context_usage_from_jsonl_lines(
        lines, fallback_model="anthropic/claude-sonnet-4-6-20260205"
    )

    assert pct == pytest.approx(0.0015)


def test_parse_context_usage_ignores_aborted_messages() -> None:
    lines = [
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "stopReason": "aborted",
                    "usage": {
                        "input": 99_000,
                        "output": 1_000,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        ),
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 1_000,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        ),
    ]

    pct = parse_context_usage_from_jsonl_lines(
        lines, fallback_model="anthropic/claude-sonnet-4-6-20260205"
    )

    assert pct == pytest.approx(0.001)


def test_parse_context_usage_prefers_main_role_over_subagent() -> None:
    lines = [
        json.dumps(
            {
                "type": "model_change",
                "model": "anthropic/claude-sonnet-4-6-20260205",
                "role": "orchestrator",
            }
        ),
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 500,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        ),
        json.dumps(
            {
                "type": "model_change",
                "model": "openai-codex/gpt-5.3-codex",
                "role": "subagent",
            }
        ),
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 50_000,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        ),
    ]

    pct = parse_context_usage_from_jsonl_lines(lines)

    assert pct == pytest.approx(0.0005)


def test_parse_context_usage_uses_assistant_message_model_without_model_change() -> None:
    lines = [
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "model": "anthropic/claude-sonnet-4-6-20260205",
                    "usage": {
                        "input": 1_000,
                        "output": 500,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        )
    ]

    pct = parse_context_usage_from_jsonl_lines(lines)

    assert pct == pytest.approx(0.0015)


def test_parse_context_usage_handles_handoff_style_sessions_without_model_change() -> None:
    lines = [
        json.dumps(
            {
                "type": "custom_message",
                "customType": "handoff",
                "content": "<handoff-context>...</handoff-context>",
            }
        ),
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "model": "anthropic/claude-sonnet-4-6-20260205",
                    "usage": {
                        "input": 2_000,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }
        ),
    ]

    pct = parse_context_usage_from_jsonl_lines(lines)

    assert pct == pytest.approx(0.002)


def test_agent_session_metric_strings_render_expected_formats() -> None:
    session = AgentSession(
        harness="omp",
        session_id="s1",
        title="Session",
        cwd="/tmp",
        state="active",
    )
    assert session.cost_str == "—"
    assert session.duration_str == "—"
    assert session.tokens_str == "—"

    session.cost_usd = 0.01234
    session.session_duration_s = (2 * 3600) + (34 * 60) + 20
    session.total_tokens_in = 12_300
    session.total_tokens_out = 4_500

    assert session.cost_str == "$0.0123"
    assert session.duration_str == "2h34m"
    assert session.tokens_str == "12.3k in / 4.5k out"

    with patch("agents_view.model.time.time", return_value=1_000_000.0):
        session.session_start_ts = 1_000_000.0 - ((2 * 3600) + (5 * 60))
        assert session.elapsed_str == "2h05m"
        session.session_start_ts = 1_000_000.0 - 30
        assert session.elapsed_str == ""
        session.session_start_ts = 1_000_000.0 - (49 * 3600)
        assert session.elapsed_str == "2d01h"


def test_parse_token_usage_from_jsonl_aggregates_usage_and_counts(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "session.jsonl"
    records = [
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "timestamp": "100",
                    "usage": {"input_tokens": 1_200, "output_tokens": 500},
                    "content": [{"type": "tool_use", "name": "ask", "id": "ask_1"}],
                },
            }
        ),
        "{malformed-json",
        json.dumps(
            {
                "type": "event",
                "ts": 90,
                "usage": {"input_tokens": 300, "output_tokens": 50},
                "content": "contains no issue",
            }
        ),
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "status": "error",
                    "content": [{"type": "text", "text": "failed"}],
                },
            }
        ),
    ]
    jsonl_path.write_text("\n".join(records) + "\n", encoding="utf-8")

    parsed = parse_token_usage_from_jsonl(str(jsonl_path))

    assert parsed["total_tokens_in"] == 1_500
    assert parsed["total_tokens_out"] == 550
    assert parsed["tool_call_count"] == 1
    assert parsed["error_count"] == 1
    assert parsed["session_start_ts"] == 90.0
    assert parsed["cost_usd"] == pytest.approx((1_500 / 1_000_000) * 3.0 + (550 / 1_000_000) * 15.0)


def test_parse_token_usage_from_jsonl_returns_empty_dict_for_missing_file() -> None:
    assert parse_token_usage_from_jsonl("/tmp/does-not-exist.jsonl") == {}
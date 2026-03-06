"""Tests for _detect_omp_status — status inference from OMP session JSONL tails.

Covers the OMP-specific toolCall content type (not Anthropic wire-format tool_use)
and the key scenario where a session appears idle/review while subagent tasks are
actually running.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.adapters.active_tmux_adapter import _detect_omp_status


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _lines(*messages: dict) -> list[str]:
    """Encode each dict as a JSONL line."""
    return [json.dumps(m) for m in messages]


def _msg(role: str, content: list | str = "") -> dict:
    """Minimal OMP message event."""
    return {"type": "message", "message": {"role": role, "content": content}}


def _tool_call(name: str, tool_id: str = "toolu_01") -> dict:
    """OMP-format toolCall content block (type='toolCall')."""
    return {"type": "toolCall", "id": tool_id, "name": name, "arguments": {}}


def _tool_use(name: str, tool_id: str = "toolu_01") -> dict:
    """Anthropic wire-format tool call content block (type='tool_use')."""
    return {"type": "tool_use", "id": tool_id, "name": name, "input": {}}


def _tool_result(tool_call_id: str, tool_name: str, text: str = "ok") -> dict:
    """OMP-format toolResult message."""
    return {
        "type": "message",
        "message": {
            "role": "toolResult",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "content": [{"type": "text", "text": text}],
        },
    }


def _tool_event(ct: str) -> dict:
    """customType event (tool-start / tool-call)."""
    return {"customType": ct}


# ---------------------------------------------------------------------------
# Idle / empty file
# ---------------------------------------------------------------------------


def test_empty_lines_returns_idle():
    assert _detect_omp_status([]) == ("idle", None)


def test_blank_lines_returns_idle():
    assert _detect_omp_status(["", "  ", "\n"]) == ("idle", None)


def test_only_model_change_returns_idle():
    lines = _lines({"type": "model_change", "model": "claude-opus-4"})
    assert _detect_omp_status(lines) == ("idle", None)


# ---------------------------------------------------------------------------
# Running states
# ---------------------------------------------------------------------------


def test_tool_call_custom_event_sets_running():
    lines = _lines(_tool_event("tool-call"))
    status, ask_ts = _detect_omp_status(lines)
    assert status == "running"
    assert ask_ts is None


def test_tool_start_custom_event_sets_running():
    lines = _lines(_tool_event("tool-start"))
    status, ask_ts = _detect_omp_status(lines)
    assert status == "running"


def test_tool_result_after_assistant_sets_running():
    lines = _lines(
        _msg("assistant", [_tool_call("bash", "toolu_abc")]),
        _tool_result("toolu_abc", "bash"),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"


# ---------------------------------------------------------------------------
# Task / proxy_task delegation — THE core regression test
#
# When an assistant emits a toolCall for "task" or "proxy_task" and the
# corresponding toolResult hasn't arrived yet (subagents are running),
# the tail ends with that assistant message.  The detector MUST return
# "running", not "review".
# ---------------------------------------------------------------------------


def test_task_toolcall_omp_format_returns_running():
    """OMP toolCall format: assistant delegates to task subagent → running."""
    lines = _lines(
        _msg("user", [{"type": "text", "text": "do some work"}]),
        _msg("assistant", [
            {"type": "text", "text": "Spawning subagents now."},
            _tool_call("task", "toolu_task_1"),
            _tool_call("task", "toolu_task_2"),
        ]),
        # No toolResult yet — subagents are still running
    )
    status, ask_ts = _detect_omp_status(lines)
    assert status == "running", (
        f"Expected 'running' while task subagents are pending, got {status!r}"
    )
    assert ask_ts is None


def test_proxy_task_toolcall_returns_running():
    """proxy_task tool (alternate name) also signals running."""
    lines = _lines(
        _msg("assistant", [_tool_call("proxy_task", "toolu_pt_1")]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"


def test_task_tool_use_api_format_returns_running():
    """Anthropic tool_use wire format (not yet common in OMP, but must work)."""
    lines = _lines(
        _msg("assistant", [_tool_use("task", "toolu_task_wire")]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"


def test_any_non_ask_tool_returns_running():
    """Any pending tool call (bash, grep, etc.) makes the session running."""
    for tool_name in ("bash", "read", "grep", "find", "edit", "write"):
        lines = _lines(_msg("assistant", [_tool_call(tool_name)]))
        status, _ = _detect_omp_status(lines)
        assert status == "running", f"{tool_name!r} tool should → running, got {status!r}"


def test_multiple_tools_including_task_returns_running():
    """Multiple tool calls in one assistant turn → running."""
    lines = _lines(
        _msg("assistant", [
            _tool_call("read", "toolu_r1"),
            _tool_call("task", "toolu_t1"),
            _tool_call("bash", "toolu_b1"),
        ]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"


def test_task_toolresult_returns_running():
    """After all task results arrive, session is still running (about to respond)."""
    lines = _lines(
        _msg("assistant", [_tool_call("task", "toolu_t1")]),
        _tool_result("toolu_t1", "task", "<task-summary>done</task-summary>"),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"


# ---------------------------------------------------------------------------
# Review — pure text response, no tools
# ---------------------------------------------------------------------------


def test_pure_text_assistant_returns_review():
    """Assistant message with only text content → review."""
    lines = _lines(
        _msg("user", [{"type": "text", "text": "hello"}]),
        _msg("assistant", [{"type": "text", "text": "Sure, here is my answer."}]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "review"


def test_empty_content_assistant_returns_review():
    """Assistant message with empty content list → review (not idle)."""
    lines = _lines(_msg("assistant", []))
    status, _ = _detect_omp_status(lines)
    assert status == "review"


def test_thinking_only_assistant_returns_review():
    """Thinking block alone (no tool calls) → review."""
    lines = _lines(
        _msg("assistant", [{"type": "thinking", "thinking": "..."}]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "review"


# ---------------------------------------------------------------------------
# Asking — ask tool specifically
# ---------------------------------------------------------------------------


def test_ask_tool_use_format_returns_asking():
    """Anthropic wire-format ask tool → asking."""
    from datetime import datetime, timezone
    # Use a fresh timestamp so the 30-second expiry check does not trigger.
    ts_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    lines = _lines(
        {
            "type": "message",
            "timestamp": ts_str,
            "message": {
                "role": "assistant",
                "content": [_tool_use("ask", "toolu_ask_1")],
            },
        }
    )
    status, ask_ts = _detect_omp_status(lines)
    assert status == "asking"
    assert ask_ts is not None


def test_ask_toolcall_format_returns_asking():
    """OMP toolCall format ask tool → asking."""
    from datetime import datetime, timezone
    ts_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    lines = _lines(
        {
            "type": "message",
            "timestamp": ts_str,
            "message": {
                "role": "assistant",
                "content": [_tool_call("ask", "toolu_ask_2")],
            },
        }
    )
    status, ask_ts = _detect_omp_status(lines)
    assert status == "asking"
    assert ask_ts is not None


def test_ask_older_than_30s_returns_review():
    """ask tool seen >30s ago transitions back to review (expired)."""
    old_ts = time.time() - 35
    ts_str = "2026-01-01T12:00:00Z"
    lines = _lines(
        {
            "type": "message",
            "timestamp": ts_str,
            "message": {
                "role": "assistant",
                "content": [_tool_call("ask", "toolu_ask_old")],
            },
        }
    )
    # Patch _time.time inside the module to simulate old ask timestamp
    import agents_view.adapters.active_tmux_adapter as mod
    original = None
    try:
        import importlib
        # The function uses _time imported at call time — we need a real elapsed ask_ts
        # Use actual current time minus 35s baked into the JSONL timestamp instead.
        # Create a timestamp that is 35 seconds old.
        from datetime import datetime, timezone, timedelta
        old_dt = datetime.now(timezone.utc) - timedelta(seconds=35)
        old_iso = old_dt.isoformat().replace("+00:00", "Z")
        lines2 = _lines(
            {
                "type": "message",
                "timestamp": old_iso,
                "message": {
                    "role": "assistant",
                    "content": [_tool_call("ask", "toolu_ask_old")],
                },
            }
        )
        status, ask_ts = _detect_omp_status(lines2)
        assert status == "review", f"Old ask should expire to review, got {status!r}"
        assert ask_ts is None
    finally:
        pass


# ---------------------------------------------------------------------------
# Sequence ordering: last event wins
# ---------------------------------------------------------------------------


def test_tool_call_then_text_response_returns_review():
    """tool-call event followed by pure-text assistant response → review."""
    lines = _lines(
        _tool_event("tool-call"),
        _tool_result("toolu_abc", "bash", "output"),
        _msg("assistant", [{"type": "text", "text": "Done."}]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "review"


def test_review_then_new_tool_call_returns_running():
    """New round of tool calls after a review → running."""
    lines = _lines(
        _msg("assistant", [{"type": "text", "text": "First reply."}]),
        _msg("user", [{"type": "text", "text": "do more"}]),
        _msg("assistant", [_tool_call("bash", "toolu_new")]),
    )
    status, _ = _detect_omp_status(lines)
    assert status == "running"

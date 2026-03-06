"""Agents View TUI — main Textual application."""

# agents-view-v2
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re as _re
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.command import DiscoveryHit, Hit, Hits

if TYPE_CHECKING:
    from textual.command import Provider as CommandProvider
else:
    try:
        from textual.command import Provider as CommandProvider
    except Exception:  # pragma: no cover - textual import differences by version
        from textual.command import CommandProvider as CommandProvider  # type: ignore[attr-defined,no-redef]
from textual.screen import Screen
from textual.message import Message
from textual.widget import Widget
from textual.widgets import DataTable, Footer, Header, Input, Static, Tree

from agents_view import actions, model
from agents_view.adapters.active_tmux_adapter import ActiveTmuxAdapter
from agents_view.adapters.claude_adapter import ClaudeAdapter
from agents_view.adapters.codex_adapter import CodexAdapter
from agents_view.adapters.omp_adapter import OmpAdapter
from agents_view.adapters.opencode_adapter import OpenCodeAdapter
from agents_view.model import AgentSession
from agents_view.tmux_client import TmuxClient
from agents_view.system_resources import _get_sys_resources

from agents_view.utils import (
    context_window_for_model,
    fetch_pr_details,
    format_tokens_k,
    parse_session_start_time,
)

_THEMES: dict[str, dict[str, str]] = {
    "github-dark": {
        "bg_primary": "#22272e",
        "bg_secondary": "#2d333b",
        "bg_tertiary": "#1c2128",
        "border": "#444c56",
        "text_primary": "#adbac7",
        "text_dim": "#636e7b",
        "text_bright": "#cdd9e5",
        "accent_blue": "#6cb6ff",
        "accent_green": "#3fb950",
        "accent_amber": "#d4a72c",
        "accent_red": "#f85149",
        "accent_orange": "#f0883e",
        "accent_cyan": "#57c4f8",
        "accent_purple": "#d2a8ff",
    },
    "nord": {
        "bg_primary": "#2e3440",
        "bg_secondary": "#3b4252",
        "bg_tertiary": "#242933",
        "border": "#4c566a",
        "text_primary": "#d8dee9",
        "text_dim": "#4c566a",
        "text_bright": "#eceff4",
        "accent_blue": "#88c0d0",
        "accent_green": "#a3be8c",
        "accent_amber": "#ebcb8b",
        "accent_red": "#bf616a",
        "accent_orange": "#d08770",
        "accent_cyan": "#8fbcbb",
        "accent_purple": "#b48ead",
    },
    "catppuccin": {
        "bg_primary": "#1e1e2e",
        "bg_secondary": "#181825",
        "bg_tertiary": "#11111b",
        "border": "#45475a",
        "text_primary": "#cdd6f4",
        "text_dim": "#585b70",
        "text_bright": "#f5e0dc",
        "accent_blue": "#89b4fa",
        "accent_green": "#a6e3a1",
        "accent_amber": "#f9e2af",
        "accent_red": "#f38ba8",
        "accent_orange": "#fab387",
        "accent_cyan": "#89dceb",
        "accent_purple": "#cba6f7",
    },
    "high-contrast": {
        "bg_primary": "#000000",
        "bg_secondary": "#111111",
        "bg_tertiary": "#0a0a0a",
        "border": "#555555",
        "text_primary": "#ffffff",
        "text_dim": "#888888",
        "text_bright": "#ffffff",
        "accent_blue": "#00aaff",
        "accent_green": "#00ff88",
        "accent_amber": "#ffcc00",
        "accent_red": "#ff3333",
        "accent_orange": "#ff8800",
        "accent_cyan": "#00ffff",
        "accent_purple": "#cc88ff",
    },
}
_THEME_ORDER = ["github-dark", "nord", "catppuccin", "high-contrast"]
Pilot: object | None
try:
    from textual.pilot import Pilot as _Pilot

    Pilot = _Pilot
except Exception:  # pragma: no cover - textual import differences by version
    Pilot = None

if Pilot is not None and not hasattr(Pilot, "type"):

    async def _pilot_type(self, text: str) -> None:
        keys = ["space" if ch == " " else ch for ch in text]
        await self.press(*keys)

    setattr(Pilot, "type", _pilot_type)

log = logging.getLogger(__name__)



_ANSI_STRIP_RE = _re.compile(
    r"\x1b(?:"
    r"\[[0-9:;?]*[@-ln-~]"  # CSI controls except SGR (m)
    r"|\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL/ST
    r"|[P^_].*?\x1b\\"  # DCS/PM/APC ... ST
    r"|[=>]"  # DEC private mode shortcuts
    r"|\([0-2B]"  # charset designators
    r")",
    _re.DOTALL,
)
_SGR_RE = _re.compile(r"\x1b\[([0-9:;]*)m")
_C1_SGR_RE = _re.compile(r"\x9b([0-9:;]*)m")
_C1_STRIP_RE = _re.compile(
    r"(?:"
    r"\x9b[0-?]*[ -/]*[@-~]"  # 8-bit CSI
    r"|\x9d[^\x07\x9c]*(?:\x07|\x9c)"  # 8-bit OSC ... BEL/ST
    r"|[\x90\x98\x9e\x9f].*?\x9c"  # 8-bit DCS/SOS/PM/APC ... ST
    r")",
    _re.DOTALL,
)
_SINGLE_ESCAPE_RE = _re.compile(
    r"\x1b(?:"
    r"(?!\[[0-9:;]*m)\[[0-?]*[ -/]*[@-~]"  # non-SGR CSI
    r"|[78c]"  # DECSC / DECRC / RIS
    r"|[@-Z\\-_]"  # 2-byte escape sequences
    r"|$"  # trailing lone ESC
    r")"
)
_CONTROL_CHAR_RE = _re.compile(r"[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]")


def _sanitize_sgr_parameters(params: str) -> str:
    tokens_raw = ["0"] if params == "" else _re.split(r"[;:]", params)
    tokens: list[int] = []
    for token in tokens_raw:
        if not token:
            continue
        try:
            tokens.append(int(token))
        except ValueError:
            continue

    if not tokens:
        return ""

    sanitized: list[str] = []
    i = 0
    while i < len(tokens):
        code = tokens[i]

        if code == 0:
            sanitized = ["0"]
            i += 1
            continue
        if code == 39 or 30 <= code <= 37 or 90 <= code <= 97:
            sanitized.append(str(code))
            i += 1
            continue

        if code == 38:
            if i + 2 < len(tokens) and tokens[i + 1] == 5:
                palette = tokens[i + 2]
                if 0 <= palette <= 255:
                    sanitized.extend(["38", "5", str(palette)])
                i += 3
                continue
            if i + 4 < len(tokens) and tokens[i + 1] == 2:
                r, g, b = tokens[i + 2 : i + 5]
                if all(0 <= ch <= 255 for ch in (r, g, b)):
                    sanitized.extend(["38", "2", str(r), str(g), str(b)])
                i += 5
                continue

        if code == 48:
            if i + 2 < len(tokens) and tokens[i + 1] == 5:
                i += 3
                continue
            if i + 4 < len(tokens) and tokens[i + 1] == 2:
                i += 5
                continue

        i += 1

    if not sanitized:
        return ""

    return f"\x1b[{';'.join(sanitized)}m"


def _sanitize_preview_ansi(text: str) -> str:
    if not text:
        return ""

    cleaned = _C1_SGR_RE.sub(lambda match: f"\x1b[{match.group(1)}m", text)
    cleaned = _ANSI_STRIP_RE.sub("", cleaned)
    cleaned = _C1_STRIP_RE.sub("", cleaned)
    cleaned = _SGR_RE.sub(
        lambda match: _sanitize_sgr_parameters(match.group(1)), cleaned
    )
    cleaned = _SINGLE_ESCAPE_RE.sub("", cleaned)
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL_CHAR_RE.sub("", cleaned)


def _extract_session_file_path(resume_command: str | None) -> str | None:
    if not resume_command:
        return None
    match = _re.search(r"--session '([^']+)'", resume_command)
    if not match:
        return None
    return match.group(1)


def _copy_to_clipboard(text: str) -> bool:
    try:
        import pyperclip  # type: ignore[import-untyped]

        pyperclip.copy(text)
        return True
    except Exception:
        pass

    import subprocess

    payload = text.encode()
    for cmd in (
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
        ["pbcopy"],
    ):
        try:
            proc = subprocess.run(
                cmd,
                input=payload,
                capture_output=True,
                timeout=3,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
        except Exception:
            continue
        if proc.returncode == 0:
            return True
    return False


_JSONL_TAIL_BYTES = 65_536
_PREVIEW_CACHE: dict[
    str, tuple[float, str, "Text"]
] = {}  # path -> (mtime, session_id, rendered)
_PREVIEW_CACHE_MAX = 50
_GIT_CACHE: dict[str, tuple[float, object]] = {}  # key -> (cache_time, result)
_GIT_CACHE_TTL = 30.0  # seconds
_WORKTREE_CACHE_TTL_SECONDS = 30.0
_WORKTREE_CACHE: dict[str, tuple[float, list[dict[str, object]]]] = {}


def _read_jsonl_tail_lines(
    jsonl_path: str, tail_bytes: int = _JSONL_TAIL_BYTES
) -> list[str]:
    with open(jsonl_path, "r", errors="replace") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        if size > tail_bytes:
            fh.seek(size - tail_bytes)
            fh.readline()
        else:
            fh.seek(0)
        return fh.readlines()


def _cached_git(
    cache_key: str, cmd: list[str], cwd: str, timeout: int = 5
) -> Optional[str]:
    """Run git command with TTL caching."""
    import subprocess as _sp
    import time as _t

    now = _t.time()
    if cache_key in _GIT_CACHE:
        ts, result = _GIT_CACHE[cache_key]
        if now - ts < _GIT_CACHE_TTL:
            return result if isinstance(result, str) else None

    try:
        run_result = _sp.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        result: Optional[str] = (
            run_result.stdout.strip() if run_result.returncode == 0 else None
        )
    except Exception:
        result = None

    _GIT_CACHE[cache_key] = (now, result)
    # Evict old entries if cache grows large
    if len(_GIT_CACHE) > 200:
        cutoff = now - _GIT_CACHE_TTL * 2
        keys_to_del = [k for k, (ts, _) in _GIT_CACHE.items() if ts < cutoff]
        for k in keys_to_del:
            del _GIT_CACHE[k]
    return result


def _extract_last_user_messages(jsonl_path: str, n: int = 2) -> list[str]:
    """Return the last n user message texts from a JSONL session file."""
    import json as _json

    results: list[str] = []
    try:
        lines = _read_jsonl_tail_lines(jsonl_path)
        for raw in reversed(lines[-200:]):
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = _json.loads(raw)
            except _json.JSONDecodeError:
                continue
            msg = obj.get("message")
            if isinstance(msg, dict) and msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str) and content.strip():
                    results.append(content.strip()[:80])
                elif isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            txt = str(block.get("text", "")).strip()
                            if txt:
                                results.append(txt[:80])
                                break
            if len(results) >= n:
                break
    except Exception:
        pass
    return list(reversed(results))


def _extract_text_blocks(content) -> list[str]:
    """Return non-empty stripped text from text content blocks."""
    if isinstance(content, str):
        text = content.strip()
        return [text] if text else []

    if not isinstance(content, list):
        return []

    texts: list[str] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = str(block.get("text", "")).strip()
        if text:
            texts.append(text)
    return texts


def _iter_tool_calls(content) -> list[dict]:
    """Return normalized tool-call blocks across supported schemas."""
    if not isinstance(content, list):
        return []

    calls: list[dict] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype not in {"toolCall", "tool_use"}:
            continue
        name = str(block.get("name", "")).strip()
        if not name:
            continue

        args = (
            block.get("arguments", {})
            if btype == "toolCall"
            else block.get("input", {})
        )
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        if not isinstance(args, dict):
            args = {}

        call_id = str(block.get("id", "") or "") if btype == "tool_use" else ""
        calls.append({"name": name, "args": args, "id": call_id})
    return calls


def _is_system_output_text(text: str) -> bool:
    """Return whether text contains known command-output or interruption markers."""
    if not text:
        return False

    lowered = text.lower()
    tags = (
        "<local-command-caveat>",
        "<system-reminder>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<bash-stdout>",
        "<bash-stderr>",
        "<task-notification>",
        "[request interrupted by user",
    )
    return any(tag in lowered for tag in tags)


def _is_meta_record(obj: dict, msg: dict) -> bool:
    """Return whether a record is metadata/tool-result noise."""
    if isinstance(obj, dict) and "customType" in obj:
        return True
    if isinstance(msg, dict) and msg.get("role") == "toolResult":
        return True

    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") in {"tool_result", "toolResult"}:
                    return True
    return False


def _extract_task_call_summary(args: dict) -> tuple[str, str, str]:
    """Extract compact task-call summary fields from tool arguments."""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    if not isinstance(args, dict):
        return "", "", ""

    subagent_type = str(args.get("subagent_type", "") or "")
    description_value = args.get("description", "")
    if description_value:
        description = str(description_value)
    else:
        prompt = str(args.get("prompt", "") or "")
        description = prompt[:80] if prompt else ""
    member = str(args.get("name", "") or args.get("team_name", "") or "")
    return subagent_type, description, member


def _extract_todo_items(args: dict) -> list[tuple[str, str]]:
    """Extract todo status/content tuples from todo_write operations."""
    try:
        if isinstance(args, str):
            args = json.loads(args)
        if not isinstance(args, dict):
            return []

        ops = args.get("ops", [])
        if not isinstance(ops, list):
            return []

        items: list[tuple[str, str]] = []
        for op in ops:
            if not isinstance(op, dict):
                continue
            op_type = op.get("op")
            if op_type == "replace":
                phases = op.get("phases", [])
                if not isinstance(phases, list):
                    continue
                for phase in phases:
                    if not isinstance(phase, dict):
                        continue
                    tasks = phase.get("tasks", [])
                    if not isinstance(tasks, list):
                        continue
                    for task in tasks:
                        if not isinstance(task, dict):
                            continue
                        status = str(task.get("status", "pending") or "pending")
                        content = str(task.get("content", "") or "").strip()
                        if content:
                            items.append((status, content))
            elif op_type == "add_task":
                status = str(op.get("status", "pending") or "pending")
                content = str(op.get("content", "") or "").strip()
                if content:
                    items.append((status, content))
        return items
    except Exception:
        return []


def _extract_latest_assistant_turn(
    lines: list[str], max_lines: int = 200
) -> tuple[str, str, int]:
    """Return latest assistant turn text, last line summary, and omitted-line count."""
    import json as _json

    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = _json.loads(raw)
        except _json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict) or str(msg.get("role") or "") != "assistant":
            continue
        if _is_meta_record(obj, msg):
            continue

        text_blocks: list[str] = []
        for text in _extract_text_blocks(msg.get("content")):
            normalized = " ".join(text.split())
            if normalized and not _is_system_output_text(normalized):
                text_blocks.append(text.rstrip("\n"))

        if not text_blocks:
            continue

        full_text = "\n\n".join(block for block in text_blocks if block.strip())
        if not full_text.strip():
            continue

        rendered_lines = full_text.splitlines()
        omitted = max(0, len(rendered_lines) - max_lines)
        if omitted:
            rendered = f"... ({omitted} lines above)\n" + "\n".join(
                rendered_lines[-max_lines:]
            )
        else:
            rendered = full_text

        last_line = next(
            (line.strip() for line in reversed(rendered_lines) if line.strip()), ""
        )
        return rendered, last_line, omitted

    return "", "", 0


def _extract_latest_assistant_turn_from_file(
    session_file_path: str, max_lines: int = 200
) -> tuple[str, str, int]:
    try:
        lines = _read_jsonl_tail_lines(session_file_path)
    except OSError:
        return "", "", 0
    return _extract_latest_assistant_turn(lines, max_lines=max_lines)


def _normalize_context_usage_pct(pct: float | None) -> float | None:
    if pct is None:
        return None
    try:
        value = float(pct)
    except (TypeError, ValueError):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return max(0.0, min(1.0, value))


def _format_relative_time(delta: float) -> str:
    if delta < 10:
        return "just now"
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta / 60)}m ago"
    if delta < 86400:
        h = int(delta / 3600)
        m = int((delta % 3600) / 60)
        return f"{h}h{m:02d}m ago" if m else f"{h}h ago"
    return f"{int(delta / 86400)}d ago"


def _render_age_cell(session: AgentSession) -> Text:
    if session.last_activity_ts is None:
        return Text("—", style="#636e7b")
    try:
        delta = max(0.0, time.time() - float(session.last_activity_ts))
    except (TypeError, ValueError):
        return Text("—", style="#636e7b")

    if delta < 60:
        label, style = f"{int(delta)}s", "#3fb950"
    elif delta < 300:
        label, style = f"{int(delta / 60)}m", "#57c4f8"
    elif delta < 1800:
        label, style = f"{int(delta / 60)}m", "#adbac7"
    elif delta < 7200:
        label, style = f"{int(delta / 60)}m", "#d4a72c"
    elif delta < 86400:
        label, style = f"{int(delta / 3600)}h", "#f0883e"
    else:
        label, style = f"{int(delta / 86400)}d", "#636e7b"
    prefix = "• " if delta < 10 else ""
    font_style = "bold " if delta < 10 else ""
    return Text(prefix + label, style=f"{font_style}{style}")


def _context_segment_style(segment_ratio: float, pct: float) -> str:
    if pct >= 0.95:
        return "bold blink #f85149"
    if segment_ratio <= 0.50:
        return "#3fb950"
    if segment_ratio <= 0.80:
        return "#d4a72c"
    if segment_ratio <= 0.95:
        return "#f85149" if segment_ratio >= 0.875 else "#d4a72c"
    return "#f85149"


def _render_context_segments(pct: float | None, width: int) -> Text:
    safe_width = max(1, int(width))
    normalized_pct = _normalize_context_usage_pct(pct)
    if normalized_pct is None:
        return Text("░" * safe_width, style="#444c56")

    filled = max(0, min(safe_width, round(normalized_pct * safe_width)))
    result = Text()
    for idx in range(safe_width):
        if idx < filled:
            segment_ratio = (idx + 1) / safe_width
            result.append(
                "█", style=_context_segment_style(segment_ratio, normalized_pct)
            )
        else:
            result.append("░", style="#444c56")
    return result


def _render_context_bar(pct: float | None, width: int = 16) -> Text:
    normalized_pct = _normalize_context_usage_pct(pct)
    bar = _render_context_segments(normalized_pct, width)
    result = Text("[", style="#636e7b")
    result.append(bar)
    result.append("]", style="#636e7b")
    if normalized_pct is None:
        result.append(" --", style="#636e7b")
        return result

    pct_int = round(normalized_pct * 100)
    if normalized_pct >= 0.95:
        pct_style = "bold blink #f85149"
    elif normalized_pct <= 0.50:
        pct_style = "#3fb950"
    elif normalized_pct <= 0.80:
        pct_style = "#d4a72c"
    else:
        pct_style = "#f85149"
    result.append(f" {pct_int}%", style=pct_style)
    return result


def _parse_timeline_timestamp(value: object) -> float | None:
    import datetime as _dt

    if value is None:
        return None

    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 1_000_000_000_000:
            ts /= 1_000.0
        return ts if ts > 0 else None

    if not isinstance(value, str):
        return None

    raw = value.strip()
    if not raw:
        return None

    try:
        ts = float(raw)
    except ValueError:
        ts = 0.0
    if ts > 0:
        if ts > 1_000_000_000_000:
            ts /= 1_000.0
        return ts

    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        return _dt.datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def _timeline_status_from_label(label: str) -> str | None:
    normalized = label.strip().lower()
    if not normalized:
        return None
    if any(token in normalized for token in ("work", "run", "tool", "busy")):
        return "working"
    if any(token in normalized for token in ("think", "reason")):
        return "thinking"
    if any(token in normalized for token in ("wait", "input", "user")):
        return "user"
    if any(token in normalized for token in ("idle", "stall", "pause", "sleep")):
        return "idle"
    return None


def _timeline_status_from_record(obj: dict) -> str | None:
    event_type = str(obj.get("type") or "").strip().lower()
    if event_type == "status_change":
        for key in ("status", "to", "state", "nextStatus"):
            status = _timeline_status_from_label(str(obj.get(key) or ""))
            if status:
                return status

    message = obj.get("message")
    if not isinstance(message, dict):
        return None

    role = str(message.get("role") or "").strip().lower()
    content = message.get("content")
    if role == "user":
        return "user"
    if role != "assistant":
        return None

    tool_calls = _iter_tool_calls(content)
    if tool_calls:
        return "working"

    if _extract_text_blocks(content):
        return "thinking"
    return None


def _read_jsonl_tail_objects(jsonl_path: str, max_lines: int = 500) -> list[dict]:
    from collections import deque
    import json as _json

    try:
        with open(jsonl_path, "r", errors="replace") as handle:
            tail_lines = list(deque(handle, maxlen=max(1, int(max_lines))))
    except OSError:
        return []

    objects: list[dict] = []
    for raw in tail_lines:
        payload = raw.strip()
        if not payload:
            continue
        try:
            parsed = _json.loads(payload)
        except _json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            objects.append(parsed)
    return objects


def _analyze_status_timeline(
    jsonl_path: str,
    *,
    bucket_count: int = 20,
    tail_lines: int = 500,
    fallback_lines: int = 200,
) -> dict[str, object]:
    import statistics as _stats

    safe_bucket_count = max(1, int(bucket_count))
    empty_counts = {"working": 0, "thinking": 0, "user": 0}
    analysis: dict[str, object] = {
        "short_session": True,
        "timeline_buckets": ["idle"] * safe_bucket_count,
        "activity_buckets": [0] * safe_bucket_count,
        "total_seconds": None,
        "fallback_counts": empty_counts.copy(),
    }

    if not jsonl_path or not os.path.isfile(jsonl_path):
        return analysis

    records = _read_jsonl_tail_objects(jsonl_path, max_lines=tail_lines)
    if not records:
        return analysis

    samples: list[tuple[float | None, str]] = []
    message_statuses: list[str] = []
    for record in records:
        status = _timeline_status_from_record(record)
        if not status:
            continue

        timestamp = _parse_timeline_timestamp(
            record.get("timestamp")
            or record.get("ts")
            or record.get("time")
            or record.get("created_at")
            or record.get("createdAt")
        )
        samples.append((timestamp, status))

        message = record.get("message")
        if isinstance(message, dict):
            role = str(message.get("role") or "").strip().lower()
            if role in {"user", "assistant"}:
                message_statuses.append(status)

    recent_statuses = (message_statuses or [status for _, status in samples])[
        -fallback_lines:
    ]
    fallback_counts = {
        "working": sum(1 for status in recent_statuses if status == "working"),
        "thinking": sum(1 for status in recent_statuses if status == "thinking"),
        "user": sum(1 for status in recent_statuses if status == "user"),
    }
    analysis["fallback_counts"] = fallback_counts
    analysis["short_session"] = len(message_statuses) < 3

    fallback_activity = [0] * safe_bucket_count
    if recent_statuses:
        total_recent = len(recent_statuses)
        for idx, _status in enumerate(recent_statuses):
            bucket_idx = min(
                safe_bucket_count - 1, int((idx / total_recent) * safe_bucket_count)
            )
            fallback_activity[bucket_idx] += 1
    analysis["activity_buckets"] = fallback_activity

    timestamped = [(ts, status) for ts, status in samples if ts is not None]
    if len(timestamped) < 2:
        return analysis

    timestamped.sort(key=lambda item: float(item[0]))
    start_ts = float(timestamped[0][0])
    end_ts = float(timestamped[-1][0])
    total_duration = end_ts - start_ts
    if total_duration <= 0:
        return analysis

    gaps = [
        float(timestamped[idx + 1][0]) - float(timestamped[idx][0])
        for idx in range(len(timestamped) - 1)
        if float(timestamped[idx + 1][0]) > float(timestamped[idx][0])
    ]
    median_gap = _stats.median(gaps) if gaps else 60.0
    idle_threshold = max(180.0, median_gap * 6.0)

    intervals: list[tuple[float, float, str]] = []
    for idx, (current_ts, current_status) in enumerate(timestamped[:-1]):
        next_ts = float(timestamped[idx + 1][0])
        current_value = float(current_ts)
        if next_ts <= current_value:
            continue

        gap = next_ts - current_value
        if gap > idle_threshold:
            active_until = min(
                next_ts, current_value + max(60.0, idle_threshold * 0.35)
            )
            if active_until > current_value:
                intervals.append((current_value, active_until, current_status))
            intervals.append((active_until, next_ts, "idle"))
            continue

        intervals.append((current_value, next_ts, current_status))

    if not intervals:
        return analysis

    timeline_buckets: list[str] = []
    activity_buckets = [0] * safe_bucket_count
    for ts, _status in timestamped:
        ratio = (float(ts) - start_ts) / total_duration if total_duration > 0 else 0.0
        ratio = max(0.0, min(0.999999, ratio))
        bucket_idx = min(safe_bucket_count - 1, int(ratio * safe_bucket_count))
        activity_buckets[bucket_idx] += 1

    statuses = ("working", "thinking", "user", "idle")
    for bucket_idx in range(safe_bucket_count):
        bucket_start = start_ts + (total_duration * bucket_idx / safe_bucket_count)
        bucket_end = start_ts + (total_duration * (bucket_idx + 1) / safe_bucket_count)
        coverage = {status: 0.0 for status in statuses}

        for interval_start, interval_end, interval_status in intervals:
            overlap_start = max(bucket_start, interval_start)
            overlap_end = min(bucket_end, interval_end)
            if overlap_end <= overlap_start:
                continue
            coverage[interval_status] = coverage.get(interval_status, 0.0) + (
                overlap_end - overlap_start
            )

        dominant_status = max(coverage, key=coverage.get)
        if coverage[dominant_status] <= 0.0:
            dominant_status = timeline_buckets[-1] if timeline_buckets else "idle"
        timeline_buckets.append(dominant_status)

    analysis["timeline_buckets"] = timeline_buckets
    analysis["activity_buckets"] = activity_buckets
    analysis["total_seconds"] = total_duration
    return analysis


def _render_status_timeline_analysis(
    analysis: dict[str, object], width: int = 40
) -> Text:
    safe_width = max(1, int(width))
    if bool(analysis.get("short_session")):
        return Text("[new session]", style="#636e7b")

    total_seconds = analysis.get("total_seconds")
    buckets = analysis.get("timeline_buckets")
    if (
        isinstance(total_seconds, (int, float))
        and isinstance(buckets, list)
        and buckets
    ):
        base_buckets = [str(bucket) for bucket in buckets]
        scaled = [
            base_buckets[
                min(len(base_buckets) - 1, int((idx / safe_width) * len(base_buckets)))
            ]
            for idx in range(safe_width)
        ]

        glyphs = {
            "working": ("█", "#3fb950"),
            "thinking": ("▓", "#6cb6ff"),
            "user": ("░", "#d4a72c"),
            "idle": ("·", "#636e7b"),
        }

        total_seconds_int = max(0, int(round(float(total_seconds))))
        hours, rem = divmod(total_seconds_int, 3600)
        minutes, seconds = divmod(rem, 60)
        if hours > 0:
            total_label = f"{hours}h{minutes:02d}m"
        elif minutes > 0:
            total_label = f"{minutes}m{seconds:02d}s"
        else:
            total_label = f"{seconds}s"

        rendered = Text("[", style="#636e7b")
        for status in scaled:
            glyph, style = glyphs.get(status, ("·", "#636e7b"))
            rendered.append(glyph, style=style)
        rendered.append("]", style="#636e7b")
        rendered.append(f" {total_label} total", style="#636e7b")
        return rendered

    fallback_counts = analysis.get("fallback_counts")
    if not isinstance(fallback_counts, dict):
        fallback_counts = {"working": 0, "thinking": 0, "user": 0}

    total = sum(
        int(fallback_counts.get(status, 0))
        for status in ("working", "thinking", "user")
    )
    if total <= 0:
        return Text("[new session]", style="#636e7b")

    bar_width = max(10, min(24, safe_width))
    lines = Text("Activity mix:\n", style="#636e7b")
    for label, key, color in (
        ("Working", "working", "#3fb950"),
        ("Thinking", "thinking", "#6cb6ff"),
        ("Waiting", "user", "#d4a72c"),
    ):
        count = int(fallback_counts.get(key, 0) or 0)
        pct = int(round((count / total) * 100)) if total else 0
        filled = int(round((pct / 100) * bar_width)) if pct else 0
        filled = max(0, min(bar_width, filled))
        bar = "█" * filled + "░" * (bar_width - filled)
        lines.append(f"{label:<8} ", style="bold #636e7b")
        lines.append(bar, style=color)
        lines.append(f" {pct}%\n", style="#636e7b")

    return lines


def _extract_status_activity_buckets(
    jsonl_path: str, bucket_count: int = 20
) -> list[float]:
    analysis = _analyze_status_timeline(jsonl_path, bucket_count=bucket_count)
    values = analysis.get("activity_buckets")
    if not isinstance(values, list):
        return []
    buckets: list[float] = []
    for value in values:
        try:
            buckets.append(float(value))
        except (TypeError, ValueError):
            buckets.append(0.0)
    return buckets


def _extract_status_timeline(jsonl_path: str, width: int = 40) -> Text:
    analysis = _analyze_status_timeline(jsonl_path, bucket_count=20)
    return _render_status_timeline_analysis(analysis, width=width)


def _build_sparkline(values: list[float], width: int = 20) -> str:
    safe_width = max(1, int(width))
    if not values:
        return "·" * safe_width

    points = [float(value) for value in values[-safe_width:]]
    if len(points) < safe_width:
        points = [0.0] * (safe_width - len(points)) + points

    levels = "▁▂▃▄▅▆▇█"
    minimum = min(points)
    maximum = max(points)

    if maximum <= 0:
        return levels[0] * safe_width

    if maximum == minimum:
        char = levels[-1] if maximum > 0 else levels[0]
        return char * safe_width

    chars: list[str] = []
    max_index = len(levels) - 1
    for value in points:
        ratio = (value - minimum) / (maximum - minimum)
        idx = int(round(ratio * max_index))
        idx = max(0, min(max_index, idx))
        chars.append(levels[idx])
    return "".join(chars)


def _render_active_preview(
    session_file_path: str,
    *,
    subagent_rows: list[dict[str, object]] | None = None,
    selected_subagent_index: int = -1,
    selected_subagent_label: str = "",
    selected_subagent_output: str = "",
    session_model: str = "",
    session_role: str = "",
    session_branch: str = "",
    session_context_pct: float | None = None,
    session_elapsed: str = "",
    session_last_activity_ts: float | None = None,
    session_diff_stats: tuple[int, int, int] | None = None,
    preview_max_lines: int = 200,
) -> Text:
    """Parse JSONL session file and render a compact timeline preview."""
    import json as _json

    try:
        preview_max_lines = max(1, int(preview_max_lines))
    except (TypeError, ValueError):
        preview_max_lines = 200
    cache_variant = f"max_lines:{preview_max_lines}"

    try:
        current_mtime = os.path.getmtime(session_file_path)
        if session_file_path in _PREVIEW_CACHE:
            cached_mtime, cached_id, cached_text = _PREVIEW_CACHE[session_file_path]
            # Only return cache if mtime matches AND session context hasn't changed
            if cached_mtime == current_mtime and cached_id == cache_variant:
                return cached_text
    except OSError:
        pass

    try:
        lines = _read_jsonl_tail_lines(session_file_path)
    except OSError:
        return Text("[session file unavailable]", style="#636e7b")

    tail = lines[-preview_max_lines:]
    parseable_count = 0
    session_cwd = ""

    user_prompts: list[str] = []
    tool_names: list[str] = []
    task_rows: list[tuple[str, str, str]] = []
    todo_items: list[tuple[str, str]] = []

    for raw in tail:
        raw = raw.strip()
        if not raw:
            continue

        try:
            obj = _json.loads(raw)
        except _json.JSONDecodeError:
            continue

        if not isinstance(obj, dict):
            continue

        parseable_count += 1
        if not session_cwd and isinstance(obj.get("cwd"), str):
            session_cwd = str(obj.get("cwd") or "")

        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue

        role = str(msg.get("role") or "")
        content = msg.get("content")
        tool_calls = _iter_tool_calls(content)

        if _is_meta_record(obj, msg):
            todo_from_meta = False
            for tool_call in tool_calls:
                if str(tool_call.get("name") or "").lower() == "todo_write":
                    todo_items.extend(_extract_todo_items(tool_call.get("args", {})))
                    todo_from_meta = True
            if not todo_from_meta:
                continue
            continue

        if role == "user":
            for text in _extract_text_blocks(content):
                normalized = " ".join(text.split())
                if normalized and not _is_system_output_text(normalized):
                    user_prompts.append(normalized)
            continue

        if role != "assistant":
            continue

        for tool_call in tool_calls:
            tool_name = str(tool_call.get("name") or "").strip()
            if not tool_name:
                continue

            tool_names.append(tool_name)
            tool_name_lower = tool_name.lower()
            if tool_name_lower == "todo_write":
                todo_items.extend(_extract_todo_items(tool_call.get("args", {})))
            elif tool_name_lower == "task":
                task_rows.append(_extract_task_call_summary(tool_call.get("args", {})))

    if not session_cwd:
        try:
            with open(session_file_path, "r", errors="replace") as fh:
                first_raw = fh.readline()
            if first_raw.strip():
                first = _json.loads(first_raw)
                if isinstance(first, dict) and isinstance(first.get("cwd"), str):
                    session_cwd = str(first.get("cwd") or "")
        except Exception:
            pass

    if parseable_count == 0:
        result = Text("[empty session]", style="#636e7b")
        if len(_PREVIEW_CACHE) >= _PREVIEW_CACHE_MAX:
            oldest_key = next(iter(_PREVIEW_CACHE))
            del _PREVIEW_CACHE[oldest_key]
        try:
            _PREVIEW_CACHE[session_file_path] = (
                os.path.getmtime(session_file_path),
                cache_variant,
                result,
            )
        except OSError:
            pass
        return result

    result = Text()
    activity_buckets: list[float] = []

    def section(title: str) -> None:
        result.append(f"\n{title} ", style="bold #636e7b")
        result.append("─" * max(0, 34 - len(title)), style="#2d333b")
        result.append("\n")

    if session_cwd:
        section("Session")
        result.append("CWD:  ", style="bold #636e7b")
        result.append(f"{session_cwd}\n", style="#adbac7")

    if user_prompts:
        section("User")
        for prompt in user_prompts[-2:]:
            text = prompt[:77] + "..." if len(prompt) > 80 else prompt
            result.append("  • ", style="bold #6cb6ff")
            result.append(f"{text}\n", style="#adbac7")

    latest_output, _, omitted = _extract_latest_assistant_turn(
        lines, max_lines=preview_max_lines
    )
    section("Last output")
    showing_selected_subagent = selected_subagent_index >= 0 and bool(subagent_rows)
    if showing_selected_subagent:
        total = len(subagent_rows) if subagent_rows else 0
        label = selected_subagent_label or "subagent"
        result.append(
            f"[Subagent {selected_subagent_index + 1}/{total}: {label}]\n",
            style="bold #f0883e",
        )
        body = selected_subagent_output.strip() or "[no subagent output]"
    else:
        body = latest_output.strip() or "[no assistant output yet]"
    result.append(body, style="#adbac7")
    result.append("\n")
    if omitted > 0 and not showing_selected_subagent:
        result.append(
            f"  ({omitted} lines above, scroll to see more)\n",
            style="italic #636e7b",
        )

    if tool_names:
        section("Tools")
        seen: set[str] = set()
        dedup_recent: list[str] = []
        for name in reversed(tool_names):
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            dedup_recent.append(name)

        joined = ", ".join(dedup_recent)
        if len(joined) <= 120:
            result.append(f"{joined}\n", style="#d4a72c")
        else:
            for name in dedup_recent:
                result.append("  • ", style="#d4a72c")
                result.append(f"{name}\n", style="#adbac7")

    if session_file_path:
        section("Timeline")
        timeline_text = _extract_status_timeline(session_file_path, width=36)
        result.append_text(timeline_text)
        result.append("\n")
        activity_buckets = _extract_status_activity_buckets(
            session_file_path, bucket_count=20
        )
    section("Subagents")
    if subagent_rows is not None:
        if not subagent_rows:
            result.append("No subagents\n", style="#636e7b")
        for idx, row in enumerate(subagent_rows):
            status = str(row.get("status") or "done")
            status_style = {
                "running": "bold #d4a72c",
                "done": "#3fb950",
                "failed": "bold #f85149",
            }.get(status, "#636e7b")
            status_tag = status.upper()
            marker = "▶" if idx == selected_subagent_index else f"{idx + 1}."
            ident = str(row.get("id") or "subagent")
            summary = str(row.get("last_line") or "[no output]")
            if len(summary) > 88:
                summary = summary[:87] + "…"
            result.append(f"  {marker} {ident} ", style="bold #6cb6ff")
            result.append(f"[{status_tag}] ", style=status_style)
            result.append(f"{summary}\n", style="#adbac7")
    elif task_rows:
        for idx, (subagent_type, description, member) in enumerate(
            task_rows[-6:], start=1
        ):
            result.append(f"  {idx}. ", style="bold #6cb6ff")
            result.append(subagent_type or "task", style="bold #6cb6ff")
            if member:
                result.append(f" [{member}]", style="#636e7b")
            if description:
                result.append(" — ", style="#636e7b")
                result.append(description, style="#adbac7")
            result.append("\n")
    else:
        result.append("No subagents\n", style="#636e7b")

    if todo_items:
        section("Tasks")
        status_glyph: dict[str, tuple[str, str]] = {
            "in_progress": ("→ ", "bold #6cb6ff"),
            "completed": ("✓ ", "#3fb950"),
            "abandoned": ("✕ ", "#636e7b"),
            "pending": ("□ ", "#636e7b"),
        }
        for status, content in todo_items[-8:]:
            glyph, glyph_style = status_glyph.get(status, ("□ ", "#636e7b"))
            result.append(f"  {glyph}", style=glyph_style)
            result.append(
                f"{content[:60]}\n",
                style="#adbac7" if status == "in_progress" else "#636e7b",
            )

    section("Session Info")
    model_label = session_model[:30] if session_model else "—"
    mode_label = "—"
    mode_style = "#636e7b"
    if session_role == "orchestrator":
        mode_label = "⬡ ORCH"
        mode_style = "bold #f0883e"
    elif session_role == "default":
        mode_label = "◈ DEF"
        mode_style = "bold #539bf5"

    context_bar = _render_context_bar(session_context_pct, width=16)

    branch_label = f"⎇ {session_branch[:40]}" if session_branch else "—"

    result.append("Model: ", style="bold #636e7b")
    result.append(model_label, style="#6cb6ff")
    result.append("  Mode: ", style="bold #636e7b")
    result.append(mode_label, style=mode_style)
    result.append("  Context: ", style="bold #636e7b")
    result.append(context_bar)
    result.append("  Elapsed: ", style="bold #636e7b")
    result.append(session_elapsed or "—", style="#adbac7")
    result.append("  Last activity: ", style="bold #636e7b")
    last_activity_label = "—"
    last_activity_style = "#636e7b"
    if session_last_activity_ts is not None:
        try:
            delta = max(0.0, time.time() - float(session_last_activity_ts))
        except (TypeError, ValueError):
            delta = -1.0
        if delta >= 0:
            last_activity_label = _format_relative_time(delta)
            last_activity_style = "#adbac7"
    result.append(last_activity_label, style=last_activity_style)
    result.append("  Branch: ", style="bold #636e7b")
    result.append(branch_label, style="#636e7b")
    result.append("\n")
    result.append("Diff: ", style="bold #636e7b")
    if session_diff_stats is None:
        result.append("—", style="#636e7b")
    else:
        added, removed, file_count = session_diff_stats
        file_label = "file" if file_count == 1 else "files"
        result.append(f"+{added}", style="bold #3fb950")
        result.append(" ", style="#636e7b")
        result.append(f"-{removed}", style="bold #f85149")
        result.append(f" ({file_count} {file_label})", style="#636e7b")
    result.append("\n")
    sparkline = _build_sparkline(activity_buckets, width=20)
    result.append("Activity: ", style="bold #636e7b")
    result.append(sparkline + "\n", style="#3fb950")

    result = (
        result if result.plain.strip() else Text("[empty session]", style="#636e7b")
    )
    # Cache the result
    if len(_PREVIEW_CACHE) >= _PREVIEW_CACHE_MAX:
        # Evict oldest entry
        oldest_key = next(iter(_PREVIEW_CACHE))
        del _PREVIEW_CACHE[oldest_key]
    try:
        _PREVIEW_CACHE[session_file_path] = (
            os.path.getmtime(session_file_path),
            cache_variant,
            result,
        )
    except OSError:
        pass
    return result


def _parse_diff_colored(raw: str) -> Text:
    """Parse git diff output into Rich Text with per-line coloring."""
    result = Text()
    for line in raw.splitlines(keepends=True):
        if line.startswith("@@"):
            result.append(line, style="bold #6cb6ff")
        elif line.startswith("diff --git") or line.startswith("index "):
            result.append(line, style="#636e7b")
        elif line.startswith("--- ") or line.startswith("+++ "):
            result.append(line, style="#636e7b")
        elif line.startswith("+"):
            result.append(line, style="bold #3fb950")
        elif line.startswith("-"):
            result.append(line, style="bold #f85149")
        else:
            result.append(line, style="#adbac7")
    return result


def _render_pr_panel_enhanced(pr_data: dict) -> Text:
    """Render rich pull request status details for the Info panel."""
    t = Text()
    if not isinstance(pr_data, dict) or not pr_data:
        t.append("No PR found for this branch\n", style="#636e7b")
        return t

    def section(title: str) -> None:
        t.append(f"\n{title} ", style="bold #636e7b")
        t.append("─" * max(0, 30 - len(title)), style="#2d333b")
        t.append("\n")

    def _as_int(value: object) -> int:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return 0
        return 0

    title = str(pr_data.get("title") or "Unknown PR")[:50]
    number = pr_data.get("number", "?")
    state = str(pr_data.get("state") or "unknown").upper()
    state_style = (
        "#3fb950" if state == "OPEN" else "#636e7b" if state == "MERGED" else "#f85149"
    )
    t.append(f"#{number} ", style="bold #6cb6ff")
    t.append(f"{title}\n", style="#adbac7")
    t.append(f"State: {state}  ", style=state_style)

    adds = _as_int(pr_data.get("additions", 0))
    dels = _as_int(pr_data.get("deletions", 0))
    files = _as_int(pr_data.get("changedFiles", 0))
    t.append(f"+{adds} ", style="#3fb950")
    t.append(f"-{dels} ", style="#f85149")
    t.append(f"({files} files)\n", style="#636e7b")

    checks = pr_data.get("statusCheckRollup")
    if isinstance(checks, list) and checks:
        section("CI Checks")
        check_summary = {"SUCCESS": 0, "FAILURE": 0, "PENDING": 0, "OTHER": 0}
        shown = 0
        for check in checks:
            if shown >= 8:
                break
            if not isinstance(check, dict):
                continue
            status = str(check.get("status") or check.get("state") or "UNKNOWN").upper()
            conclusion = str(check.get("conclusion") or "").upper()
            name_raw = (
                check.get("name")
                or check.get("context")
                or check.get("workflowName")
                or check.get("title")
                or "check"
            )
            name = str(name_raw)[:25]
            shown += 1
            if conclusion == "SUCCESS" or status == "SUCCESS":
                t.append(f"  ✓ {name}\n", style="#3fb950")
                check_summary["SUCCESS"] += 1
            elif conclusion in ("FAILURE", "ERROR") or status in ("FAILURE", "ERROR"):
                t.append(f"  ✗ {name}\n", style="#f85149")
                check_summary["FAILURE"] += 1
            elif (
                status in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING")
                or conclusion == "PENDING"
            ):
                t.append(f"  ⏳ {name}\n", style="#d4a72c")
                check_summary["PENDING"] += 1
            else:
                t.append(f"  · {name}\n", style="#636e7b")
                check_summary["OTHER"] += 1
        total = sum(check_summary.values())
        if total > 0:
            t.append(
                f"  Total: {check_summary['SUCCESS']}/{total} passed\n", style="#636e7b"
            )

    reviews = pr_data.get("reviews")
    if isinstance(reviews, list) and reviews:
        section("Reviews")
        review_summary = {
            "APPROVED": 0,
            "CHANGES_REQUESTED": 0,
            "COMMENTED": 0,
            "PENDING": 0,
            "OTHER": 0,
        }
        for review in reviews:
            if not isinstance(review, dict):
                continue
            review_state = str(review.get("state") or "PENDING").upper()
            if review_state == "APPROVED":
                review_summary["APPROVED"] += 1
            elif review_state == "CHANGES_REQUESTED":
                review_summary["CHANGES_REQUESTED"] += 1
            elif review_state == "COMMENTED":
                review_summary["COMMENTED"] += 1
            elif review_state in ("PENDING", "REVIEW_REQUIRED"):
                review_summary["PENDING"] += 1
            else:
                review_summary["OTHER"] += 1
        t.append(f"  ✓ Approved: {review_summary['APPROVED']}\n", style="#3fb950")
        t.append(
            f"  ✗ Changes requested: {review_summary['CHANGES_REQUESTED']}\n",
            style="#f85149",
        )
        t.append(f"  💬 Comments: {review_summary['COMMENTED']}\n", style="#6cb6ff")
        pending_or_other = review_summary["PENDING"] + review_summary["OTHER"]
        if pending_or_other > 0:
            t.append(f"  ⏳ Pending/other: {pending_or_other}\n", style="#d4a72c")

    labels = pr_data.get("labels")
    if isinstance(labels, list) and labels:
        section("Labels")
        for label in labels[:5]:
            name = label.get("name", "") if isinstance(label, dict) else str(label)
            if name:
                t.append(f"  [{name}]  ", style="#d2a8ff")
        t.append("\n")

    mergeable = str(pr_data.get("mergeable") or "UNKNOWN").upper()
    merge_style = (
        "#3fb950"
        if mergeable == "MERGEABLE"
        else "#f85149"
        if mergeable == "CONFLICTING"
        else "#636e7b"
    )
    section("Merge Status")
    t.append(f"  {mergeable}\n", style=merge_style)

    return t


def _parse_diff_stats(raw: str) -> tuple[int, int, list[tuple[str, int, int]]]:
    """Parse diff into (total_added, total_removed, [(filename, added, removed)])."""
    if not raw or not raw.strip():
        return 0, 0, []

    total_added = 0
    total_removed = 0
    per_file: dict[str, list[int]] = {}
    binary_files: set[str] = set()
    current_file: str | None = None
    in_hunk = False

    for line in raw.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            current_file = None
            match = _re.match(r"^diff --git a/(.+?) b/(.+)$", line)
            if match:
                current_file = match.group(2)
                per_file.setdefault(current_file, [0, 0])
            continue

        if line.startswith("Binary files "):
            in_hunk = False
            if current_file is not None:
                binary_files.add(current_file)
                per_file.pop(current_file, None)
            current_file = None
            continue

        if line.startswith("@@"):
            in_hunk = True
            continue

        if not in_hunk or current_file is None or current_file in binary_files:
            continue

        if line.startswith("+") and not line.startswith("+++"):
            per_file.setdefault(current_file, [0, 0])[0] += 1
            total_added += 1
        elif line.startswith("-") and not line.startswith("---"):
            per_file.setdefault(current_file, [0, 0])[1] += 1
            total_removed += 1

    breakdown = [
        (filename, stats[0], stats[1])
        for filename, stats in per_file.items()
        if filename not in binary_files and (stats[0] or stats[1])
    ]
    breakdown.sort(key=lambda item: (-(item[1] + item[2]), item[0]))
    return total_added, total_removed, breakdown


def _diff_hunk_line_positions(raw: str) -> list[int]:
    """Return 0-based line numbers for @@ hunk headers in raw git diff text."""
    return [idx for idx, line in enumerate(raw.splitlines()) if line.startswith("@@")]


def _render_diff_header(raw: str) -> Text:
    """Render a compact diff header with totals and per-file mini-bars."""
    if not raw or not raw.strip():
        return Text()

    total_added, total_removed, per_file = _parse_diff_stats(raw)
    if not per_file:
        return Text()

    shown_files = per_file[:8]
    file_label = "file" if len(per_file) == 1 else "files"
    result = Text()
    result.append("Changes  ", style="bold #6cb6ff")
    result.append(f"+{total_added}", style="bold #3fb950")
    result.append(" ", style="#636e7b")
    result.append(f"-{total_removed}", style="bold #f85149")
    result.append(f"  ({len(per_file)} {file_label})", style="#636e7b")

    for filename, added, removed in shown_files:
        result.append("\n")
        display_name = filename if len(filename) <= 24 else filename[:23] + "…"
        result.append(display_name.ljust(24), style="#adbac7")
        result.append("  ", style="#636e7b")
        result.append(f"+{added}", style="bold #3fb950")
        result.append(" ", style="#636e7b")
        result.append(f"-{removed}", style="bold #f85149")

        counts_plain = f"+{added} -{removed}"
        result.append(" " * max(3, 11 - len(counts_plain)), style="#636e7b")

        magnitude = added + removed
        if magnitude <= 0:
            add_blocks = 0
            remove_blocks = 0
        elif removed == 0:
            add_blocks = 20
            remove_blocks = 0
        elif added == 0:
            add_blocks = 0
            remove_blocks = 20
        else:
            add_blocks = round((added / magnitude) * 20)
            add_blocks = max(1, min(19, add_blocks))
            remove_blocks = 20 - add_blocks

        result.append("█" * add_blocks, style="bold #3fb950")
        result.append("░" * remove_blocks, style="bold #f85149")

    return result


# Column key constants
_COL_STATUS = "status"
_COL_HARNESS = "harness"
_COL_ROLE = "role"
_COL_SESSION = "session"
_COL_BRANCH = "branch"
_COL_AGE = "age"
_COL_ELAPSED = "elapsed"
_COL_CTX = "ctx"
_COL_REPO = "repo"
_COLUMN_DEFAULTS: dict[str, bool] = {
    _COL_STATUS: True,
    _COL_HARNESS: True,
    _COL_ROLE: True,
    _COL_SESSION: True,
    _COL_BRANCH: True,
    _COL_AGE: True,
    _COL_CTX: True,
    _COL_REPO: False,
    _COL_ELAPSED: True,
}
_COLUMN_CONFIG_FILE = Path("~/.omp/agent/column_config.json").expanduser()
_SORT_PREFS_FILE = Path("~/.omp/agent/sort_prefs.json").expanduser()
_SESSION_TABLE_COLUMNS: list[tuple[str, str, int]] = [
    (_COL_STATUS, "STATUS", 8),
    (_COL_HARNESS, "HARNESS", 8),
    (_COL_ROLE, "ROLE", 7),
    (_COL_SESSION, "SESSION", 28),
    (_COL_BRANCH, "BRANCH", 36),
    (_COL_AGE, "AGE", 5),
    (_COL_ELAPSED, "ELAPSED", 7),
    (_COL_CTX, "CTX", 8),
    (_COL_REPO, "REPO", 16),
]
_LOCKED_COLUMNS = {_COL_STATUS, _COL_SESSION}
_SEP_KEY = "__sep__"  # separator row key prefix
_PIVOT_STATUS_GROUPS: list[tuple[str, str]] = [
    ("running", "Running / Delegating"),
    ("asking", "Asking"),
    ("waiting", "Waiting / Review"),
    ("stalled", "Stalled"),
    ("idle", "Idle / Unknown"),
    ("inactive", "Inactive"),
]


_SORT_PRIORITY: dict[str, int] = {
    "asking": 0,
    "running": 1,
    "delegating": 1,
    "wait": 2,
    "waiting": 2,
    "review": 2,
    "stalled": 3,
    "idle": 4,
    "unknown": 5,
    "offline": 6,
}


def _sorted_sessions(
    sessions: list[AgentSession], sort_key: str, reverse: bool
) -> list[AgentSession]:
    def key_fn(session: AgentSession) -> tuple[object, object]:
        secondary: object = -(session.last_activity_ts or 0)  # most recent first
        if sort_key == "status":
            primary: object = _SORT_PRIORITY.get(session.status, 5)
        elif sort_key == "age":
            primary = -(session.last_activity_ts or 0)
        elif sort_key == "role":
            primary = (
                0
                if session.role == "orchestrator"
                else (1 if session.role == "default" else 2)
            )
        elif sort_key == "session":
            primary = (session.display_title or "").lower()
            secondary = 0
        elif sort_key == "ctx":
            primary = -(session.context_usage_pct or 0)
        elif sort_key == "branch":
            primary = (session.branch or "").lower()
            secondary = 0
        else:
            primary = 0
        return (primary, secondary)

    return sorted(sessions, key=key_fn, reverse=reverse)


def _is_separator_key(key: str) -> bool:
    return key == _SEP_KEY or key.startswith(f"{_SEP_KEY}:")


def _load_column_config() -> dict[str, bool]:
    try:
        import json as _j

        raw = _j.loads(_COLUMN_CONFIG_FILE.read_text(encoding="utf-8"))
        config = dict(_COLUMN_DEFAULTS)
        if isinstance(raw, dict):
            for k, v in raw.items():
                if k in config and isinstance(v, bool):
                    config[k] = v
        config[_COL_STATUS] = True
        config[_COL_SESSION] = True
        return config
    except Exception:
        config = dict(_COLUMN_DEFAULTS)
        config[_COL_STATUS] = True
        config[_COL_SESSION] = True
        return config


def _save_column_config(config: dict[str, bool]) -> None:
    try:
        import json as _j

        _COLUMN_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _COLUMN_CONFIG_FILE.with_suffix(".tmp")
        tmp.write_text(_j.dumps(config, indent=2), encoding="utf-8")
        tmp.replace(_COLUMN_CONFIG_FILE)
    except Exception:
        pass


_SETTINGS_FILE = Path("~/.omp/settings.json").expanduser()
_DEFAULT_AGENTS_VIEW_SETTINGS: dict[str, int] = {
    "refresh_interval_seconds": 2,
    "stall_threshold_seconds": model.STALL_THRESHOLD_SECONDS,
    "auto_kill_stalled_minutes": 0,
    "stale_worktree_days": 7,
    "max_inactive": 10,
    "preview_tail_bytes": 65_536,
    "preview_max_lines": 200,
}
_ALLOWED_AGENTS_VIEW_SETTINGS: dict[str, tuple[int, ...]] = {
    "refresh_interval_seconds": (1, 2, 3, 5, 10),
    "stall_threshold_seconds": (30, 60, 120, 300),
    "auto_kill_stalled_minutes": (0, 5, 10, 30, 60),
    "stale_worktree_days": (3, 7, 14, 30),
    "max_inactive": (5, 10, 20, 50),
    "preview_tail_bytes": (32_768, 65_536, 163_840),
    "preview_max_lines": (100, 200, 300, 500),
}
_PREVIEW_TAIL_LINES_TO_BYTES = {100: 32_768, 200: 65_536, 500: 163_840}
_PREVIEW_TAIL_BYTES_TO_LINES = {
    value: lines for lines, value in _PREVIEW_TAIL_LINES_TO_BYTES.items()
}


def _safe_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except Exception:
        return None


def _sanitize_agents_view_settings(raw: object) -> dict[str, int]:
    source = raw if isinstance(raw, dict) else {}
    sanitized = dict(_DEFAULT_AGENTS_VIEW_SETTINGS)
    for key, default in _DEFAULT_AGENTS_VIEW_SETTINGS.items():
        allowed = _ALLOWED_AGENTS_VIEW_SETTINGS[key]
        candidate = _safe_int(source.get(key))
        if key == "preview_tail_bytes" and candidate is None:
            lines_candidate = _safe_int(source.get("preview_tail_lines"))
            if lines_candidate is not None:
                candidate = _PREVIEW_TAIL_LINES_TO_BYTES.get(lines_candidate)
        sanitized[key] = candidate if candidate in allowed else default
    return sanitized


def _load_settings_payload() -> dict[str, object]:
    try:
        payload = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _save_settings_payload(payload: dict[str, object]) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_path = _SETTINGS_FILE.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temp_path.replace(_SETTINGS_FILE)


def _load_agents_view_settings() -> dict[str, int]:
    payload = _load_settings_payload()
    return _sanitize_agents_view_settings(payload.get("agents_view"))


def _save_agents_view_settings(settings: dict[str, int]) -> dict[str, int]:
    payload = _load_settings_payload()
    sanitized = _sanitize_agents_view_settings(settings)
    payload["agents_view"] = sanitized
    _save_settings_payload(payload)
    return sanitized


def _apply_agents_view_runtime_settings(settings: dict[str, int]) -> None:
    global _JSONL_TAIL_BYTES, _MAX_VISIBLE_INACTIVE, _AUTO_KILL_STALLED_AFTER_MINUTES

    sanitized = _sanitize_agents_view_settings(settings)
    _JSONL_TAIL_BYTES = sanitized["preview_tail_bytes"]
    _MAX_VISIBLE_INACTIVE = sanitized["max_inactive"]
    _AUTO_KILL_STALLED_AFTER_MINUTES = sanitized["auto_kill_stalled_minutes"]
    model.STALL_THRESHOLD_SECONDS = sanitized["stall_threshold_seconds"]
    _PREVIEW_CACHE.clear()


_MAX_VISIBLE_INACTIVE = _DEFAULT_AGENTS_VIEW_SETTINGS["max_inactive"]
_MAX_INACTIVE_AGE_SECONDS = 12 * 60 * 60  # sessions visible on main page for 12h
_ARCHIVE_FILE = Path(
    os.environ.get("OMP_AGENTS_VIEW_ARCHIVE_FILE", "~/.omp/agent/session_archive.json")
).expanduser()
_DEFAULT_QUICK_NOTES_FILE = os.path.expanduser("~/.omp/agent/agents_view_notes.json")
_MAX_QUICK_NOTE_LEN = 24
_TAGS_FILE = Path("~/.omp/agent/session_tags.json").expanduser()
_DESCRIPTIONS_FILE = Path("~/.omp/agent/session_descriptions.json").expanduser()
_MAX_SESSION_TAG_LEN = 20
_MAX_SESSION_TAGS = 5
_TAG_SUGGESTIONS = ["important", "blocking", "wip", "needs-review", "done", "paused"]
_RECOVERY_LOG = Path("~/.omp/agent/recovery_log.jsonl").expanduser()
_AUTO_KILL_STALLED_AFTER_MINUTES = _DEFAULT_AGENTS_VIEW_SETTINGS[
    "auto_kill_stalled_minutes"
]
_INPUT_HISTORY_FILE = Path("~/.omp/agent/input_history.json").expanduser()
_COMMAND_HISTORY_FILE = Path("~/.omp/agent/command_history.json").expanduser()
_BOOKMARKS_FILE = Path("~/.omp/agent/session_bookmarks.json").expanduser()
_INPUT_HISTORY_CAP = 50  # entries per session
_TEMPLATES_DIR = Path("~/.omp/templates").expanduser()
_BROADCAST_GROUPS_FILE = Path("~/.omp/agent/broadcast_groups.json").expanduser()
_BROADCAST_TEMPLATES: list[str] = [
    "continue",
    "/compact",
    "stop and summarize what you have done so far",
    "what is your current status?",
    "please commit your changes",
    "run the tests and fix any failures",
    "check for any issues and fix them",
]
_BROADCAST_HISTORY_FILE = Path("~/.omp/agent/broadcast_history.jsonl").expanduser()
_FILTER_PRESETS_FILE = Path("~/.omp/agent/filter_presets.json").expanduser()
_THEME_PREFS_FILE = Path("~/.omp/agent/theme_pref.json").expanduser()
_BROADCAST_HISTORY_CAP = 10
_BROADCAST_CONFIRM_THRESHOLD = 3
_BROADCAST_CONFIRM_SECONDS = 5
_SLASH_COMMANDS: list[str] = [
    "/plan",
    "/implement",
    "/review",
    "/help",
    "/model",
    "/memory",
    "/compact",
    "/resume",
    "/commit",
    "/test",
    "/debug",
    "/refactor",
    "/docs",
    "/explain",
    "/fix",
    "/optimize",
]


def _dedupe_recent_entries(entries: list[str], cap: int) -> list[str]:
    """Keep most-recent unique entries while preserving chronology."""
    recent_unique: list[str] = []
    seen: set[str] = set()
    for entry in reversed(entries):
        if entry in seen:
            continue
        seen.add(entry)
        recent_unique.append(entry)
        if len(recent_unique) >= cap:
            break
    recent_unique.reverse()
    return recent_unique


_REPO_COLORS: list[str] = [
    "#79c0ff",  # sky blue
    "#ffa657",  # amber
    "#7ee787",  # green
    "#d2a8ff",  # lavender
    "#ff7b72",  # coral
    "#56d364",  # bright green
    "#f0883e",  # orange
    "#58a6ff",  # blue
]


def _load_broadcast_groups() -> dict:
    """Load broadcast groups from JSON file."""
    import json as _json

    try:
        data = _json.loads(_BROADCAST_GROUPS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"groups": {}}
    except Exception:
        return {"groups": {}}

    if not isinstance(data, dict):
        return {"groups": {}}
    groups = data.get("groups")
    if not isinstance(groups, dict):
        data["groups"] = {}
    return data


def _save_broadcast_groups(data: dict) -> None:
    """Save broadcast groups atomically."""
    import json as _json

    try:
        _BROADCAST_GROUPS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _BROADCAST_GROUPS_FILE.with_suffix(".tmp")
        tmp.write_text(_json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(_BROADCAST_GROUPS_FILE)
    except Exception as exc:
        log.debug("broadcast save failed: %s", exc)


def _load_bookmarks() -> set[str]:
    """Load bookmarked session IDs from JSON."""
    import json as _json

    try:
        raw = _json.loads(_BOOKMARKS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()
    except Exception:
        return set()

    bookmarks_raw = raw.get("bookmarks", []) if isinstance(raw, dict) else raw
    if not isinstance(bookmarks_raw, list):
        return set()

    bookmarks: set[str] = set()
    for item in bookmarks_raw:
        if isinstance(item, str) and item.strip():
            bookmarks.add(item)
    return bookmarks


def _save_bookmarks(bookmarks: set[str]) -> None:
    """Save bookmarked session IDs atomically."""
    import json as _json

    payload = {"bookmarks": sorted(bookmarks)}
    try:
        _BOOKMARKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _BOOKMARKS_FILE.with_suffix(".tmp")
        tmp.write_text(_json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(_BOOKMARKS_FILE)
    except Exception as exc:
        log.debug("bookmark save failed: %s", exc)


def _reordered_fraction(previous_order: list[str], next_order: list[str]) -> float:
    if not previous_order or not next_order:
        return 0.0

    previous_positions = {key: idx for idx, key in enumerate(previous_order)}
    ranks = [previous_positions[key] for key in next_order if key in previous_positions]
    if len(ranks) < 2:
        return 0.0

    from bisect import bisect_left as _bisect_left

    lis: list[int] = []
    for rank in ranks:
        insert_at = _bisect_left(lis, rank)
        if insert_at == len(lis):
            lis.append(rank)
        else:
            lis[insert_at] = rank

    moved = len(ranks) - len(lis)
    return moved / max(1, len(ranks))


def _normalize_session_tag(raw_tag: str) -> str:
    tag = raw_tag.strip()
    if tag.startswith("#"):
        tag = tag[1:]
    return tag.strip().lower()[:_MAX_SESSION_TAG_LEN]


def _normalize_session_tags(raw_tags: object) -> list[str]:
    if not isinstance(raw_tags, list):
        return []

    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in raw_tags:
        if not isinstance(raw_tag, str):
            continue
        tag = _normalize_session_tag(raw_tag)
        if not tag or tag in seen:
            continue
        normalized.append(tag)
        seen.add(tag)
        if len(normalized) >= _MAX_SESSION_TAGS:
            break
    return normalized


def _load_session_tags() -> dict[str, list[str]]:
    try:
        raw = json.loads(_TAGS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        log.warning("session tags: unable to read %s", _TAGS_FILE)
        return {}

    if not isinstance(raw, dict):
        log.warning("session tags: ignoring non-object payload in %s", _TAGS_FILE)
        return {}

    session_tags: dict[str, list[str]] = {}
    for session_id, tags in raw.items():
        if not isinstance(session_id, str):
            continue
        normalized = _normalize_session_tags(tags)
        if normalized:
            session_tags[session_id] = normalized
    return session_tags


def _save_session_tags(tags: dict[str, list[str]]) -> None:
    payload: dict[str, list[str]] = {}
    for session_id, raw_tags in tags.items():
        if not isinstance(session_id, str):
            continue
        normalized = _normalize_session_tags(raw_tags)
        if normalized:
            payload[session_id] = normalized

    tmp = _TAGS_FILE.with_suffix(".tmp")
    try:
        _TAGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(_TAGS_FILE)
    except Exception:
        log.warning("session tags: unable to persist %s", _TAGS_FILE)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def _load_session_descriptions() -> dict[str, str]:
    try:
        raw = json.loads(_DESCRIPTIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        log.warning("session descriptions: unable to read %s", _DESCRIPTIONS_FILE)
        return {}

    if not isinstance(raw, dict):
        log.warning(
            "session descriptions: ignoring non-object payload in %s",
            _DESCRIPTIONS_FILE,
        )
        return {}

    descriptions: dict[str, str] = {}
    for session_id, description in raw.items():
        if not isinstance(session_id, str) or not isinstance(description, str):
            continue
        normalized = description.strip()
        if normalized:
            descriptions[session_id] = normalized
    return descriptions


def _save_session_descriptions(descriptions: dict[str, str]) -> None:
    payload: dict[str, str] = {}
    for session_id, raw_description in descriptions.items():
        if not isinstance(session_id, str) or not isinstance(raw_description, str):
            continue
        normalized = raw_description.strip()
        if normalized:
            payload[session_id] = normalized

    tmp = _DESCRIPTIONS_FILE.with_suffix(".tmp")
    try:
        _DESCRIPTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(_DESCRIPTIONS_FILE)
    except Exception:
        log.warning("session descriptions: unable to persist %s", _DESCRIPTIONS_FILE)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


_HEALTH_PATTERNS: list[tuple[str, list[str]]] = [
    # Existing patterns
    ("interactive_prompt", [r"[$>]\s*$", r">>>\s*$", r"❯\s*$", r"\(venv\).*[$>]\s*$"]),
    (
        "stdin_waiting",
        [
            r"\(y/n\)",
            r"\[Y/n\]",
            r"\[y/N\]",
            r"Continue\?",
            r"Press any key",
            r"\[Press Enter\]",
            r"Password:",
            r"Are you sure",
        ],
    ),
    (
        "known_tool",
        [r"Running tool", r"Tool:", r"Calling:", r"⟳", r"Executing:", r"bash\s*\$"],
    ),
    (
        "agent_loop",
        [r"Thinking\.\.\.", r"Processing\.\.\.", r"^▶", r"• Working", r"\.\.\."],
    ),
    (
        "agent_asking",
        [r"\?\s*$", r"I need", r"Can you", r"Please provide", r"What would you"],
    ),
    # New patterns
    (
        "test_running",
        [
            r"PASSED",
            r"FAILED",
            r"pytest",
            r"test.*running",
            r"npm test",
            r"cargo test",
            r"\d+ tests?",
        ],
    ),
    (
        "build_running",
        [
            r"Building",
            r"Compiling",
            r"cargo build",
            r"npm run build",
            r"make\s",
            r"Linking",
        ],
    ),
    (
        "git_operation",
        [
            r"git (push|pull|commit|merge|rebase)",
            r"Pushing to",
            r"Fetching from",
            r"Already up to date",
        ],
    ),
    (
        "agent_done",
        [
            r"Done\.",
            r"Complete\.",
            r"Finished\.",
            r"All tests pass",
            r"✓ All",
            r"Successfully",
        ],
    ),
    (
        "error_state",
        [r"Error:", r"ERROR:", r"Traceback", r"FAILED", r"fatal:", r"error\[E", r"✗"],
    ),
    (
        "rate_limited",
        [
            r"rate.?limit",
            r"429",
            r"Too Many Requests",
            r"overloaded",
            r"quota exceeded",
        ],
    ),
]


def _health_check_pattern(lines: list[str]) -> tuple[str, float]:
    """Classify last 15 pane lines. Returns (category, confidence 0.0-1.0)."""
    import re as _re

    tail = lines[-15:] if len(lines) > 15 else lines
    text = "\n".join(tail)

    for category, patterns in _HEALTH_PATTERNS:
        matches = 0
        for pat in patterns:
            if _re.search(pat, text, _re.MULTILINE | _re.IGNORECASE):
                matches += 1
        if matches > 0:
            confidence = min(1.0, matches / max(1, len(patterns)) * 2)
            return category, confidence
    return "unknown", 0.0


def _resolve_template_vars(template: dict, context: dict) -> dict:
    """Replace {{variable}} placeholders in template string values."""
    import re as _re

    result = {}
    for k, v in template.items():
        if isinstance(v, str):

            def _replace(m: "_re.Match[str]") -> str:
                return str(context.get(m.group(1), m.group(0)))

            result[k] = _re.sub(r"\{\{(\w+)\}\}", _replace, v)
        else:
            result[k] = v
    return result


def _log_recovery(
    session_id: str, title: str, pattern: str, action: str, auto: bool
) -> None:
    """Append a recovery event to ~/.omp/agent/recovery_log.jsonl."""
    import json as _json
    import time as _t

    entry = {
        "ts": _t.time(),
        "session_id": session_id,
        "title": title,
        "pattern": pattern,
        "action": action,
        "auto": auto,
    }
    try:
        _RECOVERY_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(_RECOVERY_LOG, "a", encoding="utf-8") as fh:
            fh.write(_json.dumps(entry) + "\n")
    except Exception as exc:
        log.debug("recovery log write failed: %s", exc)


def _export_sessions_artifacts(sessions: list[AgentSession]) -> None:
    import csv as _csv
    import datetime as _dt

    timestamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    export_dir = Path("~/.omp/agent/exports").expanduser()
    json_path = export_dir / f"sessions_{timestamp}.json"
    csv_path = export_dir / f"sessions_{timestamp}.csv"
    report_path = export_dir / f"status_report_{timestamp}.md"

    def _last_activity(ts: float | None) -> str:
        if ts is None:
            return ""
        try:
            return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return ""

    def _context_pct(pct: float | None) -> float | None:
        if pct is None:
            return None
        return round(max(0.0, min(1.0, pct)) * 100, 2)

    def _context_display(pct: float | None) -> str:
        pct_value = _context_pct(pct)
        if pct_value is None:
            return "—"
        return f"{pct_value:.0f}%"

    def _md_cell(value: object) -> str:
        text = "" if value is None else str(value)
        return text.replace("|", "\\|").replace("\n", " ").strip()

    rows: list[dict[str, object]] = []
    for session in sessions:
        rows.append(
            {
                "session_id": session.session_id,
                "title": session.title,
                "harness": session.harness,
                "status": session.status,
                "role": session.role,
                "branch": session.branch,
                "cwd": session.cwd,
                "model": session.model,
                "context_usage_pct": _context_pct(session.context_usage_pct),
                "last_activity": _last_activity(session.last_activity_ts),
                "age_str": session.age_str,
                "quick_note": session.quick_note,
            }
        )

    fields = [
        "session_id",
        "title",
        "harness",
        "status",
        "role",
        "branch",
        "cwd",
        "model",
        "context_usage_pct",
        "last_activity",
        "age_str",
        "quick_note",
    ]

    export_dir.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        writer = _csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    running_count = sum(
        1 for row in rows if str(row.get("status", "")).lower() == "running"
    )
    stalled_count = sum(
        1 for row in rows if str(row.get("status", "")).lower() == "stalled"
    )
    waiting_count = sum(
        1
        for row in rows
        if str(row.get("status", "")).lower() in {"wait", "waiting", "asking", "review"}
    )

    active_rows: list[str] = []
    stalled_rows: list[str] = []
    for session, row in zip(sessions, rows):
        title_text = (
            str(row.get("title", "")).strip() or str(row.get("session_id", "")).strip()
        )
        status_text = str(row.get("status", "")).strip() or "—"
        branch_text = str(row.get("branch", "")).strip() or "—"
        role_text = str(row.get("role", "")).strip() or "—"
        age_text = str(row.get("age_str", "")).strip() or "—"
        context_text = _context_display(session.context_usage_pct)

        if session.state == "active":
            active_rows.append(
                "| "
                + " | ".join(
                    [
                        _md_cell(title_text),
                        _md_cell(status_text),
                        _md_cell(branch_text),
                        _md_cell(role_text),
                        _md_cell(age_text),
                        _md_cell(context_text),
                    ]
                )
                + " |"
            )

        if status_text.lower() == "stalled":
            stalled_rows.append(
                "| "
                + " | ".join(
                    [
                        _md_cell(title_text),
                        _md_cell(status_text),
                        _md_cell(str(row.get("last_activity", "")).strip() or "—"),
                        _md_cell(str(row.get("quick_note", "")).strip() or "—"),
                    ]
                )
                + " |"
            )

    report_lines = [
        "# Agents Status Report",
        f"Generated: {_dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "## Summary",
        f"- Total: {len(rows)} sessions",
        f"- Running: {running_count}",
        f"- Stalled: {stalled_count}",
        f"- Waiting: {waiting_count}",
        "",
        "## Active Sessions",
        "| Session | Status | Branch | Role | Age | Context |",
        "|---------|--------|--------|------|-----|---------|",
    ]

    if active_rows:
        report_lines.extend(active_rows)
    else:
        report_lines.append("| _None_ | - | - | - | - | - |")

    report_lines.extend(
        [
            "",
            "## Stalled Sessions",
            "| Session | Status | Last Activity | Note |",
            "|---------|--------|---------------|------|",
        ]
    )

    if stalled_rows:
        report_lines.extend(stalled_rows)
    else:
        report_lines.append("| _None_ | - | - | - |")

    report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")


class HelpScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("?", "dismiss", "Close", show=False),
    ]
    CSS = """
    HelpScreen {
        align: center middle;
        background: #22272e80;
    }
    HelpScreen > Vertical {
        width: 70;
        height: auto;
        max-height: 90vh;
        background: #2d333b;
        border: round #444c56;
        padding: 1 2;
    }
    HelpScreen #help-title {
        text-align: center;
        color: #cdd9e5;
        text-style: bold;
        padding-bottom: 1;
    }
    HelpScreen DataTable {
        background: #2d333b;
        height: auto;
    }
    """

    _BINDINGS_TABLE = [
        ("Navigation", "↑ k", "Move up"),
        ("Navigation", "↓ j", "Move down"),
        ("Navigation", "g", "Jump to top"),
        ("Navigation", "G", "Jump to bottom"),
        ("Navigation", "Ctrl+Home", "Jump to first row"),
        ("Navigation", "Ctrl+End", "Jump to last row"),
        ("Navigation", "F", "Toggle follow mode"),
        ("Navigation", "Enter", "Jump to / Resume + focus input"),
        ("Projects", "Ctrl+→", "Next project tab"),
        ("Projects", "Ctrl+←", "Prev project tab"),
        ("Session", "x", "Mark session done"),
        ("Session", "Ctrl+K", "Kill active session"),
        ("Session", "Ctrl+Space", "Select for compare"),
        ("Session", "m", "Toggle bookmark"),
        ("Session", "Ctrl+J", "Next bookmark"),
        ("Session", "o", "Open session / PR"),
        ("Session", "H", "Health check"),
        ("Session", "y", "Yank session ID"),
        ("Session", "Y", "Yank full info"),
        ("Panel", "Ctrl+]", "Next right-panel tab"),
        ("Panel", "Ctrl+[", "Prev right-panel tab"),
        ("Broadcast", "Space", "Toggle broadcast select"),
        ("Broadcast", "B", "Broadcast to selected panes"),
        ("Broadcast", "Ctrl+B", "Broadcast groups"),
        ("Broadcast", "P", "Broadcast template"),
        ("Screens", "W", "Worktree manager"),
        ("Screens", "A", "Session archive"),
        ("Screens", "Ctrl+G", "Orchestrator graph"),
        ("Screens", "Ctrl+F", "Global search"),
        ("Screens", "L", "Recovery log"),
        ("Screens", "l", "Session log"),
        ("Screens", "M", "Metrics"),
        ("Screens", "C", "Config"),
        ("Screens", "S", "Stalled agents"),
        ("Git", "Ctrl+Alt+F", "Git fetch"),
        ("Git", "Ctrl+Alt+P", "Git push"),
        ("Git", "Ctrl+Alt+L", "Git log"),
        ("Input", "Ctrl+N", "New session spawn dialog"),
        ("Input", "T", "Template picker"),
        ("Input", "V", "Column picker"),
        ("Input", "N", "Save quick note"),
        ("Input", "D", "Edit session description"),
        ("Input", "t", "Tag selected session"),
        ("Input", "Ctrl+R", "History search (fzf)"),
        ("Search", "/", "Filter sessions"),
        ("Search", "#tag", "Filter sessions by tag"),
        ("Search", "Ctrl+S", "Save filter preset"),
        ("Search", "Ctrl+L", "Load filter preset"),
        ("Search", "a", "Toggle scope"),
        ("Search", "r", "Refresh now"),
        ("Search", "p", "Toggle pivot view"),
        ("Sort", "Ctrl+1", "Sort by status"),
        ("Sort", "Ctrl+2", "Sort by age"),
        ("Sort", "Ctrl+3", "Sort by role"),
        ("Sort", "Ctrl+4", "Sort by name"),
        ("Sort", "Ctrl+5", "Sort by context"),
        ("Sort", "Ctrl+6", "Sort by branch"),
        ("App", "Tab", "Switch table/input focus"),
        ("App", "Ctrl+E", "Export sessions"),
        ("App", "Ctrl+P", "Command palette"),
        ("App", "@", "Rec macro"),
        ("App", "!", "Replay macro"),
        ("App", "Ctrl+T", "Cycle theme"),
        ("App", "?", "This help screen"),
        ("App", "q", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Agents View — Keybindings", id="help-title")
            yield DataTable(id="help-table", show_cursor=False, show_header=True)

    def on_mount(self) -> None:
        table = self.query_one("#help-table", DataTable)
        table.add_column("Category", width=12, key="cat")
        table.add_column("Key", width=16, key="key")
        table.add_column("Action", width=36, key="desc")

        previous_category = ""
        for category, key_name, description in self._BINDINGS_TABLE:
            if category != previous_category:
                category_cell = Text(category, style="bold #6cb6ff")
            else:
                category_cell = Text("")
            key_cell = Text(key_name, style="bold #f0883e")
            action_cell = Text(description, style="#adbac7")
            table.add_row(category_cell, key_cell, action_cell)
            previous_category = category


class SettingsScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("s", "save_settings", "Save"),
        Binding("enter", "save_settings", "Save", show=False),
        Binding("up", "move_up", "", show=False, priority=True),
        Binding("down", "move_down", "", show=False, priority=True),
        Binding("left", "decrement", "Decrease"),
        Binding("right", "increment", "Increase"),
        Binding("[", "decrement", "", show=False),
        Binding("]", "increment", "", show=False),
    ]

    CSS = """
    SettingsScreen {
        align: center middle;
        background: #22272e80;
    }
    SettingsScreen > Vertical {
        width: 80;
        height: 20;
        background: #2d333b;
    }
    SettingsScreen #settings-title {
        text-align: center;
        color: #cdd9e5;
        text-style: bold;
        padding-bottom: 1;
    }
    SettingsScreen DataTable {
        height: 12;
        background: #2d333b;
    }
    SettingsScreen #settings-help {
        color: #768390;
        padding-top: 1;
    }
    """

    _ROWS: list[tuple[str, str, tuple[int, ...]]] = [
        ("refresh_interval_seconds", "Refresh interval (seconds)", (1, 2, 3, 5, 10)),
        ("stall_threshold_seconds", "Stall threshold (seconds)", (30, 60, 120, 300)),
        (
            "auto_kill_stalled_minutes",
            "Auto-kill stalled after (minutes)",
            (0, 5, 10, 30, 60),
        ),
        ("stale_worktree_days", "Stale worktree days", (3, 7, 14, 30)),
        ("max_inactive", "Max inactive sessions shown", (5, 10, 20, 50)),
        ("preview_tail_bytes", "Preview tail lines", (32_768, 65_536, 163_840)),
        ("preview_max_lines", "Preview max lines", (100, 200, 300, 500)),
    ]

    def __init__(
        self,
        current_settings: dict[str, int],
        on_save: Callable[[dict[str, int]], None] | None = None,
    ) -> None:
        super().__init__()
        self._values = _sanitize_agents_view_settings(current_settings)
        self._on_save = on_save

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Agents View — Settings", id="settings-title")
            yield DataTable(id="settings-table", cursor_type="row", show_cursor=True)
            yield Static(
                "←/→ or [ and ] adjust • s/Enter save • Esc close", id="settings-help"
            )

    def on_mount(self) -> None:
        table = self.query_one("#settings-table", DataTable)
        table.add_column("setting", width=30, key="setting")
        table.add_column("value", width=20, key="value")
        table.add_column("hint", width=30, key="hint")
        self._render_table()
        table.focus()

    def _display_value(self, key: str, value: int) -> str:
        if key == "refresh_interval_seconds":
            return f"{value}s"
        if key == "stall_threshold_seconds":
            return f"{value}s"
        if key == "auto_kill_stalled_minutes":
            return "disabled" if value == 0 else f"{value}m"
        if key == "stale_worktree_days":
            return f"{value}d"
        if key == "preview_tail_bytes":
            lines = _PREVIEW_TAIL_BYTES_TO_LINES.get(value, 200)
            return f"{lines} lines"
        if key == "preview_max_lines":
            return f"{value} lines"
        return str(value)

    def _render_table(self) -> None:
        table = self.query_one("#settings-table", DataTable)
        current_row = max(0, table.cursor_row) if table.row_count else 0
        table.clear()
        for key, label, _ in self._ROWS:
            value = self._values.get(key, _DEFAULT_AGENTS_VIEW_SETTINGS[key])
            display = self._display_value(key, value)
            table.add_row(
                Text(label, style="#adbac7"),
                Text(display, style="bold #6cb6ff"),
                Text(f"[ < ] {display} [ > ]", style="#f0883e"),
                key=key,
            )
        if table.row_count:
            table.move_cursor(row=min(current_row, table.row_count - 1))

    def _selected_setting(self) -> tuple[str, tuple[int, ...], int] | None:
        table = self.query_one("#settings-table", DataTable)
        row = table.cursor_row
        if row < 0 or row >= len(self._ROWS):
            return None
        key, _label, allowed = self._ROWS[row]
        return key, allowed, row

    def _adjust_selected(self, delta: int) -> None:
        selected = self._selected_setting()
        if selected is None:
            return
        key, allowed, row = selected
        current = self._values.get(key, _DEFAULT_AGENTS_VIEW_SETTINGS[key])
        try:
            idx = allowed.index(current)
        except ValueError:
            idx = 0
        target_idx = max(0, min(len(allowed) - 1, idx + delta))
        if target_idx == idx:
            return
        self._values[key] = allowed[target_idx]
        self._render_table()
        self.query_one("#settings-table", DataTable).move_cursor(row=row)

    def action_increment(self) -> None:
        self._adjust_selected(1)

    def action_decrement(self) -> None:
        self._adjust_selected(-1)

    def action_move_up(self) -> None:
        table = self.query_one("#settings-table", DataTable)
        table.move_cursor(row=max(0, table.cursor_row - 1))

    def action_move_down(self) -> None:
        table = self.query_one("#settings-table", DataTable)
        max_row = max(0, table.row_count - 1)
        table.move_cursor(row=min(max_row, table.cursor_row + 1))

    def action_dismiss(self) -> None:
        self.dismiss(None)

    def action_save_settings(self) -> None:
        try:
            saved = _save_agents_view_settings(self._values)
            _apply_agents_view_runtime_settings(saved)
            if self._on_save is not None:
                self._on_save(dict(saved))
            self.dismiss(saved)
            self.app.notify("Settings saved")
        except Exception as exc:
            self.app.notify(f"Failed to save settings: {exc}", severity="error")


_HELP_TEXT = "\n".join(
    [
        "Agents View — Keybindings",
        "─────────────────────────────",
        "    ↑ / k        Move up",
        "    ↓ / j        Move down",
        "    g            Jump to top",
        "    G            Jump to bottom",
        "    ctrl+home    Jump to first row",
        "    ctrl+end     Jump to last row",
        "    F            Toggle follow mode",
        "    Enter        Jump to / Resume + focus input",
        "    Space        Toggle broadcast selection",
        "    B            Broadcast input to selected panes",
        "    N            Save/clear quick note from input",
        "    P            Broadcast template",
        "    t            Tag selected session from input",
        "    x            Mark active session done",
        "    Tab          Switch table/input focus",
        "    ctrl+n       New session",
        "    T            Templates",
        "    V            Column picker",
        "    W            Worktrees",
        "    H            Health check",
        "    L            Recovery log",
        "    C            Config",
        "    S            Stalled agents",
        "    l            Session log",
        "    ctrl+f       Global search",
        "    ctrl+k       Kill active session",
        "    ctrl+space   Toggle session compare selection",
        "    m            Toggle bookmark on selected session",
        "    ctrl+j       Jump to next bookmarked session",
        "    o            Open session in new tmux window",
        "    /            Filter sessions",
        "    #tag         Filter sessions by tag",
        "    ctrl+s       Save filter preset",
        "    ctrl+l       Load filter preset",
        "    a            Toggle scope (scoped/all paths)",
        "    r            Refresh now",
        "    p            Toggle pivot view",
        "    ctrl+1       Sort by status",
        "    ctrl+2       Sort by age",
        "    ctrl+3       Sort by role",
        "    ctrl+4       Sort by name",
        "    ctrl+5       Sort by context",
        "    ctrl+6       Sort by branch",
        "    ctrl+e       Export sessions",
        "    ctrl+p       Command palette",
        "    ctrl+t       Cycle theme",
        "    ctrl+→ / ctrl+←  Switch project tab (if terminal passes key)",
        "    @            Toggle macro recording",
        "    !            Replay last macro",
        "    ?            This help screen",
        "    q            Quit",
    ]
)


@lru_cache(maxsize=512)
def _project_root_for(cwd: str, scope_root: str) -> Optional[str]:
    """Walk cwd upward until .git is found or we reach scope_root; return that dir."""
    if not cwd:
        return None
    path = os.path.realpath(cwd)
    root = os.path.realpath(scope_root) if scope_root else "/"
    while True:
        if os.path.isdir(os.path.join(path, ".git")):
            return path
        parent = os.path.dirname(path)
        if parent == path or (root != "/" and not path.startswith(root)):
            return None
        path = parent


class ProjectTabBar(Widget):
    """Single-line project tab bar above the main table."""

    class TabChanged(Message):
        """Emitted when the active project tab changes."""

        def __init__(self, project_root: Optional[str]) -> None:
            super().__init__()
            self.project_root = project_root  # None = ALL

    DEFAULT_CSS = """
    ProjectTabBar {
        height: 1;
        background: #22272e;
        padding: 0 1;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self._tabs: list[tuple[str, str | None]] = []  # (label, project_root)
        self._active_idx: int = 0

    def update_tabs(
        self,
        sessions: list[AgentSession],
        scope_root: str,
        active_idx: int | None = None,
    ) -> None:
        """Recompute tabs from session list and refresh display."""
        seen: dict[str, str] = {}  # project_root -> display_name
        for s in sessions:
            root = _project_root_for(s.cwd, scope_root)
            if root and root not in seen:
                seen[root] = os.path.basename(root) or root
        tabs: list[tuple[str, str | None]] = [("ALL", None)]
        for root, name in sorted(seen.items()):
            active_count = sum(
                1
                for s in sessions
                if s.state == "active" and _project_root_for(s.cwd, scope_root) == root
            )
            total_count = sum(
                1 for s in sessions if _project_root_for(s.cwd, scope_root) == root
            )
            if total_count > 0:
                label = f"{name} ({active_count}/{total_count})"
            else:
                label = name
            tabs.append((label, root))
        self._tabs = tabs
        if active_idx is not None:
            self._active_idx = max(0, min(active_idx, len(tabs) - 1))
        elif self._active_idx >= len(tabs):
            self._active_idx = 0
        self.refresh()

    def render(self) -> Text:
        t = Text()
        for i, (label, _) in enumerate(self._tabs):
            display = f"◉ {label}" if i == 0 else f"  {label}"
            if i == self._active_idx:
                t.append(f" {display} ", style="bold #cdd9e5 underline")
            else:
                t.append(f" {display} ", style="#636e7b")
            if i < len(self._tabs) - 1:
                t.append("│", style="#444c56")
        return t

    def select_tab(self, idx: int) -> None:
        if not self._tabs:
            return
        self._active_idx = max(0, min(idx, len(self._tabs) - 1))
        self.refresh()
        _, root = self._tabs[self._active_idx]
        self.post_message(ProjectTabBar.TabChanged(root))

    def next_tab(self) -> None:
        self.select_tab((self._active_idx + 1) % max(1, len(self._tabs)))

    def prev_tab(self) -> None:
        self.select_tab((self._active_idx - 1) % max(1, len(self._tabs)))


def _parse_worktrees(repo_root: str) -> list[dict]:
    """Return list of worktree dicts: {path, branch, is_current, head}."""
    import os as _os
    import subprocess

    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return []
    if result.returncode != 0:
        return []

    out = result.stdout
    worktrees: list[dict] = []
    current: dict = {}
    for line in out.splitlines():
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = {
                "path": line[9:],
                "branch": "",
                "head": "",
                "is_current": False,
            }
        elif line.startswith("HEAD "):
            current["head"] = line[5:]
        elif line.startswith("branch "):
            ref = line[7:]
            current["branch"] = ref.replace("refs/heads/", "")
        elif line == "bare":
            current["bare"] = True
        elif line == "(detached HEAD)":
            current["branch"] = "(detached)"
    if current:
        worktrees.append(current)

    # Mark current worktree by current process cwd.
    if worktrees:
        cwd_real = _os.path.realpath(_os.getcwd())
        for wt in worktrees:
            try:
                if _os.path.realpath(wt["path"]) == cwd_real:
                    wt["is_current"] = True
            except Exception:
                continue
    return worktrees


class PruneScreen(Screen):
    """Worktree prune wizard: scan and multi-select for removal."""

    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("q", "dismiss", "Cancel", show=False),
        Binding("space", "toggle_select", "Toggle", show=False),
        Binding("enter", "prune_selected", "Prune selected"),
        Binding("up", "move_up", "Up", show=False, priority=True),
        Binding("down", "move_down", "Down", show=False, priority=True),
    ]

    CSS = """
    PruneScreen {
        background: #22272e;
    }
    PruneScreen DataTable {
        height: 1fr;
        background: #22272e;
    }
    PruneScreen Static#prune-footer {
        height: 1;
        background: #1c2128;
        color: #636e7b;
    }
    """

    def __init__(
        self, worktrees: list[dict], sessions: list[AgentSession], repo_root: str
    ) -> None:
        super().__init__()
        self._all_worktrees = worktrees
        self._sessions = sessions
        self._repo_root = repo_root
        self._stale_days = self._resolve_stale_worktree_days()
        self._candidates: list[dict] = []
        self._selected: set[str] = set()
        self._ordered_paths: list[str] = []
        self._confirm_pending = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Scanning for prunable worktrees...", id="prune-scan-status")
        yield DataTable(id="prune-table", cursor_type="row", show_cursor=True)
        yield Static("", id="prune-footer")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#prune-table", DataTable)
        table.add_column(" ", width=2, key="sel")
        table.add_column("BRANCH", width=26, key="branch")
        table.add_column("REASON", width=20, key="reason")
        table.add_column("PATH", width=40, key="path")
        self._scan_candidates()

    def _resolve_stale_worktree_days(self) -> int:
        return _load_agents_view_settings()["stale_worktree_days"]

    def _has_recent_file_activity(self, path: str, newer_than_ts: float) -> bool:
        import os as _os

        for root, dirs, files in _os.walk(path):
            dirs[:] = [name for name in dirs if name != ".git"]
            for filename in files:
                file_path = _os.path.join(root, filename)
                try:
                    if _os.path.getmtime(file_path) >= newer_than_ts:
                        return True
                except Exception:
                    continue
        return False

    @work(thread=True, exclusive=True, group="prune-scan")
    def _scan_candidates(self) -> None:
        import os as _os
        import subprocess
        import time as _t

        candidates: list[dict] = []
        protected_branches = {"main", "master", "develop"}

        try:
            merged_result = subprocess.run(
                ["git", "branch", "--merged", "main"],
                cwd=self._repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if merged_result.returncode == 0:
                merged_branches = {
                    branch.strip().lstrip("* ")
                    for branch in merged_result.stdout.splitlines()
                    if branch.strip()
                }
            else:
                merged_branches = set()
        except Exception:
            merged_branches = set()

        try:
            remote_result = subprocess.run(
                ["git", "ls-remote", "--heads", "origin"],
                cwd=self._repo_root,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if remote_result.returncode == 0:
                remote_branches = {
                    line.split("refs/heads/")[-1]
                    for line in remote_result.stdout.splitlines()
                    if "refs/heads/" in line
                }
            else:
                remote_branches = set()
        except Exception:
            remote_branches = set()

        session_paths: set[str] = set()
        for session in self._sessions:
            if not session.cwd:
                continue
            try:
                session_paths.add(_os.path.realpath(session.cwd.rstrip("/")))
            except Exception:
                session_paths.add(session.cwd.rstrip("/"))

        now_ts = _t.time()
        stale_cutoff_seconds = self._stale_days * 86400
        file_activity_cutoff = now_ts - 24 * 60 * 60

        for wt in self._all_worktrees:
            path = wt.get("path", "")
            branch = wt.get("branch", "")
            if wt.get("is_current") or not path or not branch or branch == "(detached)":
                continue

            try:
                path_key = _os.path.realpath(path.rstrip("/"))
            except Exception:
                path_key = path.rstrip("/")

            reason = ""
            if branch in merged_branches and branch not in protected_branches:
                reason = "merged"
            elif remote_branches and branch not in remote_branches:
                reason = "orphaned"
            else:
                try:
                    log_result = subprocess.run(
                        ["git", "log", "-1", "--format=%ct"],
                        cwd=path,
                        capture_output=True,
                        text=True,
                        timeout=2,
                    )
                    last_ts = (
                        int(log_result.stdout.strip())
                        if log_result.stdout.strip()
                        else 0
                    )
                    if last_ts and (now_ts - last_ts) > stale_cutoff_seconds:
                        reason = "stale"
                except Exception:
                    pass

            if not reason and path_key not in session_paths:
                try:
                    if not self._has_recent_file_activity(path, file_activity_cutoff):
                        reason = "agentless+inactive"
                except Exception:
                    pass

            if reason:
                candidates.append({"path": path, "branch": branch, "reason": reason})

        self.app.call_from_thread(self._populate_prune_table, candidates)

    def _populate_prune_table(self, candidates: list[dict]) -> None:
        self._confirm_pending = False
        try:
            self.query_one("#prune-scan-status", Static).update(
                f"Found {len(candidates)} prunable worktrees"
            )
        except Exception:
            pass

        table = self.query_one("#prune-table", DataTable)
        table.clear()
        self._candidates = candidates
        self._selected.clear()
        self._ordered_paths = []

        for candidate in candidates:
            path = candidate["path"]
            sel = Text("[ ]", style="#636e7b")
            branch = Text(candidate["branch"][:24], style="italic #daaa3f")
            reason = Text(candidate["reason"], style="#d4a72c")
            path_cell = Text(path[:38], style="#636e7b")
            table.add_row(sel, branch, reason, path_cell, key=path)
            self._ordered_paths.append(path)

        self._update_footer()

    def _update_footer(self) -> None:
        selected_count = len(self._selected)
        if self._confirm_pending and selected_count:
            footer = (
                f"Confirm prune {selected_count} worktrees: Enter=confirm Esc=cancel"
            )
        else:
            footer = f"{selected_count} selected | Space=toggle Enter=prune Esc=cancel"
        try:
            self.query_one("#prune-footer", Static).update(footer)
        except Exception:
            pass

    def _current_path(self) -> Optional[str]:
        try:
            table = self.query_one("#prune-table", DataTable)
            idx = table.cursor_row
            if 0 <= idx < len(self._ordered_paths):
                return self._ordered_paths[idx]
        except Exception:
            pass
        return None

    def action_toggle_select(self) -> None:
        path = self._current_path()
        if not path:
            self._confirm_pending = False
            self._update_footer()
            return

        table = self.query_one("#prune-table", DataTable)
        if path in self._selected:
            self._selected.discard(path)
            new_sel = Text("[ ]", style="#636e7b")
        else:
            self._selected.add(path)
            new_sel = Text("[x]", style="bold #57ab5a")
        try:
            table.update_cell(path, "sel", new_sel, update_width=False)
        except Exception:
            pass
        self._confirm_pending = False
        self._update_footer()

    def action_move_up(self) -> None:
        try:
            table = self.query_one("#prune-table", DataTable)
            target = max(0, table.cursor_row - 1)
            table.move_cursor(row=target)
        except Exception:
            pass

    def action_move_down(self) -> None:
        try:
            table = self.query_one("#prune-table", DataTable)
            max_row = max(0, len(self._ordered_paths) - 1)
            target = min(max_row, table.cursor_row + 1)
            table.move_cursor(row=target)
        except Exception:
            pass

    def action_prune_selected(self) -> None:
        import subprocess

        selected_count = len(self._selected)
        if selected_count == 0:
            self.notify("No worktrees selected")
            self._confirm_pending = False
            self._update_footer()
            return

        if not self._confirm_pending:
            self._confirm_pending = True
            self.notify(f"Confirm prune: {selected_count} worktrees")
            self._update_footer()
            return

        self._confirm_pending = False
        errors: list[str] = []
        for path in list(self._selected):
            branch = next(
                (
                    candidate["branch"]
                    for candidate in self._candidates
                    if candidate["path"] == path
                ),
                "",
            )
            try:
                subprocess.run(
                    ["git", "worktree", "remove", "--force", path],
                    cwd=self._repo_root,
                    timeout=10,
                    check=True,
                )
                if branch and branch not in ("main", "master", "develop"):
                    subprocess.run(
                        ["git", "branch", "-d", branch],
                        cwd=self._repo_root,
                        timeout=5,
                        check=False,
                    )
            except Exception as exc:
                errors.append(str(exc))

        if errors:
            self.notify(f"Pruned with errors: {errors[0]}", severity="warning")
        else:
            self.notify(f"Pruned {selected_count} worktrees")
        self.dismiss(True)


class WorktreeScreen(Screen):
    """Full-screen worktree command center."""

    BINDINGS = [
        Binding("escape", "dismiss", "Back"),
        Binding("q", "dismiss", "Back", show=False),
        Binding("up", "move_up", "Up", show=False, priority=True),
        Binding("down", "move_down", "Down", show=False, priority=True),
        Binding("j", "jump_worktree", "Jump"),
        Binding("d", "delete_worktree", "Delete"),
        Binding("s", "sync_worktree", "Sync"),
        Binding("f", "fetch_log", "Fetch log"),
        Binding("a", "spawn_agent", "Spawn agent"),
        Binding("n", "new_wizard", "New worktree"),
        Binding("p", "prune_wizard", "Prune"),
        Binding("c", "copy_worktree", "Copy"),
        Binding("r", "edit_note", "Edit note"),
        Binding("enter", "jump_to_sessions", "Jump to sessions"),
    ]

    CSS = """
    WorktreeScreen {
        background: #22272e;
    }
    WorktreeScreen DataTable {
        height: 1fr;
        background: #22272e;
    }
    WorktreeScreen Static#wt-status-bar {
        height: 1;
        background: #1c2128;
        color: #636e7b;
    }
    WorktreeScreen #wt-wizard {
        height: auto;
        max-height: 8;
        background: #2d333b;
        border-top: solid #444c56;
        padding: 0 1;
    }
    WorktreeScreen #wt-wizard.hidden {
        display: none;
    }
    WorktreeScreen #wt-wizard-header {
        color: #cdd9e5;
        height: 1;
    }
    WorktreeScreen #wt-wizard-input {
        border: solid #316dca;
        background: #22272e;
        color: #adbac7;
        height: 3;
    }
    WorktreeScreen #wt-wizard-info {
        color: #636e7b;
        height: 2;
    }
    """

    def __init__(
        self,
        sessions: list[AgentSession],
        tmux: TmuxClient,
        scope_root: str,
        preselect_path: Optional[str] = None,
    ) -> None:
        super().__init__()
        self._sessions = sessions
        self._tmux = tmux
        self._scope_root = scope_root
        self._preselect_path = preselect_path
        self._worktrees: list[dict] = []
        self._ordered_paths: list[str] = []
        self._wizard_step: int = 0  # 0=hidden, 1=step1, 2=step2, 3=step3
        self._wiz_branch: str = ""
        self._wiz_base: str = "main"
        self._wiz_fetch: bool = False
        self._wiz_spawn: bool = True
        self._wiz_harness: str = "omp"
        self._wiz_role: str = "default"
        self._wiz_task: str = ""
        self._copy_src_path: str = ""
        self._copy_src_branch: str = ""
        self._note_path: str = ""
        self._note_row_path: str = ""

    def compose(self) -> ComposeResult:
        yield Header()
        yield DataTable(id="wt-table", cursor_type="row", show_cursor=True)
        with Vertical(id="wt-wizard", classes="hidden"):
            yield Static("", id="wt-wizard-header")
            yield Input(id="wt-wizard-input", placeholder="")
            yield Static("", id="wt-wizard-info", markup=False)
        yield Static("", id="wt-status-bar", markup=False)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#wt-table", DataTable)
        table.add_column("✦", width=2, key="current")
        table.add_column("BRANCH", width=26, key="branch")
        table.add_column("STATUS", width=12, key="status")
        table.add_column("AGENT", width=14, key="agent")
        table.add_column("SYNC", width=8, key="sync")
        table.add_column("AGE", width=5, key="age")
        table.add_column("NOTES", width=20, key="notes")
        self._load_worktrees()

    @work(thread=True, exclusive=True, group="wt-refresh")
    def _load_worktrees(self) -> None:
        import os as _os
        import subprocess
        import time as _t

        repo_root = self._scope_root if self._scope_root != "/" else _os.getcwd()
        self._worktrees = _parse_worktrees(repo_root)
        rows: list[tuple] = []

        for wt in self._worktrees:
            path = wt.get("path", "")
            branch = wt.get("branch", "")
            if not path or wt.get("bare"):
                continue

            marker = Text("*" if wt.get("is_current") else " ", style="#cdd9e5")
            truncated_branch = branch[:24] + "…" if len(branch) > 24 else branch
            branch_cell = Text(truncated_branch or "(detached)", style="italic #daaa3f")

            last_ct = 0
            last_ct_raw = _cached_git(
                f"wt:last-commit-ts:{path}",
                ["git", "log", "-1", "--format=%ct"],
                cwd=path,
                timeout=2,
            )
            if last_ct_raw:
                try:
                    last_ct = int(last_ct_raw)
                except Exception:
                    last_ct = 0

            status_cell = Text("", style="#303a46")
            try:
                sp = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=path,
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                lines = [line for line in sp.stdout.splitlines() if line.strip()]
                n_modified = len(lines)
                stale = last_ct > 0 and (_t.time() - last_ct) > 7 * 86400
                conflict_codes = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
                has_conflict = any(
                    len(line) >= 2 and (line[:2] in conflict_codes or "U" in line[:2])
                    for line in lines
                )

                if has_conflict:
                    status_cell = Text("✗ conflict", style="#f47067")
                elif n_modified == 0 and not stale:
                    status_cell = Text("✓ clean", style="#57ab5a")
                elif stale:
                    status_cell = Text("⚠ stale", style="#e8703a")
                else:
                    status_cell = Text(f"◉ dirty+{n_modified}", style="#d4a72c")
            except Exception:
                pass

            agent_cell = Text("—", style="#636e7b")
            try:
                path_real = _os.path.realpath(path.rstrip("/"))
            except Exception:
                path_real = path.rstrip("/")
            matched = []
            for session in self._sessions:
                if not session.cwd:
                    continue
                try:
                    session_real = _os.path.realpath(session.cwd.rstrip("/"))
                except Exception:
                    session_real = session.cwd.rstrip("/")
                if session_real == path_real:
                    matched.append(session)
            if len(matched) == 1:
                session = matched[0]
                role_label, _ = session.role_rich
                agent_cell = Text(
                    f"⚡ {session.harness_label}:{role_label.strip()}",
                    style="bold #57c4f8",
                )
            elif len(matched) > 1:
                agent_cell = Text(f"⚡ ×{len(matched)}", style="bold #57c4f8")

            sync_cell = Text("─", style="#444c56")
            sync_raw = _cached_git(
                f"wt:sync-divergence:{path}",
                ["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                cwd=path,
                timeout=3,
            )
            if sync_raw:
                parts = sync_raw.strip().split()
                if len(parts) == 2:
                    ahead, behind = parts
                    if ahead != "0" or behind != "0":
                        sync_cell = Text(f"↑{ahead} ↓{behind}", style="#adbac7")

            age_cell = Text("—", style="#636e7b")
            if last_ct:
                delta = _t.time() - last_ct
                if delta < 3600:
                    age_cell = Text(f"{int(delta / 60)}m", style="#57ab5a")
                elif delta < 86400:
                    age_cell = Text(f"{int(delta / 3600)}h", style="#adbac7")
                else:
                    age_cell = Text(f"{int(delta / 86400)}d", style="#636e7b")

            notes_cell = Text("", style="#636e7b")
            try:
                slug = branch.replace("/", "-").replace(" ", "-")
                notes_path = _os.path.join(
                    repo_root,
                    ".git",
                    "wtree-notes",
                    f"{slug}.txt",
                )
                if _os.path.exists(notes_path):
                    with open(notes_path, encoding="utf-8", errors="replace") as file:
                        first_line = file.readline().strip()
                    if first_line:
                        notes_cell = Text(first_line[:18], style="#adbac7")
            except Exception:
                pass

            rows.append(
                (
                    path,
                    marker,
                    branch_cell,
                    status_cell,
                    agent_cell,
                    sync_cell,
                    age_cell,
                    notes_cell,
                )
            )

        self.app.call_from_thread(self._populate_table, rows)

    def _populate_table(self, rows: list[tuple]) -> None:
        table = self.query_one("#wt-table", DataTable)
        table.clear()
        self._ordered_paths = []
        for (
            path,
            marker,
            branch_cell,
            status_cell,
            agent_cell,
            sync_cell,
            age_cell,
            notes_cell,
        ) in rows:
            table.add_row(
                marker,
                branch_cell,
                status_cell,
                agent_cell,
                sync_cell,
                age_cell,
                notes_cell,
                key=path,
            )
            self._ordered_paths.append(path)
        if self._preselect_path and self._preselect_path in self._ordered_paths:
            idx = self._ordered_paths.index(self._preselect_path)
            try:
                table.move_cursor(row=idx)
            except Exception:
                pass

    def _current_path(self) -> Optional[str]:
        try:
            table = self.query_one("#wt-table", DataTable)
            idx = table.cursor_row
            if 0 <= idx < len(self._ordered_paths):
                return self._ordered_paths[idx]
        except Exception:
            pass
        return None

    def action_move_up(self) -> None:
        try:
            table = self.query_one("#wt-table", DataTable)
            target = max(0, table.cursor_row - 1)
            table.move_cursor(row=target)
        except Exception:
            pass

    def action_move_down(self) -> None:
        try:
            table = self.query_one("#wt-table", DataTable)
            max_row = max(0, len(self._ordered_paths) - 1)
            target = min(max_row, table.cursor_row + 1)
            table.move_cursor(row=target)
        except Exception:
            pass

    def action_jump_worktree(self) -> None:
        path = self._current_path()
        if not path:
            return
        import shlex

        current_tmux = self._tmux.get_current_session() or ""
        try:
            self._tmux.new_window(
                f"cd {shlex.quote(path)} && exec ${{SHELL:-bash}}",
                session=current_tmux,
                name="worktree",
            )
            self.notify(f"Opened shell in {path}")
        except Exception as exc:
            self.notify(f"Jump failed: {exc}", severity="error")

    def action_delete_worktree(self) -> None:
        path = self._current_path()
        if not path:
            return
        import subprocess

        try:
            subprocess.run(
                ["git", "worktree", "remove", "--force", path],
                timeout=10,
                check=True,
            )
            self.notify(f"Removed worktree: {path}")
            self._load_worktrees()
        except Exception as exc:
            self.notify(f"Delete failed: {exc}", severity="error")

    def action_sync_worktree(self) -> None:
        path = self._current_path()
        if not path:
            return
        import subprocess

        try:
            subprocess.run(["git", "fetch"], cwd=path, timeout=30)
            self.notify("Fetched")
            self._load_worktrees()
        except Exception as exc:
            self.notify(f"Fetch failed: {exc}", severity="error")

    def action_fetch_log(self) -> None:
        path = self._current_path()
        if not path:
            return
        import subprocess

        try:
            result = subprocess.run(
                ["git", "log", "--oneline", "-10"],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=5,
            )
            try:
                self.query_one("#wt-status-bar", Static).update(result.stdout[:200])
            except Exception:
                pass
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def action_spawn_agent(self) -> None:
        path = self._current_path()
        if not path:
            return
        import shlex

        current_tmux = self._tmux.get_current_session() or ""
        try:
            self._tmux.new_window(
                f"cd {shlex.quote(path)} && omp",
                session=current_tmux,
                name="omp",
            )
            self.notify(f"Spawned OMP session in {path}")
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def action_new_wizard(self) -> None:
        """Start the 3-step new worktree wizard."""
        self._wizard_step = 1
        self._wiz_branch = ""
        self._wiz_base = "main"
        self._wiz_fetch = False
        self._wiz_spawn = True
        self._wiz_harness = "omp"
        self._wiz_role = "default"
        self._wiz_task = ""
        self._show_wizard_step()

    def _wizard_repo_root(self) -> str:
        return self._scope_root if self._scope_root != "/" else os.getcwd()

    def _wizard_worktree_path(self) -> tuple[str, str]:
        repo_root = self._wizard_repo_root()
        proj_name = os.path.basename(repo_root)
        parent = os.path.dirname(repo_root)
        wt_base = os.path.join(parent, f"{proj_name}-worktrees")
        slug = self._wiz_branch.replace("/", "-")
        return wt_base, os.path.join(wt_base, slug)

    def _wizard_base_head(self) -> str:
        import subprocess

        repo_root = self._wizard_repo_root()
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--short", self._wiz_base],
                cwd=repo_root,
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
            )
            return result.stdout.strip() or "unknown"
        except Exception:
            return "unknown"

    def _show_wizard_step(self) -> None:
        try:
            wizard = self.query_one("#wt-wizard")
            header = self.query_one("#wt-wizard-header", Static)
            inp = self.query_one("#wt-wizard-input", Input)
            info = self.query_one("#wt-wizard-info", Static)
        except Exception:
            return

        wizard.remove_class("hidden")
        if self._wizard_step == 1:
            header.update(
                "Step 1/3 ── New Worktree ── Branch name (Enter to next, Esc to cancel):"
            )
            inp.placeholder = "feature/new-thing"
            inp.value = self._wiz_branch
            info.update(
                f"Base: {self._wiz_base} | Fetch before branch: "
                f"{'yes' if self._wiz_fetch else 'no'} (Tab toggles)"
            )
            inp.focus()
        elif self._wizard_step == 2:
            header.update(
                "Step 2/3 ── Agent Setup ── Task description (Enter to next, Esc to cancel):"
            )
            inp.placeholder = "Implement the new feature..."
            inp.value = self._wiz_task
            info.update(
                f"Harness: {self._wiz_harness} | Role: {self._wiz_role} | "
                f"Spawn: {'yes' if self._wiz_spawn else 'no'} (Tab toggles)"
            )
            inp.focus()
        elif self._wizard_step == 3:
            _, wt_path = self._wizard_worktree_path()
            base_head = self._wizard_base_head()
            header.update("Step 3/3 ── Confirm ── Press Enter to create, Esc to cancel")
            inp.placeholder = "(press Enter to confirm)"
            inp.value = ""
            info.update(
                f"Path: {wt_path}\n"
                f"Branch: {self._wiz_branch} from {self._wiz_base} @ {base_head} "
                + (f"| Task: {self._wiz_task[:40]}" if self._wiz_task else "| No agent")
            )
            inp.focus()

    def _show_copy_step(self) -> None:
        try:
            wizard = self.query_one("#wt-wizard")
            header = self.query_one("#wt-wizard-header", Static)
            inp = self.query_one("#wt-wizard-input", Input)
            info = self.query_one("#wt-wizard-info", Static)
        except Exception:
            return

        wizard.remove_class("hidden")
        header.update(
            "Copy Worktree ── New branch name (Enter to confirm, Esc to cancel):"
        )
        inp.placeholder = self._wiz_branch
        inp.value = self._wiz_branch
        info.update(
            f"Source: {getattr(self, '_copy_src_branch', '')} | "
            "New worktree will branch from its HEAD"
        )
        inp.focus()

    def _execute_copy_worktree(self, new_branch: str) -> None:
        import os as _os
        import subprocess

        src_path = getattr(self, "_copy_src_path", "")
        if not src_path or not new_branch:
            self.notify("Copy cancelled")
            return
        repo_root = self._scope_root if self._scope_root != "/" else _os.getcwd()
        proj_name = _os.path.basename(repo_root)
        parent = _os.path.dirname(repo_root)
        wt_base = _os.path.join(parent, f"{proj_name}-worktrees")
        slug = new_branch.replace("/", "-")
        new_path = _os.path.join(wt_base, slug)
        _os.makedirs(wt_base, exist_ok=True)
        try:
            src_head_result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=src_path,
                capture_output=True,
                text=True,
                check=True,
                timeout=5,
            )
            src_head = src_head_result.stdout.strip()
            if not src_head:
                raise RuntimeError("Cannot determine source HEAD")
            subprocess.run(
                ["git", "worktree", "add", "-b", new_branch, new_path, src_head],
                cwd=repo_root,
                check=True,
                timeout=30,
            )
            self.notify(f"Copied to {new_path}")
        except Exception as e:
            self.notify(f"Copy failed: {e}", severity="error")
        self._load_worktrees()

    def _cancel_wizard(self) -> None:
        self._wizard_step = 0
        try:
            self.query_one("#wt-wizard").add_class("hidden")
            self.query_one("#wt-table", DataTable).focus()
        except Exception:
            pass

    def _wizard_confirm(self) -> None:
        """Execute worktree creation on step 3 Enter."""
        import subprocess

        repo_root = self._wizard_repo_root()
        wt_base, wt_path = self._wizard_worktree_path()
        if not self._wiz_branch:
            self.notify("Branch name is required", severity="error")
            self._wizard_step = 1
            self._show_wizard_step()
            return
        os.makedirs(wt_base, exist_ok=True)
        try:
            if self._wiz_fetch:
                subprocess.run(
                    ["git", "fetch", "origin"],
                    cwd=repo_root,
                    check=True,
                    timeout=30,
                )
            subprocess.run(
                [
                    "git",
                    "worktree",
                    "add",
                    "-b",
                    self._wiz_branch,
                    wt_path,
                    self._wiz_base,
                ],
                cwd=repo_root,
                check=True,
                timeout=30,
            )
            self.notify(f"Created worktree: {wt_path}")
            if self._wiz_spawn and self._wiz_task:
                current = self._tmux.get_current_session() or ""
                actions.create_session(self._tmux, current, harness=self._wiz_harness)
        except Exception as exc:
            self.notify(f"Wizard error: {exc}", severity="error")
        self._cancel_wizard()
        self._load_worktrees()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "wt-wizard-input":
            return
        val = event.value.strip()
        if self._wizard_step == 1:
            if not val:
                self.notify("Branch name is required", severity="error")
                self._show_wizard_step()
                return
            self._wiz_branch = val
            self._wizard_step = 2
            self._show_wizard_step()
        elif self._wizard_step == 2:
            self._wiz_task = val
            self._wizard_step = 3
            self._show_wizard_step()
        elif self._wizard_step == 3:
            self._wizard_confirm()
        elif self._wizard_step == 10:
            new_branch = val or self._wiz_branch
            self._wizard_step = 0
            try:
                self.query_one("#wt-wizard").add_class("hidden")
            except Exception:
                pass
            self._execute_copy_worktree(new_branch)
        elif self._wizard_step == 20:
            self._wizard_step = 0
            try:
                self.query_one("#wt-wizard").add_class("hidden")
                self.query_one("#wt-table", DataTable).focus()
            except Exception:
                pass
            self._save_worktree_note(getattr(self, "_note_path", ""), val)
            self._load_worktrees()

    def on_key(self, event) -> None:
        if self._wizard_step > 0 and event.key == "escape":
            self._cancel_wizard()
            event.stop()
            return
        if self._wizard_step == 1 and event.key == "tab":
            self._wiz_fetch = not self._wiz_fetch
            self._show_wizard_step()
            event.stop()
            return
        if self._wizard_step == 2 and event.key == "tab":
            self._wiz_spawn = not self._wiz_spawn
            self._show_wizard_step()
            event.stop()

    def action_prune_wizard(self) -> None:
        import os as _os

        def _reload_after_prune(_: object | None) -> None:
            self._load_worktrees()
            return None

        repo_root = self._scope_root if self._scope_root != "/" else _os.getcwd()
        worktrees = _parse_worktrees(repo_root)
        self.app.push_screen(
            PruneScreen(
                worktrees=worktrees, sessions=self._sessions, repo_root=repo_root
            ),
            callback=_reload_after_prune,
        )

    def action_copy_worktree(self) -> None:
        """Copy the selected worktree to a new branch (A/B clone)."""
        path = self._current_path()
        if not path:
            self.notify("No worktree selected")
            return
        import os as _os

        repo_root = self._scope_root if self._scope_root != "/" else _os.getcwd()
        worktrees = _parse_worktrees(repo_root)
        current_wt = next((w for w in worktrees if w["path"] == path), None)
        if not current_wt:
            self.notify("Cannot determine current worktree")
            return
        src_branch = current_wt.get("branch", "")
        suggested = f"{src_branch}-v2" if src_branch else "copy-v2"
        self._wiz_branch = suggested
        self._wiz_base = path
        self._wiz_spawn = False
        self._copy_src_path = path
        self._copy_src_branch = src_branch
        self._wizard_step = 10
        self._show_copy_step()

    def action_edit_note(self) -> None:
        """Open inline input to edit the note for the selected worktree."""
        path = self._current_path()
        if not path:
            self.notify("No worktree selected")
            return
        import os as _os

        repo_root = self._scope_root if self._scope_root != "/" else _os.getcwd()
        worktrees = _parse_worktrees(repo_root)
        wt = next((w for w in worktrees if w["path"] == path), None)
        branch = wt.get("branch", "") if wt else ""
        slug = branch.replace("/", "-").replace(" ", "-")
        notes_path = _os.path.join(repo_root, ".git", "wtree-notes", f"{slug}.txt")

        current_note = ""
        try:
            if _os.path.exists(notes_path):
                with open(notes_path, encoding="utf-8", errors="replace") as file:
                    current_note = file.readline().strip()
        except Exception:
            pass

        self._note_path = notes_path
        self._note_row_path = path
        self._wizard_step = 20
        try:
            wizard = self.query_one("#wt-wizard")
            header = self.query_one("#wt-wizard-header", Static)
            inp = self.query_one("#wt-wizard-input", Input)
            info = self.query_one("#wt-wizard-info", Static)
        except Exception:
            return
        wizard.remove_class("hidden")
        header.update(f"Edit note for: {branch} (Enter to save, Esc to cancel)")
        inp.placeholder = "One-line note..."
        inp.value = current_note
        info.update(f"Stored at: {notes_path}")
        inp.focus()

    def _save_worktree_note(self, notes_path: str, note: str) -> None:
        if not notes_path:
            return
        import os as _os

        try:
            _os.makedirs(_os.path.dirname(notes_path), exist_ok=True)
            note = note.strip()[:80]
            if note:
                with open(notes_path, "w", encoding="utf-8") as file:
                    file.write(note + "\n")
                self.notify("Note saved")
            else:
                if _os.path.exists(notes_path):
                    _os.remove(notes_path)
                self.notify("Note cleared")
        except Exception as exc:
            self.notify(f"Failed to save note: {exc}", severity="error")

    def action_jump_to_sessions(self) -> None:
        self.dismiss(self._current_path())


class SpawnScreen(Screen):
    """New Agent Session spawn dialog overlay."""

    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
    ]

    CSS = """
    SpawnScreen {
        align: center middle;
        background: #22272e80;
    }
    SpawnScreen > Vertical#spawn-dialog {
        width: 70;
        height: auto;
        background: #2d333b;
        border: round #316dca;
        padding: 1 2;
    }
    SpawnScreen Static.spawn-label {
        color: #636e7b;
        height: 1;
    }
    SpawnScreen Input.spawn-field {
        border: solid #444c56;
        background: #22272e;
        color: #adbac7;
        height: 3;
        margin-bottom: 1;
    }
    SpawnScreen Input.spawn-field:focus {
        border: solid #316dca;
    }
    """

    def __init__(
        self,
        tmux: TmuxClient,
        scope_root: str,
        prefill_branch: str = "",
        prefill: dict | None = None,
    ) -> None:
        super().__init__()
        self._tmux = tmux
        self._scope_root = scope_root
        self._prefill_branch = prefill_branch
        self._prefill = dict(prefill or {})

    def compose(self) -> ComposeResult:
        import os as _os

        project = (
            _os.path.basename(self._scope_root) if self._scope_root != "/" else "(all)"
        )
        with Vertical(id="spawn-dialog"):
            yield Static("[▶] New Agent Session", classes="spawn-label")
            yield Static(f"Project: {project}", classes="spawn-label")
            yield Static("Harness:", classes="spawn-label")
            yield Input(
                id="spawn-harness",
                value="omp",
                placeholder="omp / claude / codex / opencode",
                classes="spawn-field",
            )
            yield Static("Branch:", classes="spawn-label")
            yield Input(
                id="spawn-branch",
                value=self._prefill_branch,
                placeholder="feature/new-thing",
                classes="spawn-field",
            )
            yield Static("Role:", classes="spawn-label")
            yield Input(
                id="spawn-role",
                value="default",
                placeholder="default / orchestrator",
                classes="spawn-field",
            )
            yield Static("Task:", classes="spawn-label")
            yield Input(
                id="spawn-task",
                value="",
                placeholder="Describe the task for the agent...",
                classes="spawn-field",
            )
            yield Static(
                "[Tab to Task then Enter] Launch  [Esc] Cancel", classes="spawn-label"
            )

    def on_mount(self) -> None:
        defaults = {
            "harness": "omp",
            "branch": self._prefill_branch,
            "role": "default",
            "task": "",
        }
        for key, default in defaults.items():
            value = self._prefill.get(key, default)
            if value is None:
                value = default
            elif not isinstance(value, str):
                value = str(value)
            try:
                self.query_one(f"#spawn-{key}", Input).value = value
            except Exception:
                pass

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "spawn-task":
            self.action_launch()

    def action_launch(self) -> None:
        try:
            harness = self.query_one("#spawn-harness", Input).value.strip() or "omp"
            current = self._tmux.get_current_session() or ""
            actions.create_session(self._tmux, current, harness=harness)
            self.notify(f"Launched {harness} session")
        except Exception as exc:
            self.notify(str(exc), severity="error")
        self.dismiss(True)


class ArchiveScreen(Screen):
    """Read-only view of archived sessions with resume support."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("r", "resume_session", "Resume"),
        Binding("/", "toggle_filter", "Filter"),
        Binding("up", "move_up", "", show=False, priority=True),
        Binding("down", "move_down", "", show=False, priority=True),
    ]

    CSS = """
    ArchiveScreen { background: #22272e; }
    ArchiveScreen DataTable { height: 1fr; background: #22272e; }
    ArchiveScreen Input#archive-filter {
        display: none;
        height: 3;
        background: #2d333b;
        border: solid #316dca;
        color: #adbac7;
        margin: 0 1;
    }
    ArchiveScreen Input#archive-filter.visible {
        display: block;
    }
    """

    def __init__(self, tmux: TmuxClient) -> None:
        super().__init__()
        self._tmux = tmux
        self._entries: list[dict] = []
        self._filter_text: str = ""
        self._filter_visible: bool = False
        self._ordered_ids: list[str] = []

    def compose(self) -> ComposeResult:
        yield Header()
        yield Input(id="archive-filter", placeholder="Filter archived sessions…")
        yield DataTable(id="archive-table", cursor_type="row", show_cursor=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#archive-table", DataTable)
        table.add_column("STATUS", width=8, key="status")
        table.add_column("HARNESS", width=8, key="harness")
        table.add_column("ROLE", width=7, key="role")
        table.add_column("SESSION", width=36, key="session")
        table.add_column("BRANCH", width=22, key="branch")
        table.add_column("AGE", width=8, key="age")
        self._load_archive()

    def _load_archive(self) -> None:
        archive_path = os.path.expanduser("~/.omp/agent/session_archive.json")
        try:
            with open(archive_path, "r", encoding="utf-8") as f:
                self._entries = json.load(f)
        except FileNotFoundError:
            self._entries = []
        except Exception:
            self._entries = []

        if not isinstance(self._entries, list):
            self._entries = []

        def _ended_ts(entry: object) -> float:
            if not isinstance(entry, dict):
                return 0.0
            try:
                return float(entry.get("ended_ts") or 0.0)
            except (TypeError, ValueError):
                return 0.0

        self._entries.sort(key=_ended_ts, reverse=True)
        self._update_archive_table()

    def _update_archive_table(self) -> None:
        import time as _time

        table = self.query_one("#archive-table", DataTable)
        table.clear()
        self._ordered_ids = []
        ft = self._filter_text.lower()
        now = _time.time()
        seen_ids: set[str] = set()
        for entry in self._entries:
            if not isinstance(entry, dict):
                continue
            title = str(entry.get("title", ""))
            session_id = str(entry.get("session_id", ""))
            harness = str(entry.get("harness", ""))
            cwd = str(entry.get("cwd", ""))
            searchable = (title + cwd + harness).lower()
            if ft and ft not in searchable:
                continue
            if not session_id or session_id in seen_ids:
                continue

            status = Text(
                str(entry.get("final_status", "offline"))[:7], style="#636e7b"
            )
            harness_cell = Text(harness[:7], style="#636e7b")
            role = Text(str(entry.get("role") or "")[:5], style="#636e7b")
            title_cell = Text(title[:35] if title else session_id[:16], style="#636e7b")
            branch_cell = Text(
                str(entry.get("branch") or "")[:21], style="italic #636e7b"
            )

            age_str = "?"
            ts_raw = entry.get("ended_ts")
            if ts_raw is not None:
                try:
                    ts = float(ts_raw)
                    delta = max(0.0, now - ts)
                    if delta < 3600:
                        age_str = f"{int(delta / 60)}m"
                    elif delta < 86400:
                        age_str = f"{int(delta / 3600)}h"
                    else:
                        age_str = f"{int(delta / 86400)}d"
                except (TypeError, ValueError):
                    age_str = "?"
            age_cell = Text(age_str, style="#636e7b")

            table.add_row(
                status,
                harness_cell,
                role,
                title_cell,
                branch_cell,
                age_cell,
                key=session_id,
            )
            self._ordered_ids.append(session_id)
            seen_ids.add(session_id)

    def _current_entry(self) -> Optional[dict]:
        try:
            idx = self.query_one("#archive-table", DataTable).cursor_row
            if 0 <= idx < len(self._ordered_ids):
                session_id = self._ordered_ids[idx]
                return next(
                    (
                        entry
                        for entry in self._entries
                        if isinstance(entry, dict)
                        and entry.get("session_id") == session_id
                    ),
                    None,
                )
        except Exception:
            pass
        return None

    def action_resume_session(self) -> None:
        entry = self._current_entry()
        if not entry:
            return
        session_id = str(entry.get("session_id", ""))
        if not session_id:
            return

        sessions_root = Path("~/.omp/agent/sessions").expanduser()
        session_path = next(
            (
                str(path)
                for path in sessions_root.glob(f"**/*_{session_id}.jsonl")
                if path.is_file()
            ),
            None,
        )
        if not session_path:
            session_path = next(
                (
                    str(path)
                    for path in sessions_root.glob(f"**/*{session_id}*.jsonl")
                    if path.is_file()
                ),
                None,
            )
        if not session_path:
            self.notify("Session file not found for resume")
            return

        session = AgentSession(
            harness=str(entry.get("harness", "omp")),
            session_id=session_id,
            title=str(entry.get("title", "")),
            cwd=str(entry.get("cwd", "")),
            state="inactive",
            resume_command=f"omp --session '{session_path}'",
        )
        current = self._tmux.get_current_session() or ""
        try:
            actions.resume(self._tmux, session, current)
        except Exception as err:
            self.notify(str(err), severity="error")

    def action_toggle_filter(self) -> None:
        fi = self.query_one("#archive-filter", Input)
        if self._filter_visible:
            self._filter_visible = False
            fi.remove_class("visible")
            self._filter_text = ""
            fi.value = ""
            try:
                self.query_one("#archive-table", DataTable).focus()
            except Exception:
                pass
            self._update_archive_table()
        else:
            self._filter_visible = True
            fi.add_class("visible")
            fi.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "archive-filter":
            self._filter_text = event.value
            self._update_archive_table()

    def action_move_up(self) -> None:
        try:
            table = self.query_one("#archive-table", DataTable)
            table.move_cursor(row=max(0, table.cursor_row - 1))
        except Exception:
            pass

    def action_move_down(self) -> None:
        try:
            table = self.query_one("#archive-table", DataTable)
            max_row = max(0, len(self._ordered_ids) - 1)
            table.move_cursor(row=min(max_row, table.cursor_row + 1))
        except Exception:
            pass


class ResourceBar(Widget):
    """Status bar aggregating session counts, tokens, and uptime."""

    DEFAULT_CSS = """
    ResourceBar {
        height: 1;
        background: #161b22;
        padding: 0 1;
        color: #636e7b;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self._active: int = 0
        self._stalled: int = 0
        self._done: int = 0
        self._uptime_start: float = __import__("time").time()
        self._follow_mode: bool = False
        self._pivot_mode: bool = False

    def update_stats(
        self,
        sessions: list["AgentSession"],
        follow_mode: Optional[bool] = None,
        pivot_mode: Optional[bool] = None,
    ) -> None:
        self._active = sum(
            1
            for s in sessions
            if s.state == "active"
            and s.status not in ("stalled", "delegating", "offline", "inactive")
        )
        self._stalled = sum(1 for s in sessions if s.status == "stalled")
        self._done = sum(1 for s in sessions if s.state == "inactive")
        if follow_mode is not None:
            self._follow_mode = follow_mode
        if pivot_mode is not None:
            self._pivot_mode = pivot_mode
        self.refresh()

    def set_follow_mode(self, enabled: bool) -> None:
        self._follow_mode = enabled
        self.refresh()

    def set_pivot_mode(self, enabled: bool) -> None:
        self._pivot_mode = enabled
        self.refresh()

    def render(self) -> Text:
        import time as _t

        elapsed = int(_t.time() - self._uptime_start)
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        uptime = f"{h:02d}:{m:02d}:{s:02d}"
        parts = [
            (f" ⚡ {self._active} active", "#3fb950" if self._active else "#636e7b"),
            ("  ", "#636e7b"),
            (f"? {self._stalled} stalled", "#f0883e" if self._stalled else "#636e7b"),
            ("  ", "#636e7b"),
            (f"✓ {self._done} done", "#636e7b"),
            ("  ", "#636e7b"),
            (f"⏱ {uptime}", "#636e7b"),
        ]
        if self._follow_mode:
            parts.extend([("  │ ", "#636e7b"), ("◉ FOLLOW", "#d4a72c")])
        parts.extend(
            [
                ("  │ ", "#636e7b"),
                (
                    "📊 PIVOT" if self._pivot_mode else "🗂 PROJECTS",
                    "#6cb6ff" if self._pivot_mode else "#8b949e",
                ),
            ]
        )
        t = Text()
        for text, style in parts:
            t.append(text, style=style)
        return t


class RecoveryLogScreen(Screen):
    """Viewer for ~/.omp/agent/recovery_log.jsonl."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("/", "toggle_filter", "Filter"),
        Binding("c", "clear_log", "Clear log"),
        Binding("up", "move_up", "", show=False, priority=True),
        Binding("down", "move_down", "", show=False, priority=True),
    ]

    CSS = """
    RecoveryLogScreen { background: #22272e; }
    RecoveryLogScreen Static#recovery-summary {
        height: auto;
        background: #1c2128;
        border: round #30363d;
        padding: 1 2;
        margin: 0 1;
        color: #adbac7;
    }
    RecoveryLogScreen Input#recovery-filter {
        display: none;
        height: 3;
        background: #2d333b;
        border: solid #316dca;
        color: #adbac7;
        margin: 0 1;
    }
    RecoveryLogScreen Input#recovery-filter.visible {
        display: block;
    }
    RecoveryLogScreen DataTable { height: 1fr; background: #22272e; }
    """

    def __init__(self) -> None:
        super().__init__()
        self._entries: list[dict] = []
        self._filter_text: str = ""
        self._filter_visible: bool = False
        self._clear_confirm_pending: bool = False
        self._malformed_count: int = 0

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("", id="recovery-summary")
        yield Input(id="recovery-filter", placeholder="Filter by title or pattern…")
        yield DataTable(id="recovery-table", cursor_type="row", show_cursor=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#recovery-table", DataTable)
        table.add_column("TIME", width=12, key="ts")
        table.add_column("SESSION", width=16, key="session")
        table.add_column("TITLE", width=28, key="title")
        table.add_column("PATTERN", width=18, key="pattern")
        table.add_column("ACTION", width=14, key="action")
        table.add_column("AUTO", width=8, key="auto")
        self._load_entries()

    def _entry_ts(self, entry: dict) -> float:
        try:
            return float(entry.get("ts") or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def _update_summary(self) -> None:
        summary = self.query_one("#recovery-summary", Static)
        if not self._entries:
            if self._malformed_count:
                summary.update(
                    Text(
                        f"No recovery events logged (ignored {self._malformed_count} malformed lines)",
                        style="#636e7b",
                    )
                )
            else:
                summary.update(Text("No recovery events logged", style="#636e7b"))
            return
        summary.update(self._load_recovery_stats(self._entries))

    def _refresh_table(self) -> None:
        import datetime as _dt

        table = self.query_one("#recovery-table", DataTable)
        table.clear()

        ft = self._filter_text.strip().lower()
        pattern_colors = {
            "stdin_waiting": "#f0883e",
            "agent_asking": "#d4a72c",
            "unknown": "#f85149",
        }

        for entry in self._entries:
            title = str(entry.get("title") or "")
            pattern = str(entry.get("pattern") or "unknown")
            searchable = (title + " " + pattern).lower()
            if ft and ft not in searchable:
                continue

            ts = self._entry_ts(entry)
            try:
                ts_str = _dt.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M:%S")
            except Exception:
                ts_str = str(entry.get("ts", ""))[:12]

            session_id = str(entry.get("session_id") or "")
            action = str(entry.get("action") or "")
            auto = bool(entry.get("auto"))
            auto_label = "auto" if auto else "manual"
            auto_style = "#3fb950" if auto else "#f0883e"

            table.add_row(
                Text(ts_str, style="#636e7b"),
                Text(session_id[:15], style="#768390"),
                Text((title or session_id)[:27], style="#adbac7"),
                Text(pattern[:17], style=pattern_colors.get(pattern, "#adbac7")),
                Text(action[:13], style="#636e7b"),
                Text(auto_label, style=auto_style),
            )

        if ft and table.row_count == 0:
            table.add_row(
                Text("", style="#636e7b"),
                Text("", style="#636e7b"),
                Text("No matching recovery events", style="#636e7b"),
                Text("", style="#636e7b"),
                Text("", style="#636e7b"),
                Text("", style="#636e7b"),
            )

    def _load_entries(self) -> None:
        import json as _json

        table = self.query_one("#recovery-table", DataTable)
        table.clear()
        self._entries = []
        self._malformed_count = 0
        self._clear_confirm_pending = False

        if not _RECOVERY_LOG.exists():
            self.query_one("#recovery-summary", Static).update(
                Text("No recovery log found", style="#636e7b")
            )
            return

        try:
            lines = _RECOVERY_LOG.read_text(encoding="utf-8").splitlines()
        except Exception as exc:
            self.query_one("#recovery-summary", Static).update(
                Text("No recovery events logged", style="#636e7b")
            )
            self.notify(f"Failed to read recovery log: {exc}", severity="error")
            return

        entries: list[dict] = []
        for line in lines:
            if not line.strip():
                continue
            try:
                parsed = _json.loads(line)
                if isinstance(parsed, dict):
                    entries.append(parsed)
                else:
                    self._malformed_count += 1
            except Exception:
                self._malformed_count += 1

        entries.sort(key=self._entry_ts, reverse=True)
        self._entries = entries
        self._update_summary()
        self._refresh_table()

    def _load_recovery_stats(self, log_entries: list[dict]) -> Text:
        import time as _time
        from collections import Counter

        now = _time.time()
        total = len(log_entries)
        last_hour = sum(
            1 for entry in log_entries if now - self._entry_ts(entry) <= 3600
        )
        last_day = sum(
            1 for entry in log_entries if now - self._entry_ts(entry) <= 86400
        )

        auto_count = sum(1 for entry in log_entries if bool(entry.get("auto")))
        manual_count = max(0, total - auto_count)
        auto_pct = int(round((auto_count / total) * 100)) if total else 0
        manual_pct = 100 - auto_pct if total else 0

        pattern_counts = Counter(
            str(entry.get("pattern") or "unknown") for entry in log_entries
        )
        top_patterns = pattern_counts.most_common(3)
        most_common_pattern = top_patterns[0][0] if top_patterns else "unknown"

        def _bar(count: int, whole: int, width: int = 16) -> str:
            if whole <= 0:
                return "░" * width
            filled = (
                max(1, min(width, int(round((count / whole) * width)))) if count else 0
            )
            return "█" * filled + "░" * (width - filled)

        stats = Text()
        stats.append("Recovery Log Analysis\n", style="bold #adbac7")
        stats.append("─" * 29 + "\n", style="#636e7b")
        stats.append(
            f"Total events: {total:4d}  │  Last 24h: {last_day:3d}  │  Last 1h: {last_hour:3d}\n",
            style="#adbac7",
        )
        stats.append(
            f"Auto-recovery: {auto_count:3d} ({auto_pct:2d}%)  │  Manual: {manual_count:3d} ({manual_pct:2d}%)\n",
            style="#adbac7",
        )
        stats.append(
            f"Most common pattern: {most_common_pattern}\n",
            style="#768390",
        )
        stats.append("\nTop patterns:\n", style="bold #adbac7")

        for pattern, count in top_patterns:
            pct = int(round((count / total) * 100)) if total else 0
            stats.append(
                f"  {pattern[:14]:<14} {_bar(count, total)}  {count:2d} ({pct:2d}%)\n",
                style="#adbac7",
            )

        if self._malformed_count:
            stats.append(
                f"\nIgnored malformed lines: {self._malformed_count}",
                style="#f0883e",
            )

        return stats

    def action_toggle_filter(self) -> None:
        fi = self.query_one("#recovery-filter", Input)
        self._clear_confirm_pending = False
        if self._filter_visible:
            self._filter_visible = False
            fi.remove_class("visible")
            self._filter_text = ""
            fi.value = ""
            try:
                self.query_one("#recovery-table", DataTable).focus()
            except Exception:
                pass
            self._refresh_table()
            return

        self._filter_visible = True
        fi.add_class("visible")
        fi.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "recovery-filter":
            self._clear_confirm_pending = False
            self._filter_text = event.value
            self._refresh_table()

    def action_clear_log(self) -> None:
        if not self._clear_confirm_pending:
            self._clear_confirm_pending = True
            self.notify("Press c again to confirm clear")
            return

        self._clear_confirm_pending = False
        try:
            _RECOVERY_LOG.parent.mkdir(parents=True, exist_ok=True)
            _RECOVERY_LOG.write_text("", encoding="utf-8")
        except Exception as exc:
            self.notify(f"Failed to clear recovery log: {exc}", severity="error")
            return

        self.notify("Recovery log cleared")
        self._load_entries()

    def action_move_up(self) -> None:
        try:
            table = self.query_one("#recovery-table", DataTable)
            table.move_cursor(row=max(0, table.cursor_row - 1))
        except Exception:
            pass

    def action_move_down(self) -> None:
        try:
            table = self.query_one("#recovery-table", DataTable)
            max_row = max(0, table.row_count - 1)
            table.move_cursor(row=min(max_row, table.cursor_row + 1))
        except Exception:
            pass


class SessionCompareScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
    ]

    CSS = """
    SessionCompareScreen { background: #22272e; }
    SessionCompareScreen #compare-content { height: 1fr; }
    SessionCompareScreen #pane-a, SessionCompareScreen #pane-b {
        width: 1fr;
        height: 1fr;
    }
    SessionCompareScreen #compare-divider {
        width: 1;
        color: #636e7b;
        content-align: center middle;
    }
    """

    def __init__(
        self, session_a: AgentSession | None, session_b: AgentSession | None
    ) -> None:
        super().__init__()
        self._session_a = session_a
        self._session_b = session_b

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="compare-content"):
            yield ScrollableContainer(Static(id="compare-a"), id="pane-a")
            yield Static("│", id="compare-divider")
            yield ScrollableContainer(Static(id="compare-b"), id="pane-b")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#compare-a", Static).update(
            self._render_session_card(self._session_a)
        )
        self.query_one("#compare-b", Static).update(
            self._render_session_card(self._session_b)
        )

    def _render_session_card(self, session: AgentSession | None) -> Text:
        text = Text()

        def section(title: str) -> None:
            text.append(f"\n{title} ", style="bold #636e7b")
            text.append("─" * max(0, 28 - len(title)), style="#2d333b")
            text.append("\n")

        if session is None:
            section("Session")
            text.append("  Unavailable\n", style="bold #f85149")
            text.append("  This session is no longer present\n", style="#636e7b")
            return text

        section("Session")
        text.append(f"  {session.display_title}\n", style="bold #cdd9e5")
        text.append(f"  ID: {session.session_id[:20]}\n", style="#636e7b")

        section("Status")
        status_text, status_style = session.status_rich
        text.append(f"  {status_text}\n", style=status_style)

        section("Info")
        text.append("  Role:    ", style="bold #636e7b")
        role_text, role_style = session.role_rich
        text.append(f"{role_text}\n", style=role_style)
        model = str(getattr(session, "model", "") or "")
        branch = str(getattr(session, "branch", "") or "")
        text.append(f"  Model:   {model[:25] or '—'}\n", style="#adbac7")
        text.append(f"  Branch:  {branch[:25] or '—'}\n", style="#adbac7")
        text.append(f"  Last:    {session.age_str}\n", style="#adbac7")
        elapsed = getattr(session, "elapsed_str", "") or "—"
        text.append(f"  Elapsed: {elapsed}\n", style="#adbac7")

        section("Context")
        context_pct = _normalize_context_usage_pct(session.context_usage_pct)
        if context_pct is None:
            ctx_str = "—"
            ctx_style = "#636e7b"
        else:
            ctx_str = f"{context_pct:.0f}%"
            ctx_style = (
                "#3fb950"
                if context_pct < 50
                else "#d4a72c"
                if context_pct < 80
                else "#f85149"
            )
        text.append(f"  {ctx_str}\n", style=ctx_style)

        section("Diff")
        text.append(f"  {session.diff_shortstat or 'no changes'}\n", style="#adbac7")

        section("Latest output")
        output_lines = [
            line.strip()
            for line in str(session.preview_text or "").splitlines()
            if line.strip()
        ]
        if not output_lines:
            text.append("  —\n", style="#636e7b")
        else:
            for line in output_lines[:6]:
                clipped = f"{line[:97]}…" if len(line) > 98 else line
                text.append(f"  {clipped}\n", style="#adbac7")

        section("Note")
        text.append(f"  {session.quick_note or '—'}\n", style="#636e7b")

        return text


class GraphScreen(Screen):
    """Orchestrator → subagent tree view."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("enter", "jump_to_session", "Jump"),
    ]

    CSS = """
    GraphScreen { background: #22272e; }
    GraphScreen Tree { height: 1fr; background: #22272e; color: #adbac7; }
    """

    def __init__(
        self,
        sessions: list[AgentSession],
        on_jump: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self._sessions = sessions
        self._on_jump = on_jump

    def compose(self) -> ComposeResult:
        yield Header()
        yield Tree("Sessions", id="graph-tree")
        yield Footer()

    def on_mount(self) -> None:
        tree = self.query_one("#graph-tree", Tree)
        tree.root.expand()
        self._build_tree(tree)

    def _completion_bar(
        self, session_id: str, session_map: dict[str, AgentSession]
    ) -> str:
        session = session_map.get(session_id)
        if not session or not session.child_session_ids:
            return ""
        total = len(session.child_session_ids)
        done = sum(
            1
            for cid in session.child_session_ids
            if session_map.get(cid) and session_map[cid].state == "inactive"
        )
        pct = int(done / total * 100) if total else 0
        filled = int(pct / 10)
        bar = "▓" * filled + "░" * (10 - filled)
        return f"  {bar} {pct}%"

    def _node_label(
        self, session: AgentSession, session_map: dict[str, AgentSession]
    ) -> str:
        glyph = "⯱" if session.role == "orchestrator" else "◈"
        title = (session.title or session.session_id[:12])[:30]
        bar = self._completion_bar(session.session_id, session_map)
        return f"{glyph} {title}{bar}"

    def _build_tree(self, tree: Tree) -> None:
        session_map = {session.session_id: session for session in self._sessions}
        roots = [
            session
            for session in self._sessions
            if session.role == "orchestrator"
            or not session.parent_session_id
            or session.parent_session_id not in session_map
        ]
        roots.sort(
            key=lambda session: (
                0 if session.role == "orchestrator" else 1,
                session.display_title,
            )
        )

        def _add_children(
            parent_node,
            session: AgentSession,
            ancestry: set[str],
        ) -> None:
            for child_id in session.child_session_ids:
                child = session_map.get(child_id)
                if not child or child_id in ancestry:
                    continue
                label = self._node_label(child, session_map)
                child_node = parent_node.add(label, data=child.session_id)
                if child.child_session_ids:
                    child_node.expand()
                    _add_children(child_node, child, ancestry | {child_id})

        for root_session in roots:
            label = self._node_label(root_session, session_map)
            node = tree.root.add(label, data=root_session.session_id)
            node.expand()
            _add_children(node, root_session, {root_session.session_id})

    def action_jump_to_session(self) -> None:
        tree = self.query_one("#graph-tree", Tree)
        cursor = tree.cursor_node
        if not cursor or not cursor.data:
            self.dismiss()
            return
        session_id = cursor.data
        self.dismiss()
        if self._on_jump:
            self._on_jump(session_id)


class BroadcastTemplateScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("enter", "select_template", "Select"),
        Binding("up", "move_up", "", show=False, priority=True),
        Binding("down", "move_down", "", show=False, priority=True),
    ]
    CSS = "BroadcastTemplateScreen { align: center middle; background: #22272e80; } BroadcastTemplateScreen > Vertical { width: 60; height: auto; max-height: 80vh; background: #2d333b; border: round #316dca; padding: 1 2; }"

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Broadcast Template — Enter to select", classes="spawn-label")
            yield DataTable(
                id="template-table",
                cursor_type="row",
                show_cursor=True,
                show_header=False,
            )

    def on_mount(self) -> None:
        table = self.query_one("#template-table", DataTable)
        table.add_column("cmd", width=55)
        for tmpl in _BROADCAST_TEMPLATES:
            table.add_row(Text(tmpl, style="#adbac7"), key=tmpl)
        table.focus()

    def action_dismiss(self) -> None:
        self.dismiss(None)

    def action_select_template(self) -> None:
        table = self.query_one("#template-table", DataTable)
        try:
            row_key = list(_BROADCAST_TEMPLATES)[table.cursor_row]
            self.dismiss(row_key)
        except Exception:
            self.dismiss(None)

    def action_move_up(self) -> None:
        table = self.query_one("#template-table", DataTable)
        table.move_cursor(row=max(0, table.cursor_row - 1))

    def action_move_down(self) -> None:
        table = self.query_one("#template-table", DataTable)
        table.move_cursor(row=min(len(_BROADCAST_TEMPLATES) - 1, table.cursor_row + 1))


class ColumnPickerScreen(Screen):
    """Toggle visibility of columns in the sessions table."""

    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("q", "dismiss", "Cancel", show=False),
        Binding("space", "toggle_column", "Toggle", show=False),
        Binding("enter", "save", "Save"),
        Binding("up", "move_up", "Up", show=False, priority=True),
        Binding("down", "move_down", "Down", show=False, priority=True),
    ]

    CSS = """
    ColumnPickerScreen { background: #22272e; }
    ColumnPickerScreen DataTable { height: 1fr; background: #22272e; }
    ColumnPickerScreen Static#column-picker-help {
        height: 1;
        background: #1c2128;
        color: #636e7b;
        padding: 0 1;
    }
    """

    def __init__(self, config: dict[str, bool]) -> None:
        super().__init__()
        self._config = dict(_COLUMN_DEFAULTS)
        for key, value in config.items():
            if key in self._config and isinstance(value, bool):
                self._config[key] = value
        for key in _LOCKED_COLUMNS:
            self._config[key] = True
        self._ordered_keys = [key for key, _, _ in _SESSION_TABLE_COLUMNS]
        self._labels = {key: label for key, label, _ in _SESSION_TABLE_COLUMNS}

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Space=toggle Enter=save Esc=cancel", id="column-picker-help")
        yield DataTable(id="column-picker-table", cursor_type="row", show_cursor=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#column-picker-table", DataTable)
        table.add_column(" ", width=4, key="sel")
        table.add_column("COLUMN", width=28, key="column")
        for key in self._ordered_keys:
            selected = self._config.get(key, True)
            locked = key in _LOCKED_COLUMNS
            marker = Text(
                "[x]" if selected else "[ ]",
                style="bold #57ab5a" if selected else "#636e7b",
            )
            label = self._labels.get(key, key.upper())
            if locked:
                label = f"{label} (required)"
            label_style = "italic #636e7b" if locked else "#adbac7"
            table.add_row(marker, Text(label, style=label_style), key=key)
        table.focus()

    def _current_column_key(self) -> Optional[str]:
        try:
            table = self.query_one("#column-picker-table", DataTable)
            idx = table.cursor_row
        except Exception:
            return None
        if 0 <= idx < len(self._ordered_keys):
            return self._ordered_keys[idx]
        return None

    def action_toggle_column(self) -> None:
        key = self._current_column_key()
        if not key:
            return
        if key in _LOCKED_COLUMNS:
            self.notify("SESSION and STATUS must stay visible", severity="warning")
            return
        visible = bool(self._config.get(key, True))
        self._config[key] = not visible
        marker = Text(
            "[x]" if self._config[key] else "[ ]",
            style="bold #57ab5a" if self._config[key] else "#636e7b",
        )
        try:
            self.query_one("#column-picker-table", DataTable).update_cell(
                key, "sel", marker, update_width=False
            )
        except Exception:
            pass

    def action_move_up(self) -> None:
        try:
            table = self.query_one("#column-picker-table", DataTable)
            table.move_cursor(row=max(0, table.cursor_row - 1))
        except Exception:
            pass

    def action_move_down(self) -> None:
        try:
            table = self.query_one("#column-picker-table", DataTable)
            max_row = max(0, len(self._ordered_keys) - 1)
            table.move_cursor(row=min(max_row, table.cursor_row + 1))
        except Exception:
            pass

    def action_save(self) -> None:
        self.dismiss(dict(self._config))


class BroadcastGroupScreen(Screen):
    """Named broadcast group management + send with confirmation."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("n", "new_group", "New Group"),
        Binding("d", "delete_group", "Delete"),
        Binding("enter", "open_send_dialog", "Send"),
    ]

    CSS = """
    BroadcastGroupScreen { background: #22272e; }
    BroadcastGroupScreen DataTable { height: 1fr; background: #22272e; }
    BroadcastGroupScreen Input {
        height: 3;
        background: #2d333b;
        border: solid #316dca;
        color: #adbac7;
        margin: 0 1;
    }
    #broadcast-confirm {
        height: auto;
        background: #2d333b;
        border: round #f0883e;
        padding: 1 2;
        margin: 0 1;
        display: none;
    }
    #broadcast-confirm.visible { display: block; }
    """

    def __init__(self, tmux: TmuxClient, sessions: list[AgentSession]) -> None:
        super().__init__()
        self._tmux = tmux
        self._sessions = sessions
        self._data = _load_broadcast_groups()
        self._pending_msg: str = ""
        self._pending_group: Optional[str] = None
        self._send_mode: bool = False
        self._new_group_mode: bool = False
        self._group_order: list[str] = []

    def compose(self) -> ComposeResult:
        yield Header()
        yield DataTable(id="broadcast-table", cursor_type="row", show_cursor=True)
        yield Input(id="broadcast-input", placeholder="Group name or message…")
        yield Static("", id="broadcast-confirm")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#broadcast-table", DataTable)
        table.add_column("GROUP", width=20, key="group")
        table.add_column("PANES", width=8, key="panes")
        table.add_column("LAST MESSAGE", width=35, key="last")
        table.focus()
        self._refresh_table()

    def _refresh_table(self) -> None:
        table = self.query_one("#broadcast-table", DataTable)
        table.clear()
        self._group_order = []
        groups = self._data.get("groups", {})
        if not isinstance(groups, dict):
            groups = {}
            self._data["groups"] = groups
        for name, info in groups.items():
            if not isinstance(info, dict):
                continue
            panes = info.get("pane_ids", [])
            if not isinstance(panes, list):
                panes = []
            history = info.get("history", [])
            if not isinstance(history, list):
                history = []
            last = str(history[-1])[:34] if history else ""
            table.add_row(
                Text(str(name)[:19], style="#adbac7"),
                Text(str(len(panes)), style="#636e7b"),
                Text(last, style="#636e7b"),
                key=str(name),
            )
            self._group_order.append(str(name))

    def _current_group_name(self) -> Optional[str]:
        try:
            idx = self.query_one("#broadcast-table", DataTable).cursor_row
        except Exception:
            return None
        if 0 <= idx < len(self._group_order):
            return self._group_order[idx]
        return None

    def _hide_confirm(self) -> None:
        confirm = self.query_one("#broadcast-confirm", Static)
        confirm.update("")
        confirm.remove_class("visible")

    def action_new_group(self) -> None:
        self._new_group_mode = True
        self._send_mode = False
        self._pending_msg = ""
        self._pending_group = None
        self._hide_confirm()
        inp = self.query_one("#broadcast-input", Input)
        inp.placeholder = "New group name…"
        inp.value = ""
        inp.focus()

    def action_delete_group(self) -> None:
        name = self._current_group_name()
        if not name:
            return
        groups = self._data.setdefault("groups", {})
        if not isinstance(groups, dict):
            groups = {}
            self._data["groups"] = groups
        if name in groups:
            del groups[name]
            _save_broadcast_groups(self._data)
            self._refresh_table()
            self.notify(f"Deleted group: {name}")

    def action_open_send_dialog(self) -> None:
        name = self._current_group_name()
        if not name:
            return
        self._send_mode = True
        self._new_group_mode = False
        self._pending_msg = ""
        self._pending_group = None
        self._hide_confirm()
        inp = self.query_one("#broadcast-input", Input)
        inp.placeholder = f"Message to [{name}]…"
        inp.value = ""
        inp.focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "broadcast-input":
            return
        text = event.value.strip()
        if not text:
            self._send_mode = False
            self._new_group_mode = False
            return

        if self._new_group_mode:
            groups = self._data.setdefault("groups", {})
            if not isinstance(groups, dict):
                groups = {}
                self._data["groups"] = groups
            if text in groups:
                self.notify(f"Group '{text}' already exists", severity="warning")
            else:
                pane_ids: list[str] = []
                seen: set[str] = set()
                for session in self._sessions:
                    pane_id = (
                        getattr(session, "tmux_pane_id", None) or session.tmux_pane
                    )
                    pane_id = str(pane_id).strip() if pane_id else ""
                    if session.state != "active" or not pane_id or pane_id in seen:
                        continue
                    seen.add(pane_id)
                    pane_ids.append(pane_id)
                groups[text] = {"pane_ids": pane_ids, "history": []}
                _save_broadcast_groups(self._data)
                self._refresh_table()
                self.notify(f"Created group '{text}' with {len(pane_ids)} panes")
            self._new_group_mode = False
            event.input.value = ""
            event.input.placeholder = "Group name or message…"
            return

        if self._send_mode:
            name = self._current_group_name()
            if not name:
                return
            groups = self._data.get("groups", {})
            if not isinstance(groups, dict):
                return
            info = groups.get(name, {})
            if not isinstance(info, dict):
                return
            pane_ids = info.get("pane_ids", [])
            if not isinstance(pane_ids, list):
                pane_ids = []
            confirm = self.query_one("#broadcast-confirm", Static)
            pane_lines = (
                "\n".join(f"- {pane_id}" for pane_id in pane_ids) or "- (no panes)"
            )
            confirm.update(f"Target panes:\n{pane_lines}\n\nConfirm send? [y/n]")
            confirm.add_class("visible")
            self._pending_msg = text
            self._pending_group = name
            event.input.value = ""
            event.input.placeholder = "y/n"
            return

    def on_key(self, event) -> None:
        if not self._pending_msg:
            return
        key = str(getattr(event, "key", "")).lower()
        if key == "y":
            self._do_send()
            event.stop()
        elif key == "n":
            self._pending_msg = ""
            self._pending_group = None
            self._send_mode = False
            self._hide_confirm()
            inp = self.query_one("#broadcast-input", Input)
            inp.placeholder = "Group name or message…"
            event.stop()

    def _do_send(self) -> None:
        name = self._pending_group or self._current_group_name()
        if not name or not self._pending_msg:
            return
        groups = self._data.setdefault("groups", {})
        if not isinstance(groups, dict):
            groups = {}
            self._data["groups"] = groups
        info = groups.setdefault(name, {"pane_ids": [], "history": []})
        if not isinstance(info, dict):
            info = {"pane_ids": [], "history": []}
            groups[name] = info
        pane_ids = info.get("pane_ids", [])
        if not isinstance(pane_ids, list):
            pane_ids = []
            info["pane_ids"] = pane_ids
        sent = 0
        for pane_id in pane_ids:
            try:
                self._tmux.send_keys(str(pane_id), self._pending_msg)
                sent += 1
            except Exception:
                pass

        hist = info.setdefault("history", [])
        if not isinstance(hist, list):
            hist = []
            info["history"] = hist
        hist.append(self._pending_msg)
        if len(hist) > _BROADCAST_HISTORY_CAP:
            hist[:] = hist[-_BROADCAST_HISTORY_CAP:]

        _save_broadcast_groups(self._data)
        self._refresh_table()
        self._hide_confirm()
        self.notify(f"Sent to {sent}/{len(pane_ids)} panes")
        self._pending_msg = ""
        self._pending_group = None
        self._send_mode = False
        inp = self.query_one("#broadcast-input", Input)
        inp.placeholder = "Group name or message…"


class HistoryPickerScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("enter", "select_item", "Select"),
    ]
    CSS = """
    HistoryPickerScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.55);
    }
    #history-dialog {
        width: 90;
        max-height: 18;
        border: round #444c56;
        background: #2d333b;
        padding: 1;
    }
    #hist-table {
        height: 1fr;
        background: #22272e;
    }
    """

    def __init__(self, history: list[str]) -> None:
        super().__init__()
        self._history = history[:10]

    def compose(self) -> ComposeResult:
        with Vertical(id="history-dialog"):
            yield Static("History — Enter to select")
            yield DataTable(id="hist-table", cursor_type="row", show_cursor=True)

    def on_mount(self) -> None:
        table = self.query_one("#hist-table", DataTable)
        table.add_column("INPUT", key="entry")
        for idx, entry in enumerate(self._history):
            table.add_row(Text(entry, style="#adbac7"), key=str(idx))
        table.focus()

    def action_select_item(self) -> None:
        if not self._history:
            self.dismiss(None)
            return
        try:
            table = self.query_one("#hist-table", DataTable)
            idx = table.cursor_row
        except Exception:
            self.dismiss(None)
            return
        if 0 <= idx < len(self._history):
            self.dismiss(self._history[idx])
            return
        self.dismiss(None)


class AgentsViewCommandProvider(CommandProvider):
    """Custom command palette entries for Agents View."""

    BASE_COMMANDS = [
        ("spawn", "Open spawn agent dialog"),
        ("kill all stalled", "Kill all stalled sessions"),
        ("prune worktrees", "Open prune worktrees wizard"),
        ("show recovery log", "View recovery event log"),
        ("show archive", "View session archive"),
        ("set model", "Set model (not yet implemented)"),
        ("diff session", "Switch to Diff tab for selected session"),
        ("template", "Pick and apply an agent template"),
        ("new worktree", "Open worktree manager"),
        ("broadcast all running", "Select all running sessions for broadcast"),
        ("export sessions", "Export visible sessions to JSON/CSV/Markdown"),
        ("Git: fetch", "Fetch latest remote updates for selected session repo"),
        ("Git: push", "Push selected session branch to origin"),
        ("Git: log", "Show recent commits for selected session repo"),
    ]

    def _commands_for_app(self) -> list[tuple[str, str]]:
        app = self.app
        command_getter = getattr(app, "_palette_commands", None)
        if callable(command_getter):
            try:
                commands = command_getter()
                if isinstance(commands, list):
                    return commands
            except Exception:
                pass
        return list(self.BASE_COMMANDS)

    async def search(self, query: str) -> Hits:
        app = self.app
        matcher = self.matcher(query)
        for cmd, desc in self._commands_for_app():
            score = matcher.match(cmd)
            if score > 0:
                yield Hit(
                    score,
                    matcher.highlight(cmd),
                    lambda c=cmd, a=app: a._palette_dispatch(c),
                    help=desc,
                )

    async def discover(self) -> Hits:
        app = self.app
        for cmd, desc in self._commands_for_app():
            yield DiscoveryHit(
                cmd,
                lambda c=cmd, a=app: a._palette_dispatch(c),
                help=desc,
            )


class AgentsViewApp(App):
    """Agents View — coding-harness session dashboard."""

    TITLE = "Agents View"
    COMMAND_PALETTE_BINDING = "ctrl+p"
    ENABLE_MOUSE = True
    try:
        COMMANDS = App.COMMANDS | {AgentsViewCommandProvider}
    except Exception:  # pragma: no cover - textual version differences
        COMMANDS = {AgentsViewCommandProvider}
    _RIGHT_PANEL_TABS = ["Preview", "Diff", "Info"]
    _SHUTDOWN_DRAIN_GROUPS: tuple[str, ...] = (
        "refresh-active",
        "refresh-all",
        "refresh-diff-stat",
        "refresh-wt-paths",
        "preview-debounce",
        "metrics-refresh",
    )

    CSS = """
AgentsViewApp {
    background: #22272e;
    color: #adbac7;
}
Header {
    background: #1c2128;
    color: #cdd9e5;
    text-style: bold;
}
Footer {
    background: #1c2128;
    color: #636e7b;
}
#left-panel {
    width: 62%;
    border-right: solid #384048;
    background: #22272e;
}
#filter-input {
    display: none;
    height: 3;
    background: #2d333b;
    border: solid #316dca;
    color: #adbac7;
    margin: 0 1;
}
#filter-input.visible {
    display: block;
}
#session-table {
    background: #22272e;
    color: #adbac7;
    height: 1fr;
}
#session-table > .datatable--header {
    background: #2d333b;
    color: #636e7b;
    text-style: bold;
}
#session-table > .datatable--cursor {
    background: #2e3d49;
    text-style: bold;
}
#session-table > .datatable--even-row {
    background: #22272e;
}
#session-table > .datatable--odd-row {
    background: #22272e;
}
#session-table > .datatable--hover {
    background: #303c48;
}
#stats-bar {
    height: 1;
    background: #1c2128;
    color: #636e7b;
    padding: 0 1;
}
#right-panel {
    width: 38%;
    min-width: 28;
    border: round #444c56;
}
#preview-panel {
    width: 100%;
    height: 1fr;
    background: #22272e;
    padding: 1 2;
    overflow-y: auto;
    border: round #444c56;
}
#input-panel {
    width: 100%;
    height: auto;
    border-top: solid #384048;
    padding: 0 1;
}
#input-label {
    color: #636e7b;
    height: 1;
}
#slash-command-popup {
    display: none;
    background: #2d333b;
    border: round #444c56;
    padding: 0 1;
    max-height: 8;
    margin-bottom: 1;
}
#slash-command-popup.visible {
    display: block;
}
#session-input {
    border: solid #316dca;
    background: #22272e;
    color: #adbac7;
}
#preview-content {
    color: #adbac7;
}
#preview-status {
    height: 1;
    border-top: solid #384048;
    padding: 0 1;
    color: #adbac7;
}

#diff-panel {
    width: 100%;
    height: 1fr;
    background: #22272e;
    padding: 1 2;
    overflow-y: auto;
    display: none;
}
#info-panel {
    width: 100%;
    height: 1fr;
    background: #22272e;
    padding: 1 2;
    overflow-y: auto;
    display: none;
}
"""

    BINDINGS = [
        Binding("up", "move_up", "Up", show=False, priority=True),
        Binding("down", "move_down", "Down", show=False, priority=True),
        Binding(
            "shift+up",
            "preview_scroll_up",
            "Scroll preview up",
            show=False,
            priority=True,
        ),
        Binding(
            "shift+down",
            "preview_scroll_down",
            "Scroll preview down",
            show=False,
            priority=True,
        ),
        Binding("j", "move_down", "Down", show=False, priority=True),
        Binding("k", "move_up", "Up", show=False, priority=True),
        Binding("g", "jump_top", "Top", show=False),
        Binding("G", "jump_bottom", "Bottom", show=False),
        Binding("ctrl+home", "jump_to_top", "Jump top"),
        Binding("ctrl+end", "jump_to_bottom", "Jump bottom"),
        Binding("F", "toggle_follow", "Follow mode"),
        Binding("enter", "select_session", "Jump/Resume"),
        Binding("space", "toggle_multi_select", "Toggle select", show=False),
        Binding("B", "broadcast_selected", "Broadcast", show=False),
        Binding("P", "broadcast_template", "Broadcast template", show=False),
        Binding("N", "save_quick_note", "Quick note", show=False),
        Binding("D", "edit_description", "Edit desc", show=False),
        Binding("t", "tag_session", "Tag session"),
        Binding("H", "health_check", "Health", show=False),
        Binding("y", "yank_session", "Yank session ID"),
        Binding("Y", "yank_session_info", "Yank full info"),
        Binding("L", "open_recovery_log", "Recovery Log", show=False),
        Binding("l", "view_session_log", "View log"),
        Binding("S", "show_stalled", "Stalled agents"),
        Binding("x", "mark_done", "Mark done"),
        Binding("Z", "compact_session", "Compact ctx"),
        Binding("m", "toggle_bookmark", "Bookmark"),
        Binding("ctrl+j", "next_bookmark", "Next bookmark", show=False),
        Binding("ctrl+n", "new_session", "New session"),
        Binding("ctrl+g", "open_graph", "Graph", show=False),
        Binding("ctrl+alt+f", "git_fetch", "Git fetch", show=False),
        Binding("ctrl+alt+p", "git_push", "Git push", show=False),
        Binding("ctrl+alt+l", "git_log", "Git log", show=False),
        Binding("T", "open_templates", "Templates", show=False),
        Binding("V", "column_picker", "Columns", show=False),
        Binding("W", "open_worktree_screen", "Worktrees"),
        Binding("M", "show_metrics", "Metrics"),
        Binding("ctrl+b", "open_broadcast_groups", "Broadcast Groups", show=False),
        Binding("A", "open_archive", "Archive", show=False),
        Binding("ctrl+k", "kill_session", "Kill session", show=False),
        Binding("ctrl+space", "select_for_compare", "Compare"),
        Binding("tab", "cycle_focus", "Switch panel", show=False, priority=True),
        Binding("shift+tab", "cycle_focus", "Switch panel", show=False, priority=True),
        Binding("ctrl+]", "tab_right", "Next Panel", show=False),
        Binding("ctrl+[", "tab_left", "Prev Panel", show=False),
        Binding("ctrl+right", "project_tab_next", "Next project", show=False),
        Binding("ctrl+left", "project_tab_prev", "Prev project", show=False),
        Binding("{", "prev_hunk", "Prev hunk", show=False),
        Binding("}", "next_hunk", "Next hunk", show=False),
        Binding("s", "diff_stage", "Stage", show=False),
        Binding("0", "tab_jump_0", "ALL tab", show=False),
        Binding("1", "tab_jump_1", "", show=False),
        Binding("2", "tab_jump_2", "", show=False),
        Binding("3", "tab_jump_3", "", show=False),
        Binding("4", "tab_jump_4", "", show=False),
        Binding("5", "tab_jump_5", "", show=False),
        Binding("6", "tab_jump_6", "", show=False),
        Binding("7", "tab_jump_7", "", show=False),
        Binding("8", "tab_jump_8", "", show=False),
        Binding("9", "tab_jump_9", "", show=False),
        Binding("ctrl+x,left", "subagent_prev", "Prev subagent", show=False),
        Binding("ctrl+x,right", "subagent_next", "Next subagent", show=False),
        Binding("o", "open_or_pr", "Open PR / window", show=False),
        Binding("O", "open_in_window", "New window", show=False),
        Binding("/", "toggle_filter", "Filter"),
        Binding("ctrl+s", "save_filter_preset", "Save filter preset", show=False),
        Binding("ctrl+l", "load_filter_preset", "Load filter preset", show=False),
        Binding("a", "toggle_scope_mode", "Toggle scope"),
        Binding("p", "toggle_pivot", "Pivot view"),
        Binding("r", "refresh_now", "Refresh"),
        Binding("ctrl+1", "sort_by_status", "Sort: status"),
        Binding("ctrl+2", "sort_by_age", "Sort: age"),
        Binding("ctrl+3", "sort_by_role", "Sort: role"),
        Binding("ctrl+4", "sort_by_session", "Sort: name"),
        Binding("ctrl+5", "sort_by_ctx", "Sort: context"),
        Binding("ctrl+6", "sort_by_branch", "Sort: branch"),
        Binding("@", "toggle_macro_record", "Rec macro"),
        Binding("!", "replay_macro", "Replay macro"),
        Binding("ctrl+t", "cycle_theme", "Cycle theme"),
        Binding("C", "show_settings", "Config"),
        Binding("?", "show_help", "Help"),
        Binding("ctrl+f", "global_search", "Global search"),
        Binding("ctrl+r", "history_search", "History Search", show=False),
        Binding("ctrl+e", "export_sessions", "Export"),
        Binding("q", "quit_safe", "Quit"),
    ]

    def __init__(self, scope_root: str) -> None:
        super().__init__()
        from agents_view.adapters.github_adapter import GitHubAdapter as _GitHubAdapter

        self._github_adapter = _GitHubAdapter()
        self._info_panel_last_url: str = ""
        self.scope_root = scope_root.rstrip("/") or "/"
        self._global_scope_enabled: bool = False
        self._shutdown_started: bool = False
        self._shutdown_lock = threading.Lock()
        self._interval_handles: list[object] = []
        self._tmux = TmuxClient()
        self._sessions: list[AgentSession] = []
        self._session_map: dict[str, AgentSession] = {}  # session_id → session
        self._ordered_keys: list[str] = []  # current display order (incl __sep__)
        self._selected_session: Optional[AgentSession] = None
        self._auto_follow: bool = False
        self._pivot_mode: bool = False
        self._follow_target_session_id: Optional[str] = None
        self._panel_tab: int = 0  # current global tab index
        self._panel_tab_state: dict[str, int] = {}  # per-session memory
        self._filter_visible: bool = False
        self._filter_text: str = ""
        self._filter_presets: dict[str, str] = _load_filter_presets()
        self._filter_preset_cycle_index: int = 0
        self._sort_key: str = "age"  # Default sort: most recent activity
        self._sort_reverse: bool = False
        try:
            import json as _j

            sp = _j.loads(_SORT_PREFS_FILE.read_text())
            self._sort_key = sp.get("key", "age")
            self._sort_reverse = bool(sp.get("reverse", False))
        except Exception:
            pass
        self._active_project_root: Optional[str] = None  # None = ALL tab
        self._dismissed_active_session_ids: set[str] = set()
        self._archived_session_keys: set[str] = self._load_archived_session_keys()
        self._adapters = [
            ActiveTmuxAdapter(self._tmux),
            OmpAdapter(),
            ClaudeAdapter(),
            CodexAdapter(),
            OpenCodeAdapter(),
        ]
        self._preview_last_render_key: tuple[object, ...] | None = None
        self._preview_pending_session_id: Optional[str] = None
        self._preview_debounce_handle: Optional[object] = None
        self._preview_session_id: Optional[str] = None
        self._preview_cursor_moved_at: float = 0.0
        self._preview_debounce_seconds: float = 0.15
        self._prev_session_keys: set[str] = set()
        self._background_mode: bool = False
        self._refresh_probe_due_at: float = 0.0
        self._refresh_probe_interval: float = 1.0
        self._refresh_foreground_active_interval: float = 2.0
        self._refresh_foreground_all_interval: float = 3.0
        self._refresh_background_interval: float = 10.0
        self._last_refresh_active_at: float = 0.0
        self._last_refresh_all_at: float = 0.0
        self._nav_direction: int = 1  # last intentional direction: 1=down, -1=up
        self._broadcast_selected_ids: set[str] = set()
        self._compare_sessions: list[str] = []
        self._broadcast_confirm_pending: bool = False
        self._broadcast_confirm_msg: str = ""
        self._broadcast_pending: bool = False
        self._broadcast_pending_msg: str = ""
        self._broadcast_pending_timer: object | None = None
        self._context_alerted_80: set[str] = set()  # session_ids already alerted at 80%
        self._context_alerted_95: set[str] = set()  # session_ids already alerted at 95%
        self._bookmarks: set[str] = _load_bookmarks()
        self._quick_notes_file = os.environ.get(
            "OMP_AGENTS_VIEW_NOTES_FILE", _DEFAULT_QUICK_NOTES_FILE
        )
        self._quick_notes: dict[str, str] = self._load_quick_notes()
        self._session_tags: dict[str, list[str]] = _load_session_tags()
        self._session_descriptions: dict[str, str] = _load_session_descriptions()
        self._tag_input_session_id: Optional[str] = None
        self._tag_cycle_index: int = 0
        self._cached_worktree_paths: set[str] = set()
        self._current_theme_idx: int = 0
        self._theme: dict[str, str] = _THEMES[_THEME_ORDER[self._current_theme_idx]]
        try:
            import json as _j

            saved = _j.loads(_THEME_PREFS_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                theme_name = saved.get("theme", "github-dark")
                if theme_name in _THEMES:
                    self._current_theme_idx = _THEME_ORDER.index(theme_name)
                    self._theme = _THEMES[theme_name]
        except Exception:
            pass
        self._column_config: dict[str, bool] = self._normalized_column_config(
            _load_column_config()
        )
        self._input_history: dict[str, list[str]] = {}  # session_id → [oldest…newest]
        self._input_history_idx: dict[
            str, int
        ] = {}  # session_id → cursor (-1 = at end)
        self._input_history_dirty: bool = False
        self._command_history: list[str] = []  # global slash commands [oldest…newest]
        self._command_history_dirty: bool = False
        self._notifications_enabled: bool = True
        self._session_diff_totals: dict[str, tuple[int, int, int]] = {}
        self._diff_hunk_positions: list[int] = []
        self._diff_hunk_idx: int = 0
        self._diff_hunk_session_id: str = ""
        self._diff_hunk_raw_hash: int = 0
        self._notification_events: set[str] = {
            "session_done",
            "session_asking",
            "session_stalled",
            "ctx_warn",
        }
        self._notification_bell: bool = True
        self._notification_desktop: bool = True
        self._notification_footer_flash: bool = True
        self._selected_subagent_index: dict[str, int] = {}
        self._subagent_nav_armed_until: float = 0.0
        self._slash_popup_visible: bool = False
        self._slash_matches: list[str] = []
        self._slash_selected_idx: int = 0
        self._unseen_review_ids: set[str] = (
            set()
        )  # sessions with unseen 'review' status (pulsed until hovered)
        self._macro_recording: bool = False
        self._macro_keys: list[str] = []
        self._saved_macros: dict[str, list[str]] = {}  # name -> key sequence
        self._apply_agents_view_settings(_load_agents_view_settings())

    def _settings_snapshot(self) -> dict[str, int]:
        snapshot = (
            dict(self._agents_view_settings)
            if hasattr(self, "_agents_view_settings")
            else {}
        )
        snapshot["refresh_interval_seconds"] = int(
            max(1, round(getattr(self, "_refresh_foreground_active_interval", 2.0)))
        )
        snapshot["stall_threshold_seconds"] = int(
            getattr(
                model,
                "STALL_THRESHOLD_SECONDS",
                _DEFAULT_AGENTS_VIEW_SETTINGS["stall_threshold_seconds"],
            )
        )
        snapshot["auto_kill_stalled_minutes"] = int(
            max(
                0,
                getattr(
                    self, "_auto_kill_stalled_minutes", _AUTO_KILL_STALLED_AFTER_MINUTES
                ),
            )
        )
        snapshot["max_inactive"] = int(_MAX_VISIBLE_INACTIVE)
        snapshot["preview_tail_bytes"] = int(_JSONL_TAIL_BYTES)
        snapshot["preview_max_lines"] = int(
            snapshot.get(
                "preview_max_lines", _DEFAULT_AGENTS_VIEW_SETTINGS["preview_max_lines"]
            )
        )
        return _sanitize_agents_view_settings(snapshot)

    def _preview_max_lines_setting(self) -> int:
        value = _safe_int(
            getattr(self, "_agents_view_settings", {}).get("preview_max_lines")
        )
        if value is None or value <= 0:
            return _DEFAULT_AGENTS_VIEW_SETTINGS["preview_max_lines"]
        return value

    def _apply_agents_view_settings(self, settings: dict[str, int]) -> None:
        sanitized = _sanitize_agents_view_settings(settings)
        _apply_agents_view_runtime_settings(sanitized)
        self._agents_view_settings = dict(sanitized)

        refresh_seconds = float(sanitized["refresh_interval_seconds"])
        self._refresh_probe_interval = refresh_seconds
        self._refresh_foreground_active_interval = refresh_seconds
        self._refresh_foreground_all_interval = refresh_seconds
        self._refresh_background_interval = max(10.0, refresh_seconds)
        self._last_refresh_active_at = 0.0
        self._last_refresh_all_at = 0.0
        self._auto_kill_stalled_minutes = sanitized["auto_kill_stalled_minutes"]

    def pop_screen(self):
        """Override to absorb Textual 8.x CommandPalette double-dismiss bug."""
        try:
            return super().pop_screen()
        except Exception as exc:
            if "at least one screen" in str(exc):
                log.debug("pop_screen: ignoring CommandPalette double-dismiss")
                return self.screen
            raise

    def compose(self) -> ComposeResult:
        yield Header()
        yield ProjectTabBar()
        yield ResourceBar()
        with Horizontal():
            with Vertical(id="left-panel"):
                yield Input(
                    id="filter-input",
                    placeholder="Filter sessions… (#tag for tag filter)",
                )
                yield DataTable(id="session-table", cursor_type="row", show_cursor=True)
            with Vertical(id="right-panel"):
                with ScrollableContainer(id="preview-panel"):
                    yield Static("", id="preview-content", markup=False)
                with ScrollableContainer(id="diff-panel"):
                    yield Static("", id="diff-content", markup=False)
                with ScrollableContainer(id="info-panel"):
                    yield Static("", id="info-content", markup=False)
                yield Static("", id="preview-status", markup=False)
                with Vertical(id="input-panel"):
                    yield Static("", id="slash-command-popup", markup=False)
                    yield Static("", id="input-label", markup=True)
                    yield Input(id="session-input", placeholder="Type message…")
        yield Static("", id="stats-bar", markup=False)
        yield Footer()

    def _apply_theme(self, theme: dict[str, str]) -> None:
        palette = theme if isinstance(theme, dict) else _THEMES[_THEME_ORDER[0]]
        try:
            self.styles.background = palette.get("bg_primary", "#22272e")
        except Exception:
            return

    def _normalized_column_config(
        self, config: dict[str, bool] | None = None
    ) -> dict[str, bool]:
        normalized = dict(_COLUMN_DEFAULTS)
        if config:
            for key, value in config.items():
                if key in normalized and isinstance(value, bool):
                    normalized[key] = value
        for key in _LOCKED_COLUMNS:
            normalized[key] = True
        return normalized

    def _session_table_columns(self) -> list[tuple[str, str, int]]:
        columns: list[tuple[str, str, int]] = []
        for key, label, width in _SESSION_TABLE_COLUMNS:
            if key in _LOCKED_COLUMNS or self._column_config.get(key, True):
                columns.append((key, label, width))
        return columns

    def _session_table_column_keys(self) -> list[str]:
        return [key for key, _, _ in self._session_table_columns()]

    def _configure_session_table_columns(self, table: DataTable) -> None:
        try:
            table.clear(columns=True)
        except TypeError:
            table.clear()
            for key, _, _ in _SESSION_TABLE_COLUMNS:
                try:
                    table.remove_column(key)
                except Exception:
                    pass
        for key, label, width in self._session_table_columns():
            table.add_column(label, width=width, key=key)

    def _apply_column_config(self, config: dict[str, bool]) -> None:
        self._column_config = self._normalized_column_config(config)
        _save_column_config(self._column_config)
        try:
            table = self.query_one("#session-table", DataTable)
        except Exception:
            return
        self._configure_session_table_columns(table)
        self._ordered_keys = []
        self._update_table()

    def _register_interval(
        self, interval: float, callback: Callable[..., object]
    ) -> None:
        handle = self.set_interval(interval, callback)
        if handle is not None:
            self._interval_handles.append(handle)

    @staticmethod
    def _cancel_timer_handle(handle: object | None) -> None:
        if handle is None:
            return
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            cancel()
            return
        stop = getattr(handle, "stop", None)
        if callable(stop):
            stop()

    @staticmethod
    def _is_shutdown_runtime_error(exc: Exception) -> bool:
        if not isinstance(exc, RuntimeError):
            return False
        message = str(exc).lower()
        return any(
            token in message
            for token in (
                "event loop is closed",
                "no running event loop",
                "not running",
                "app is not running",
                "is closing",
                "closed",
            )
        )

    def _begin_shutdown(self) -> None:
        with self._shutdown_lock:
            if self._shutdown_started:
                return
            self._shutdown_started = True

        self._preview_pending_session_id = None
        self._cancel_pending_broadcast()
        self._cancel_timer_handle(self._preview_debounce_handle)
        self._preview_debounce_handle = None

        for handle in list(self._interval_handles):
            self._cancel_timer_handle(handle)
        self._interval_handles.clear()

        workers = getattr(self, "workers", None)
        if workers is None:
            return

        drain_workers: list[Any] = []
        for group in self._SHUTDOWN_DRAIN_GROUPS:
            try:
                drain_workers.extend(workers.cancel_group(self, group))
            except Exception:
                continue

        if drain_workers:
            deadline = time.monotonic() + 0.5
            while time.monotonic() < deadline:
                if not any(
                    getattr(worker, "is_running", False) for worker in drain_workers
                ):
                    break
                time.sleep(0.01)
        try:
            workers.cancel_node(self)
        except Exception:
            pass

    def prepare_shutdown(self) -> None:
        self._begin_shutdown()

    def call_from_thread(
        self,
        callback: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object | None:
        if self._shutdown_started:
            return None
        try:
            return super().call_from_thread(callback, *args, **kwargs)
        except Exception as exc:
            if self._shutdown_started and self._is_shutdown_runtime_error(exc):
                return None
            raise

    async def on_mount(self) -> None:
        self._update_scope_subtitle()
        self._load_input_history()
        self._load_command_history()
        table = self.query_one("#session-table", DataTable)
        self._configure_session_table_columns(table)
        self._apply_theme(self._theme)
        if self._adapters:
            self._register_interval(0.5, self._refresh_active)
            self._register_interval(2.0, self._refresh_all)
            self._register_interval(
                10.0, self._refresh_diff_stats
            )  # diff stats every 10s
            self._do_refresh_all()  # sync initial load
        self._register_interval(5, self._tick_resource_bar)
        self._register_interval(5, self._tick_diff_panel)
        self._register_interval(60, self._tick_info_panel)
        self._register_interval(
            30.0, self._refresh_worktree_paths
        )  # worktree paths every 30s
        self._refresh_worktree_paths()
        self._apply_panel_tab(self._panel_tab)
        table.focus()
        self._update_stats_bar()

    def on_unmount(self) -> None:
        self._begin_shutdown()
        if self._input_history_dirty:
            self._save_input_history()
        if self._command_history_dirty:
            self._save_command_history()

    def _update_header_title(self, sessions: list[AgentSession]) -> None:
        active_count = sum(1 for session in sessions if session.state == "active")
        running_count = sum(
            1 for session in sessions if session.status in ("running", "delegating")
        )
        stalled_count = sum(1 for session in sessions if session.status == "stalled")
        parts = [f"{active_count} sessions"]
        if running_count:
            parts.append(f"{running_count} running")
        if stalled_count:
            parts.append(f"●{stalled_count} stalled")
        try:
            self.title = "Agents View — " + "  ".join(parts)
        except Exception:
            pass

    def _update_stats_bar(self) -> None:
        try:
            stats_bar = self.query_one("#stats-bar", Static)
        except Exception:
            return

        sessions = list(self._sessions)
        self._update_header_title(sessions)
        if not sessions:
            stats_bar.update(Text("No sessions", style="#636e7b"))
            return

        running_statuses = {"running", "delegating"}
        waiting_statuses = {"wait", "waiting", "asking"}

        active_count = sum(1 for session in sessions if session.state == "active")
        running_count = sum(
            1
            for session in sessions
            if session.state == "active" and session.status in running_statuses
        )
        waiting_count = sum(
            1
            for session in sessions
            if session.state == "active" and session.status in waiting_statuses
        )
        stalled_count = sum(1 for session in sessions if session.status == "stalled")
        idle_count = sum(
            1
            for session in sessions
            if session.state != "active"
            or session.status in {"idle", "offline", "unknown"}
        )

        total_tokens = 0
        total_cost = 0.0
        for session in sessions:
            in_tokens = getattr(session, "total_tokens_in", 0)
            out_tokens = getattr(session, "total_tokens_out", 0)
            cost_value = getattr(session, "cost_usd", 0.0)

            try:
                total_tokens += max(0, int(in_tokens)) + max(0, int(out_tokens))
            except (TypeError, ValueError):
                pass

            try:
                parsed_cost = float(cost_value)
            except (TypeError, ValueError):
                parsed_cost = 0.0
            if math.isfinite(parsed_cost) and parsed_cost > 0:
                total_cost += parsed_cost

        token_label = (
            str(total_tokens) if total_tokens < 1_000 else format_tokens_k(total_tokens)
        )

        scope_root = self._effective_scope_root()
        project_roots: set[str] = set()
        context_warn_count = 0
        context_full_count = 0
        for session in sessions:
            cwd = (session.cwd or "").strip()
            if cwd:
                project_root = _project_root_for(cwd, scope_root) or (
                    cwd.rstrip("/") or cwd
                )
                project_roots.add(project_root)
            pct = _normalize_context_usage_pct(session.context_usage_pct)
            if pct is None:
                continue
            if pct >= 0.80:
                context_warn_count += 1
            if pct >= 0.95:
                context_full_count += 1

        summary = Text()
        summary.append(
            f"● {active_count} active",
            style="#3fb950" if active_count else "#636e7b",
        )
        summary.append("  ", style="#636e7b")
        summary.append(
            f"⚡ {running_count} running",
            style="#57c4f8" if running_count else "#636e7b",
        )
        summary.append("  ", style="#636e7b")
        summary.append(
            f"⏳ {waiting_count} waiting",
            style="#d4a72c" if waiting_count else "#636e7b",
        )
        summary.append("  ", style="#636e7b")
        summary.append(
            f"● {stalled_count} stalled",
            style="#f85149" if stalled_count else "#636e7b",
        )
        summary.append("  ", style="#636e7b")
        summary.append(f"○ {idle_count} idle", style="#636e7b")
        summary.append("  │  ", style="#636e7b")
        summary.append(
            f"{token_label} tokens",
            style="#79c0ff" if total_tokens else "#636e7b",
        )
        summary.append("  │  ", style="#636e7b")
        summary.append(
            f"${total_cost:.2f} cost",
            style="#f0883e" if total_cost else "#636e7b",
        )
        summary.append("  │  ", style="#636e7b")
        summary.append(f"{len(sessions)} total", style="#adbac7")
        summary.append("  │  ", style="#636e7b")
        summary.append(f"{len(project_roots)} projects", style="#adbac7")
        if context_warn_count:
            summary.append("  │  ", style="#636e7b")
            summary.append(f"⚠ {context_warn_count} ctx warn", style="#d4a72c")
        if context_full_count:
            summary.append("  │  ", style="#636e7b")
            summary.append(f"!! {context_full_count} ctx FULL", style="#f85149")
        try:
            resources = _get_sys_resources()
            mem_value = resources.get("mem")
            if isinstance(mem_value, (int, float)):
                mem_pct = float(mem_value)
                mem_style = (
                    "#3fb950"
                    if mem_pct < 60
                    else "#d4a72c"
                    if mem_pct < 85
                    else "#f85149"
                )
                summary.append("  │  ", style="#636e7b")
                summary.append(f"mem {mem_pct:.0f}%", style=mem_style)
            cpu_value = resources.get("cpu")
            if isinstance(cpu_value, (int, float)):
                cpu_pct = float(cpu_value)
                cpu_style = (
                    "#3fb950"
                    if cpu_pct < 60
                    else "#d4a72c"
                    if cpu_pct < 85
                    else "#f85149"
                )
                summary.append("  │  ", style="#636e7b")
                summary.append(f"cpu {cpu_pct:.0f}%", style=cpu_style)
        except Exception:
            pass
        summary.append("  │  ", style="#636e7b")
        direction = "↑" if self._sort_reverse else "↓"
        summary.append(f"sorted: {self._sort_key}{direction}", style="#8b949e")
        if self._pivot_mode:
            summary.append("  │  ", style="#636e7b")
            summary.append("[PIVOT]", style="bold #6cb6ff")
        stats_bar.update(summary)

    def action_export_sessions(self) -> None:
        try:
            _export_sessions_artifacts(self._visible_sessions_for_export())
        except OSError as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return
        except Exception as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return
        self.notify("Exported to ~/.omp/agent/exports/ (JSON + CSV + MD)")

    def _tick_resource_bar(self) -> None:
        try:
            self.query_one(ResourceBar).refresh()
        except Exception:
            pass

    def _tick_diff_panel(self) -> None:
        if self._panel_tab == 1:
            self._update_diff_panel()

    def _tick_info_panel(self) -> None:
        if self._panel_tab == 2:
            self._update_info_panel()

    def _known_worktree_paths(self) -> set[str]:
        """Return the set of worktree paths from git worktree list for the scope root."""
        import os as _os

        repo_root = self.scope_root if self.scope_root != "/" else _os.getcwd()
        worktrees = _parse_worktrees(repo_root)
        return {w["path"].rstrip("/") for w in worktrees}

    def _load_templates(self) -> list[dict]:
        """Load all YAML template files from ~/.omp/templates/."""
        try:
            import yaml as _yaml  # type: ignore[import-untyped]
        except ImportError:
            return []

        templates: list[dict] = []
        if not _TEMPLATES_DIR.exists():
            return templates
        for fpath in sorted(_TEMPLATES_DIR.glob("*.yml")):
            try:
                with open(fpath, encoding="utf-8") as f:
                    data = _yaml.safe_load(f)
                if isinstance(data, dict):
                    data["_file"] = str(fpath)
                    templates.append(data)
            except Exception as exc:
                log.debug("template load failed %s: %s", fpath, exc)
        return templates

    # ------------------------------------------------------------------ #
    # Data helpers                                                         #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _archive_session_key(session: AgentSession) -> str:
        return f"{session.harness}:{session.session_id}"

    def _load_archived_session_keys(self) -> set[str]:
        try:
            raw = json.loads(_ARCHIVE_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return set()
        except Exception:
            log.debug("archive read failed: %s", _ARCHIVE_FILE)
            return set()

        if not isinstance(raw, list):
            return set()

        keys: set[str] = set()
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            session_id = entry.get("session_id")
            if not isinstance(session_id, str) or not session_id:
                continue
            harness = entry.get("harness")
            if not isinstance(harness, str) or not harness:
                harness = "omp"
            keys.add(f"{harness}:{session_id}")
        return keys

    def _append_session_to_archive(self, session: AgentSession) -> None:
        key = self._archive_session_key(session)
        if key in self._archived_session_keys:
            return

        archive: list[dict] = []
        try:
            if _ARCHIVE_FILE.exists():
                with open(_ARCHIVE_FILE, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                    if isinstance(loaded, list):
                        archive = loaded
        except Exception as exc:
            log.debug("archive read failed: %s", exc)

        existing_keys: set[str] = set()
        for entry in archive:
            if not isinstance(entry, dict):
                continue
            existing_sid = entry.get("session_id")
            if not isinstance(existing_sid, str) or not existing_sid:
                continue
            existing_harness = entry.get("harness")
            if not isinstance(existing_harness, str) or not existing_harness:
                existing_harness = "omp"
            existing_keys.add(f"{existing_harness}:{existing_sid}")

        if key not in existing_keys:
            ended_ts: Optional[float] = None
            if session.last_activity_ts is not None:
                try:
                    ts_value = float(session.last_activity_ts)
                    if math.isfinite(ts_value) and ts_value > 0:
                        ended_ts = ts_value
                except (TypeError, ValueError):
                    ended_ts = None
            archive.append(
                {
                    "session_id": session.session_id,
                    "title": session.title,
                    "branch": session.branch,
                    "harness": session.harness,
                    "role": session.role,
                    "cost": None,
                    "final_status": session.status,
                    "ended_ts": ended_ts,
                    "cwd": session.cwd,
                }
            )
            try:
                _ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
                tmp_path = _ARCHIVE_FILE.with_suffix(".tmp")
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(archive, f, indent=2)
                tmp_path.replace(_ARCHIVE_FILE)
            except Exception as exc:
                log.debug("archive write failed: %s", exc)

        self._archived_session_keys.add(key)

    def _archive_stale_active_sessions(self, sessions: list[AgentSession]) -> None:
        import time as _time

        now = _time.time()
        for session in sessions:
            if session.state != "active" or not session.title:
                continue
            ts = session.last_activity_ts
            if ts is None:
                continue
            try:
                ts_value = float(ts)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(ts_value) or ts_value <= 0:
                continue
            if (now - ts_value) > _MAX_INACTIVE_AGE_SECONDS:
                self._append_session_to_archive(session)

    def _filter_archived_sessions(
        self, sessions: list[AgentSession]
    ) -> list[AgentSession]:
        return [
            session
            for session in sessions
            if self._archive_session_key(session) not in self._archived_session_keys
        ]
    def _merge_sessions(self, sessions: list[AgentSession]) -> list[AgentSession]:
        """Merge a flat session list; active state wins for duplicate session_ids."""
        by_id: dict[str, AgentSession] = {}
        for s in sessions:
            existing = by_id.get(s.session_id)
            if existing is None:
                by_id[s.session_id] = s
            elif s.state == "active" and existing.state != "active":
                by_id[s.session_id] = s

        # Second pass: populate child_session_ids from parent_session_id links
        for s in by_id.values():
            s.child_session_ids = []  # reset before re-linking
        for s in by_id.values():
            if s.parent_session_id and s.parent_session_id in by_id:
                parent = by_id[s.parent_session_id]
                if s.session_id not in parent.child_session_ids:
                    parent.child_session_ids.append(s.session_id)

        return list(by_id.values())

    def _matches_filter(self, s: AgentSession, ft: str) -> bool:
        """Return True if ft is empty or ft appears in the session's searchable text."""
        if not ft:
            return True
        if ft.startswith("#"):
            needle = _normalize_session_tag(ft)
            if not needle:
                return bool(s.tags)
            return s.has_tag(needle)
        searchable = (s.title + s.cwd + s.harness_label + s.tags_str).lower()
        return ft in searchable

    def _is_visible_inactive_session(self, s: AgentSession, now_ts: float) -> bool:
        ts = s.last_activity_ts
        if ts is None:
            return True
        try:
            ts_value = float(ts)
        except (TypeError, ValueError):
            return True
        if not math.isfinite(ts_value) or ts_value <= 0:
            return True
        return (now_ts - ts_value) <= _MAX_INACTIVE_AGE_SECONDS

    def _compute_ordered_keys(self, sessions: list[AgentSession]) -> list[str]:
        """Return ordered key list for the current view mode."""
        ft = self._filter_text.lower()
        # Keep active sessions visible even before title hydration; untitled inactive sessions stay hidden.
        filtered = [
            s
            for s in sessions
            if (s.state == "active" or s.title) and self._matches_filter(s, ft)
        ]
        if not self._pivot_mode and self._active_project_root is not None:
            filtered = [
                s
                for s in filtered
                if _project_root_for(s.cwd, self.scope_root)
                == self._active_project_root
            ]
        now_ts = __import__("time").time()

        active_candidates = [
            s
            for s in filtered
            if s.state == "active"
            and s.session_id not in self._dismissed_active_session_ids
        ]
        inactive_candidates = [
            s
            for s in filtered
            if s.state != "active" and self._is_visible_inactive_session(s, now_ts)
        ]

        if self._pivot_mode:
            grouped: dict[str, list[AgentSession]] = {
                group_name: [] for group_name, _ in _PIVOT_STATUS_GROUPS
            }
            for session in active_candidates:
                status = (session.status or "").lower()
                if status in {"running", "delegating"}:
                    grouped["running"].append(session)
                elif status == "asking":
                    grouped["asking"].append(session)
                elif status in {"wait", "waiting", "review"}:
                    grouped["waiting"].append(session)
                elif status == "stalled":
                    grouped["stalled"].append(session)
                else:
                    grouped["idle"].append(session)
            grouped["inactive"] = list(inactive_candidates)

            keys: list[str] = []
            for group_name, _ in _PIVOT_STATUS_GROUPS:
                group_sessions = grouped.get(group_name, [])
                if not group_sessions:
                    continue
                sorted_group = _sorted_sessions(
                    group_sessions, self._sort_key, self._sort_reverse
                )
                if group_name == "inactive":
                    sorted_group = sorted_group[:_MAX_VISIBLE_INACTIVE]
                if not sorted_group:
                    continue
                keys.append(f"{_SEP_KEY}:{group_name}:{len(sorted_group)}")
                keys.extend(session.session_id for session in sorted_group)
            return keys

        active = _sorted_sessions(active_candidates, self._sort_key, self._sort_reverse)
        inactive = _sorted_sessions(
            inactive_candidates, self._sort_key, self._sort_reverse
        )[:_MAX_VISIBLE_INACTIVE]
        keys: list[str] = [s.session_id for s in active]
        if active and inactive:
            keys.append(_SEP_KEY)
        keys.extend(s.session_id for s in inactive)
        return keys

    def _cleanup_dismissed_active_ids(self, sessions: list[AgentSession]) -> None:
        """Drop dismissed ids once sessions are no longer active."""
        active_ids = {s.session_id for s in sessions if s.state == "active"}
        self._dismissed_active_session_ids.intersection_update(active_ids)

    @staticmethod
    def _session_note_key(session: AgentSession) -> str:
        return f"{session.harness}:{session.session_id}"

    def _load_quick_notes(self) -> dict[str, str]:
        try:
            with open(self._quick_notes_file, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError):
            log.warning("quick notes: unable to read %s", self._quick_notes_file)
            return {}

        if not isinstance(raw, dict):
            log.warning(
                "quick notes: ignoring non-object payload in %s", self._quick_notes_file
            )
            return {}

        notes: dict[str, str] = {}
        for key, value in raw.items():
            if not isinstance(key, str) or not isinstance(value, str):
                continue
            note = value.strip()
            if note:
                notes[key] = note[:_MAX_QUICK_NOTE_LEN]
        return notes

    def _save_quick_notes(self) -> None:
        payload = {key: value for key, value in self._quick_notes.items() if value}
        tmp_path = f"{self._quick_notes_file}.tmp"
        try:
            parent = os.path.dirname(self._quick_notes_file)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
            os.replace(tmp_path, self._quick_notes_file)
        except OSError:
            log.warning("quick notes: unable to persist %s", self._quick_notes_file)
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    def _load_input_history(self) -> None:
        import json as _json

        try:
            self._input_history = _json.loads(
                _INPUT_HISTORY_FILE.read_text(encoding="utf-8")
            )
            if not isinstance(self._input_history, dict):
                self._input_history = {}
        except FileNotFoundError:
            self._input_history = {}
        except Exception:
            self._input_history = {}

        cleaned: dict[str, list[str]] = {}
        for session_id, history in self._input_history.items():
            if not isinstance(session_id, str) or not isinstance(history, list):
                continue
            entries = [
                entry for entry in history if isinstance(entry, str) and entry.strip()
            ]
            entries = _dedupe_recent_entries(entries, _INPUT_HISTORY_CAP)
            if entries:
                cleaned[session_id] = entries
        self._input_history = cleaned
        self._input_history_idx = {
            session_id: len(history)
            for session_id, history in self._input_history.items()
        }

    def _save_input_history(self) -> None:
        import json as _json

        try:
            _INPUT_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            _INPUT_HISTORY_FILE.write_text(
                _json.dumps(self._input_history, indent=2), encoding="utf-8"
            )
            self._input_history_dirty = False
        except Exception as exc:
            log.debug("save input history failed: %s", exc)

    def _load_command_history(self) -> None:
        import json as _json

        try:
            raw = _json.loads(_COMMAND_HISTORY_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raw = []
        except Exception:
            raw = []

        if not isinstance(raw, list):
            self._command_history = []
            return
        entries = [
            entry.strip()
            for entry in raw
            if isinstance(entry, str) and entry.strip().startswith("/")
        ]
        self._command_history = _dedupe_recent_entries(entries, _INPUT_HISTORY_CAP)

    def _save_command_history(self) -> None:
        import json as _json

        try:
            _COMMAND_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            _COMMAND_HISTORY_FILE.write_text(
                _json.dumps(self._command_history, indent=2), encoding="utf-8"
            )
            self._command_history_dirty = False
        except Exception as exc:
            log.debug("save command history failed: %s", exc)

    def _apply_quick_notes(self, sessions: list[AgentSession]) -> None:
        for session in sessions:
            session.quick_note = self._quick_notes.get(
                self._session_note_key(session), ""
            )
            session.tags = list(self._session_tags.get(session.session_id, []))
            session.description = self._session_descriptions.get(session.session_id, "")

    def _apply_stall_status(self, sessions: list[AgentSession]) -> None:
        import time as _t
        from .model import WAIT_THRESHOLD_SECONDS, STALL_THRESHOLD_SECONDS

        session_map = {s.session_id: s for s in sessions}
        now = _t.time()

        def effective_last_activity(s: AgentSession, depth: int = 0) -> float:
            """Return the most recent last_activity_ts across s and all active descendants."""
            if depth > 10:
                return s.last_activity_ts or 0.0
            best = s.last_activity_ts or 0.0
            for cid in s.child_session_ids or []:
                child = session_map.get(cid)
                if child and child.state == "active":
                    child_ts = effective_last_activity(child, depth + 1)
                    if child_ts > best:
                        best = child_ts
            return best

        def any_descendant_running(s: AgentSession, depth: int = 0) -> bool:
            """Return True if any active descendant has status 'running'."""
            if depth > 10:
                return False
            for cid in s.child_session_ids or []:
                child = session_map.get(cid)
                if child and child.state == "active":
                    if child.status == "running":
                        return True
                    if any_descendant_running(child, depth + 1):
                        return True
            return False

        for s in sessions:
            if s.state != "active":
                continue

            # REVIEW: agent sent output to user — never override with timer
            if s.status == "review":
                continue

            # If this session or any active descendant is actively running, force RUN
            if s.status == "running" or any_descendant_running(s):
                s.status = "running"
                continue

            # Compute inactivity across the whole subtree
            last_ts = effective_last_activity(s)
            if last_ts == 0.0:
                continue  # no timestamp — skip
            idle_seconds = now - last_ts

            if idle_seconds < WAIT_THRESHOLD_SECONDS:
                # Recently active — if stuck in delegating/idle, promote to running
                if s.status in ("delegating", "idle", "unknown"):
                    s.status = "running"
            elif idle_seconds < STALL_THRESHOLD_SECONDS:
                s.status = "wait"
            else:
                s.status = "stalled"

    def _update_unseen_review(self, new_sessions: list[AgentSession]) -> None:
        """Track sessions that freshly entered 'review' status without the user hovering.

        A session is added to _unseen_review_ids when it transitions into review
        (including on first load).  The hover handler (_on_data_table_row_highlighted)
        discards it.  If the session re-enters review later, it is added again.
        """
        prev = {s.session_id: s.status for s in self._sessions}
        for s in new_sessions:
            if s.status == "review":
                if prev.get(s.session_id) != "review":
                    # Freshly entered review — user hasn't seen it yet.
                    self._unseen_review_ids.add(s.session_id)
            else:
                # Session left review — drop pulse regardless of hover state.
                self._unseen_review_ids.discard(s.session_id)

    def _notify_state_transitions(self, new_sessions: list[AgentSession]) -> None:
        """Fire notifications for sessions that transitioned to noteworthy states."""
        prev = {s.session_id: s.status for s in self._sessions}
        for session in new_sessions:
            old_status = prev.get(session.session_id)
            if old_status is None or old_status == session.status:
                continue
            title = (session.title or session.session_id[:12])[:25]
            if session.status == "offline" and old_status in (
                "review",
                "wait",
                "waiting",
                "running",
                "delegating",
                "idle",
            ):
                self._fire_notification(f"{title}: session done", "session_done")
            elif session.status == "asking" and old_status != "asking":
                self._fire_notification(f"{title}: waiting for input", "session_asking")
            elif session.status == "stalled" and old_status != "stalled":
                self._fire_notification(f"{title}: session stalled", "session_stalled")

    def _fire_notification(self, msg: str, event_type: str) -> None:
        """Send a notification via app.notify plus optional bell and desktop alerts."""
        import subprocess as _sp

        if (
            not self._notifications_enabled
            or event_type not in self._notification_events
        ):
            return
        self.notify(msg, timeout=8)
        if self._notification_footer_flash:
            self.sub_title = f"{self._scope_subtitle()} | {msg}"
            self.set_timer(1.5, self._update_scope_subtitle)
        if self._notification_bell:
            try:
                current = self._tmux.get_current_session() or ""
                if current:
                    tty = _sp.check_output(
                        ["tmux", "display-message", "-t", current, "-p", "#{pane_tty}"],
                        text=True,
                    ).strip()
                    with open(tty, "w") as _tty:
                        _tty.write("\a")
            except Exception:
                pass
        if self._notification_desktop:
            try:
                _sp.Popen(["notify-send", "Agents View", msg], start_new_session=True)
            except Exception:
                pass

    def _set_quick_note(self, session: AgentSession, note: str) -> None:
        key = self._session_note_key(session)
        normalized = note.strip()[:_MAX_QUICK_NOTE_LEN]
        if normalized:
            self._quick_notes[key] = normalized
        else:
            self._quick_notes.pop(key, None)
        session.quick_note = normalized

    def _set_session_description(self, session: AgentSession, description: str) -> str:
        normalized = description.strip()
        if normalized:
            self._session_descriptions[session.session_id] = normalized
        else:
            self._session_descriptions.pop(session.session_id, None)
        session.description = normalized
        return normalized

    def _add_session_tag(self, session: AgentSession, raw_tag: str) -> bool:
        normalized = _normalize_session_tag(raw_tag)
        if not normalized:
            return False

        tags = _normalize_session_tags(session.tags)
        if normalized in tags:
            session.tags = tags
            self._session_tags[session.session_id] = list(tags)
            return True
        if len(tags) >= _MAX_SESSION_TAGS:
            return False

        tags.append(normalized)
        session.tags = tags
        self._session_tags[session.session_id] = list(tags)
        return True

    def _clear_tag_input_mode(self) -> None:
        self._tag_input_session_id = None
        try:
            self.query_one("#session-input", Input).placeholder = "Type message…"
        except Exception:
            pass

    def _is_table_focused(self) -> bool:
        try:
            return self.query_one("#session-table", DataTable).has_focus
        except Exception:
            return False

    def _broadcast_selected_targets(self) -> list[AgentSession]:
        return [
            self._session_map[key]
            for key in self._ordered_keys
            if key in self._broadcast_selected_ids and key in self._session_map
        ]

    def _running_broadcast_targets(self) -> list[AgentSession]:
        return [
            session
            for session in self._sessions
            if session.state == "active" and session.status not in {"offline", "idle"}
        ]

    def _set_broadcast_selection(self, session_ids: set[str]) -> None:
        normalized = {sid for sid in session_ids if sid in self._session_map}
        if normalized != self._broadcast_selected_ids:
            self._cancel_pending_broadcast()
        self._broadcast_selected_ids = normalized

    def _cancel_pending_broadcast(self) -> None:
        self._broadcast_confirm_pending = False
        self._broadcast_confirm_msg = ""
        self._broadcast_pending = False
        self._broadcast_pending_msg = ""
        timer = self._broadcast_pending_timer
        self._broadcast_pending_timer = None
        if timer is None:
            return
        cancel = getattr(timer, "cancel", None)
        if callable(cancel):
            cancel()
            return
        stop = getattr(timer, "stop", None)
        if callable(stop):
            stop()

    def _expire_pending_broadcast(self) -> None:
        self._cancel_pending_broadcast()

    def _arm_pending_broadcast(self, message: str) -> None:
        self._cancel_pending_broadcast()
        self._broadcast_confirm_pending = True
        self._broadcast_confirm_msg = message
        self._broadcast_pending = True
        self._broadcast_pending_msg = message
        self._broadcast_pending_timer = None

    def _truncate_status_field(self, value: str, max_len: int = 30) -> str:
        text = (value or "").strip()
        if len(text) <= max_len:
            return text
        return text[: max_len - 1] + "…"

    def _preview_status_line(self, s: AgentSession) -> Text:
        line = Text()

        def field(label: str, value: str, value_style: str) -> None:
            if line.plain:
                line.append("   ", style="#444c56")
            line.append(f"{label} ", style="bold #636e7b")
            line.append(value, style=value_style)

        model_raw = (s.model or "").strip()
        model_text = (
            self._truncate_status_field(model_raw, max_len=30) if model_raw else "—"
        )
        model_style = "#79c0ff" if model_raw else "#636e7b"
        field("Model:", model_text, model_style)

        role_raw = (s.role or "").strip().lower()
        if role_raw in ("orchestrator", "orch"):
            mode_text, mode_style = "ORCH", "bold #f0883e"
        elif role_raw in ("default", "def"):
            mode_text, mode_style = "DEF", "bold #539bf5"
        else:
            mode_text, mode_style = "—", "#636e7b"
        field("Mode:", mode_text, mode_style)

        pct = s.context_usage_pct
        if pct is None:
            ctx_text, ctx_style = "—", "#636e7b"
        else:
            pct = min(1.0, max(0.0, pct))
            pct_int = round(pct * 100)
            ctx_window = context_window_for_model(model_raw)
            if ctx_window is None:
                ctx_text = f"—/— ({pct_int}%)"
            else:
                used_tokens = round(pct * ctx_window)
                ctx_text = f"{format_tokens_k(used_tokens)}/{format_tokens_k(ctx_window)} ({pct_int}%)"
            if pct < 0.50:
                ctx_style = "#3fb950"
            elif pct <= 0.80:
                ctx_style = "#d4a72c"
            else:
                ctx_style = "bold #f85149"
        field("Context:", ctx_text, ctx_style)

        branch_raw = self._truncate_status_field((s.branch or "").strip(), max_len=30)
        branch_text = f"⎇ {branch_raw}" if branch_raw else "—"
        branch_style = "dim #8b949e" if branch_raw else "#636e7b"
        field("Branch:", branch_text, branch_style)
        description_raw = (s.description or "").strip()
        if description_raw:
            description_text = self._truncate_status_field(description_raw, max_len=36)
            field("Desc:", description_text, "#adbac7")

        return line

    # ------------------------------------------------------------------ #
    # Rich cell builders                                                   #
    # ------------------------------------------------------------------ #

    def _status_cell(self, s: AgentSession) -> Text:
        label, style = s.status_rich
        confidence_raw = getattr(s, "status_confidence", 1.0)
        try:
            confidence = float(confidence_raw)
        except (TypeError, ValueError):
            confidence = 1.0
        if confidence < 0.5:
            label = label.rstrip()
            if not label.endswith("?"):
                label = f"{label}?"
        if s.session_id in self._unseen_review_ids and s.status == "review":
            import time as _t

            # Pulse: 1.4-second cycle (0.7s bright, 0.7s dim) riding the 0.5s refresh.
            # sin ≥ 0 → bright phase; sin < 0 → dim phase.
            bright = math.sin(_t.time() * math.pi / 0.7) >= 0
            style = style if bright else "#2a5580"
        return Text(label, style=style)

    def _harness_cell(self, s: AgentSession) -> Text:
        lbl = s.harness_label
        style = "bold #cdd9e5" if s.state == "active" else "#636e7b"
        return Text(lbl, style=style)

    def _session_cell(self, s: AgentSession) -> Text:
        title = s.display_title
        if s.session_id in self._broadcast_selected_ids:
            title = f"{title} [B]"
        title = title[:35] if len(title) > 35 else title
        style = "bold #cdd9e5" if s.state == "active" else "#636e7b"
        cell = Text()
        if s.session_id in self._bookmarks:
            cell.append("★ ", style="bold #d4a72c")
        cell.append(title, style=style)
        for tag in s.tags:
            cell.append(f" [{tag}]", style="dim #636e7b")
        return cell

    def _branch_cell(self, s: AgentSession) -> Text:
        b = s.branch
        # Truncate branch to 26 chars before badge; total cell width is 36
        if len(b) > 26:
            b = b[:26] + "\u2026"
        t = Text(b or "—", style="italic #daaa3f" if b else "#444c56")
        if s.diff_shortstat:
            t.append(f" {s.diff_shortstat}", style="#636e7b")
        if s.cwd and s.cwd.rstrip("/") in self._cached_worktree_paths:
            t.append(" [W]", style="dim #636e7b")
        return t

    def _age_cell(self, session: AgentSession) -> Text:
        """Render the AGE cell with the shared gradient helper."""
        return _render_age_cell(session)

    def _elapsed_cell(self, session: AgentSession) -> Text:
        elapsed = session.elapsed_str
        return Text(
            elapsed or "—",
            style="#636e7b" if not elapsed else "#adbac7",
        )

    def _role_cell(self, s: AgentSession) -> Text:
        label, style = s.role_rich
        return Text(label, style=style)

    def _ctx_cell(self, s: AgentSession) -> Text:
        """Render context usage as an 8-char compact segmented bar."""
        return _render_context_segments(s.context_usage_pct, width=8)

    def _repo_cell(self, s: AgentSession) -> Text:
        name = (s.repo or "")[:15]
        if not name:
            return Text("–", style="#444c56")
        color = _REPO_COLORS[hash(name) % len(_REPO_COLORS)]
        return Text(name, style=f"bold {color}")

    def _separator_row(self, label_text: str = " ⭑ inactive ") -> list[Text]:
        """A dim separator row used for section headers."""
        sep_style = "#303a46"
        label = Text(label_text, style="italic #4a5560")
        cells: list[Text] = []
        for key in self._session_table_column_keys():
            if key == _COL_SESSION:
                cells.append(label)
            else:
                cells.append(Text("", style=sep_style))
        return cells

    def _separator_label_for_key(self, key: str) -> str:
        if key == _SEP_KEY:
            return " ⭑ inactive "
        if not _is_separator_key(key):
            return " ⭑ inactive "

        parts = key.split(":", 2)
        if len(parts) < 2 or parts[0] != _SEP_KEY:
            return " ⭑ inactive "

        group_name = parts[1]
        count_label = parts[2] if len(parts) == 3 else ""
        group_label = next(
            (label for name, label in _PIVOT_STATUS_GROUPS if name == group_name),
            group_name.replace("_", " ").title(),
        )
        if count_label.isdigit():
            return f" ── {group_label} ({count_label}) " + "─" * 30
        return f" ── {group_label} " + "─" * 30

    def _column_cell(self, column_key: str, session: AgentSession) -> Text:
        if column_key == _COL_STATUS:
            return self._status_cell(session)
        if column_key == _COL_HARNESS:
            return self._harness_cell(session)
        if column_key == _COL_ROLE:
            return self._role_cell(session)
        if column_key == _COL_SESSION:
            return self._session_cell(session)
        if column_key == _COL_BRANCH:
            return self._branch_cell(session)
        if column_key == _COL_AGE:
            return self._age_cell(session)
        if column_key == _COL_ELAPSED:
            return self._elapsed_cell(session)
        if column_key == _COL_CTX:
            return self._ctx_cell(session)
        if column_key == _COL_REPO:
            return self._repo_cell(session)
        return Text("", style="#636e7b")

    def _make_row_cells(self, s: AgentSession) -> list[Text]:
        return [
            self._column_cell(column_key, s)
            for column_key in self._session_table_column_keys()
        ]

    def _effective_scope_root(self) -> str:
        return "/" if self._global_scope_enabled else self.scope_root

    def _scope_subtitle(self) -> str:
        if self._global_scope_enabled:
            return (
                f"scope: global (all paths) | scoped root: {self.scope_root} | "
                "a toggles mode"
            )
        return f"scope: scoped ({self.scope_root}) | a toggles mode"

    def _update_scope_subtitle(self) -> None:
        self.sub_title = self._scope_subtitle()

    def _update_subtitle(self) -> None:
        parts: list[str] = []
        try:
            fv = self.query_one("#filter-input", Input).value
            if fv and fv.strip():
                parts.append(f"filter: {fv[:20]}")
        except Exception:
            pass
        if getattr(self, "_pivot_mode", False):
            parts.append("PIVOT")
        if getattr(self, "_auto_follow", False):
            parts.append("FOLLOW")
        if getattr(self, "_macro_recording", False):
            parts.append("● REC")
        sort_key = getattr(self, "_sort_key", "age")
        if sort_key != "age":
            direction = "↓" if not getattr(self, "_sort_reverse", False) else "↑"
            parts.append(f"sort:{sort_key}{direction}")
        try:
            self.sub_title = "  ".join(parts) if parts else ""
        except Exception:
            pass

    def _flash_health_banner(self, message: str, duration: float = 1.5) -> None:
        self.sub_title = f"{self._scope_subtitle()} | WARNING: {message}"
        self.set_timer(duration, self._update_scope_subtitle)

    # ------------------------------------------------------------------ #
    # Refresh methods                                                      #
    # ------------------------------------------------------------------ #

    @work(thread=True, exclusive=True, group="refresh-wt-paths")
    def _refresh_worktree_paths(self) -> None:
        if self._shutdown_started:
            return
        paths = self._known_worktree_paths()
        if self._shutdown_started:
            return
        self.call_from_thread(self._apply_worktree_paths, paths)

    def _apply_worktree_paths(self, paths: set[str]) -> None:
        self._cached_worktree_paths = paths
        self._update_table()

    def _sync_scope_root_from_sidebar(self) -> bool:
        """Queue scope_root update from sidebar cwd; return True when scope changed."""
        sidebar = self._tmux.get_sidebar_pane()
        if not sidebar:
            return False
        pid = (sidebar.get("pid") or "").strip()
        if not pid:
            return False
        try:
            sidebar_cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            return False
        if not os.path.isdir(sidebar_cwd):
            return False
        normalized_scope = sidebar_cwd.rstrip("/") or "/"
        if normalized_scope == self.scope_root:
            return False
        try:
            self.call_from_thread(self._apply_sidebar_scope_root, normalized_scope)
        except Exception:
            return False
        return True

    def _apply_sidebar_scope_root(self, new_scope_root: str) -> None:
        normalized_scope = new_scope_root.rstrip("/") or "/"
        if normalized_scope == self.scope_root:
            return
        self.scope_root = normalized_scope
        self._update_scope_subtitle()
        self._do_refresh_all()

    @work(thread=True, exclusive=True, group="refresh-active")
    def _refresh_active(self) -> None:
        if self._shutdown_started:
            return
        if self._sync_scope_root_from_sidebar():
            return
        now = time.time()
        if (
            now - self._last_refresh_active_at
            < self._refresh_foreground_active_interval
        ):
            return
        self._last_refresh_active_at = now
        scope_root = self._effective_scope_root()
        try:
            active = ActiveTmuxAdapter(self._tmux).list_active(scope_root)
            existing_inactive = [s for s in self._sessions if s.state == "inactive"]
            merged = self._merge_sessions(active + existing_inactive)
        except Exception:
            log.exception("Error collecting active sessions")
            return
        self.call_from_thread(self._apply_refreshed_sessions, merged)

    @work(thread=True, exclusive=True, group="refresh-all")
    def _refresh_all(self) -> None:
        if self._shutdown_started:
            return
        now = time.time()
        if now - self._last_refresh_all_at < self._refresh_foreground_all_interval:
            return
        self._last_refresh_all_at = now
        try:
            merged = self._collect_all_sessions()
        except Exception:
            log.exception("Error collecting all sessions")
            return
        self.call_from_thread(self._apply_refreshed_sessions, merged)

    @work(thread=True, exclusive=True, group="refresh-diff-stat")
    def _refresh_diff_stats(self) -> None:
        """Update diff_shortstat for each active session in the background."""
        if self._shutdown_started:
            return
        import subprocess

        updates: list[
            tuple[str, str, int, int, int]
        ] = []  # (session_id, badge, added, removed, files)
        for s in list(self._sessions):
            if not s.cwd or s.state != "active":
                continue
            badge = ""
            added = 0
            removed = 0
            file_count = 0
            try:
                result = subprocess.run(
                    ["git", "diff", "--shortstat"],
                    cwd=s.cwd,
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                out = result.stdout.strip()
                if out:
                    files = _re.search(r"(\d+) file[s]? changed", out)
                    ins = _re.search(r"(\d+) insertion", out)
                    dels = _re.search(r"(\d+) deletion", out)
                    file_count = int(files.group(1)) if files else 0
                    added = int(ins.group(1)) if ins else 0
                    removed = int(dels.group(1)) if dels else 0
                    parts: list[str] = []
                    if ins:
                        parts.append(f"+{ins.group(1)}")
                    if dels:
                        parts.append(f"−{dels.group(1)}")
                    if parts:
                        badge = "[" + " ".join(parts) + "]"
            except Exception:
                pass
            # Also check commits ahead of upstream
            if not badge:
                try:
                    ahead_result = subprocess.run(
                        ["git", "rev-list", "--count", "@{upstream}..HEAD"],
                        cwd=s.cwd,
                        capture_output=True,
                        text=True,
                        timeout=2,
                    )
                    n = ahead_result.stdout.strip()
                    if n and n != "0":
                        badge = f"[↑{n}]"
                except Exception:
                    pass
            updates.append((s.session_id, badge, added, removed, file_count))
        self.call_from_thread(self._apply_diff_stats, updates)

    def _apply_diff_stats(self, updates: list[tuple[str, str, int, int, int]]) -> None:
        for sid, badge, added, removed, file_count in updates:
            s = self._session_map.get(sid)
            if s is not None:
                s.diff_shortstat = badge[:7]
            self._session_diff_totals[sid] = (added, removed, file_count)
        self._update_table()

    @work(thread=True, group="health-check")
    def _run_health_check(self, session: AgentSession) -> None:
        """Probe pane health: capture baseline, send CR, poll 10x500ms, classify."""
        import time as _t

        pane_id = getattr(session, "tmux_pane_id", None) or session.tmux_pane
        if not pane_id:
            self.call_from_thread(
                self.notify,
                f"No pane ID for session {session.title[:20]}",
                severity="warning",
            )
            return

        try:
            baseline = self._tmux.capture_pane(pane_id)
        except Exception as exc:
            self.call_from_thread(
                self.notify, f"Health check failed: {exc}", severity="error"
            )
            return

        try:
            self._tmux.send_keys(pane_id, "")
        except Exception:
            pass

        baseline_text = baseline
        result_lines: list[str] = baseline_text.splitlines()
        for _ in range(10):
            _t.sleep(0.5)
            try:
                new_output = self._tmux.capture_pane(pane_id)
            except Exception:
                break
            result_lines = new_output.splitlines()
            if new_output != baseline_text:
                break

        pattern, confidence = _health_check_pattern(result_lines)
        session.status_confidence = confidence
        self.call_from_thread(self._update_table)
        severity_map = {
            "interactive_prompt": "information",
            "stdin_waiting": "warning",
            "known_tool": "information",
            "agent_loop": "information",
            "agent_asking": "warning",
            "test_running": "information",
            "build_running": "information",
            "git_operation": "information",
            "agent_done": "information",
            "error_state": "error",
            "rate_limited": "warning",
            "unknown": "warning",
        }
        message_map = {
            "interactive_prompt": "Session at interactive shell prompt",
            "stdin_waiting": "Session waiting for stdin input (y/n or confirmation)",
            "known_tool": "Session actively running a tool",
            "agent_loop": "Session in agent reasoning loop",
            "agent_asking": "Session appears to be asking a question",
            "test_running": "Session appears to be running tests",
            "build_running": "Session appears to be building or compiling",
            "git_operation": "Session appears to be running a git operation",
            "agent_done": "Session appears to have completed successfully",
            "error_state": "Session output indicates an error state",
            "rate_limited": "Session appears to be rate limited",
            "unknown": "Session state unknown — no recognizable pattern",
        }
        message = (
            f"{session.title[:20]}: {message_map.get(pattern, pattern)} "
            f"(confidence {confidence:.2f})"
        )
        severity = severity_map.get(pattern, "warning")
        _log_recovery(
            session_id=session.session_id,
            title=session.title or "",
            pattern=pattern,
            action=severity,
            auto=False,
        )
        if pattern in {
            "stdin_waiting",
            "agent_asking",
            "error_state",
            "rate_limited",
            "unknown",
        }:
            self.call_from_thread(
                self._flash_health_banner, message_map.get(pattern, pattern)
            )
        self.call_from_thread(self.notify, message, severity=severity)

    def _do_refresh_all(self) -> None:
        if self._shutdown_started:
            return
        self._refresh_all()

    def _collect_all_sessions(self) -> list[AgentSession]:
        all_sessions: list[AgentSession] = []
        scope_root = self._effective_scope_root()
        for adapter in self._adapters:
            try:
                all_sessions.extend(adapter.list_active(scope_root))
                all_sessions.extend(adapter.list_inactive(scope_root))
            except Exception:
                log.exception("Adapter error: %s", type(adapter).__name__)
        return self._merge_sessions(all_sessions)

    def _apply_refreshed_sessions(self, sessions: list[AgentSession]) -> None:
        self._cleanup_dismissed_active_ids(sessions)
        self._archive_stale_active_sessions(sessions)
        sessions = self._filter_archived_sessions(sessions)
        self._apply_quick_notes(sessions)
        self._apply_stall_status(sessions)
        self._notify_state_transitions(sessions)
        self._update_unseen_review(sessions)
        for s in sessions:
            prior = self._session_map.get(s.session_id)
            if prior is not None:
                s.diff_shortstat = prior.diff_shortstat
                if s.session_start_ts is None and prior.session_start_ts is not None:
                    s.session_start_ts = prior.session_start_ts
            if s.session_start_ts is None:
                session_file = self._session_file_path(s)
                if session_file:
                    s.session_start_ts = parse_session_start_time(session_file)
        self._sessions = sessions
        try:
            self.query_one(ResourceBar).update_stats(
                sessions,
                follow_mode=self._auto_follow,
                pivot_mode=self._pivot_mode,
            )
        except Exception:
            pass
        self._update_table()
        self._update_stats_bar()
        try:
            tab_bar = self.query_one(ProjectTabBar)
            tab_bar.update_tabs(sessions, self.scope_root)
            tab_bar.display = not self._pivot_mode
        except Exception:
            pass
        self._update_preview_border()

    # ------------------------------------------------------------------ #
    # Table update — sync, diff-based, zero-flicker                       #
    # ------------------------------------------------------------------ #

    def _update_table(self) -> None:
        """Sync diff-based table update. All DataTable mutations are synchronous,
        so this runs atomically in one event-loop turn — no flicker."""
        try:
            table = self.query_one("#session-table", DataTable)
        except Exception:
            return

        new_keys = self._compute_ordered_keys(self._sessions)
        new_map = {s.session_id: s for s in self._sessions}

        # --- check if structure (order/set) changed ---
        if new_keys == self._ordered_keys:
            # In-place cell updates only — absolutely no flicker
            for key in new_keys:
                if _is_separator_key(key):
                    continue
                s = new_map.get(key)
                if s is None:
                    continue
                cells = self._make_row_cells(s)
                col_keys = self._session_table_column_keys()
                for ck, cell in zip(col_keys, cells):
                    try:
                        table.update_cell(key, ck, cell, update_width=False)
                    except Exception:
                        pass
        else:
            # Structure changed: full rebuild (still sync, single repaint)
            prev_key: Optional[str] = None
            if self._selected_session:
                prev_key = self._selected_session.session_id

            table.clear()
            for key in new_keys:
                if _is_separator_key(key):
                    table.add_row(
                        *self._separator_row(self._separator_label_for_key(key)),
                        key=key,
                    )
                else:
                    s = new_map.get(key)
                    if s:
                        table.add_row(*self._make_row_cells(s), key=key)

            # Restore cursor position
            self._ordered_keys = new_keys
            self._restore_cursor(table, prev_key, new_keys)

        self._ordered_keys = new_keys
        self._session_map = new_map
        selected_before = set(self._broadcast_selected_ids)
        self._broadcast_selected_ids.intersection_update(set(new_map.keys()))
        if self._broadcast_selected_ids != selected_before:
            self._cancel_pending_broadcast()

        if (
            self._selected_session
            and self._selected_session.session_id not in self._ordered_keys
        ):
            self._selected_session = self._current_session()

        # Keep preview live for the selected active session.
        if self._selected_session and self._selected_session.state == "active":
            self._schedule_preview_update(self._selected_session)
        self._apply_auto_follow_cursor(table, new_keys, new_map)

    # ------------------------------------------------------------------ #
    # Cursor management                                                    #
    # ------------------------------------------------------------------ #

    def _apply_auto_follow_cursor(
        self,
        table: DataTable,
        ordered_keys: list[str],
        session_map: dict[str, AgentSession],
    ) -> None:
        if not self._auto_follow or not ordered_keys:
            return

        running_sessions = [
            session
            for session in self._sessions
            if session.state == "active"
            and session.status == "running"
            and session.session_id in session_map
        ]
        if not running_sessions:
            return

        def _activity_value(session: AgentSession) -> float:
            ts = session.last_activity_ts
            if ts is None:
                return 0.0
            try:
                value = float(ts)
            except (TypeError, ValueError):
                return 0.0
            return value if math.isfinite(value) else 0.0

        target = max(running_sessions, key=_activity_value, default=None)
        if target is None or target.session_id not in ordered_keys:
            return

        try:
            idx = ordered_keys.index(target.session_id)
            table.move_cursor(row=idx)
            self._selected_session = session_map.get(target.session_id)
            self._follow_target_session_id = target.session_id
        except Exception:
            pass

    def _restore_cursor(
        self, table: DataTable, prev_key: Optional[str], ordered_keys: list[str]
    ) -> None:
        """Restore cursor to prev_key row or first non-separator row."""
        if not ordered_keys:
            return
        target_idx: Optional[int] = None
        if prev_key and prev_key in ordered_keys:
            target_idx = ordered_keys.index(prev_key)
        if target_idx is None:
            target_idx = next(
                (i for i, k in enumerate(ordered_keys) if not _is_separator_key(k)), 0
            )
        try:
            table.move_cursor(row=target_idx)
        except Exception:
            pass

    def _current_session(self) -> Optional[AgentSession]:
        """Return the AgentSession at the current DataTable cursor."""
        try:
            table = self.query_one("#session-table", DataTable)
            idx = table.cursor_row
            if 0 <= idx < len(self._ordered_keys):
                key = self._ordered_keys[idx]
                if not _is_separator_key(key):
                    return self._session_map.get(key)
        except Exception:
            pass
        return None

    def _visible_sessions_for_export(self) -> list[AgentSession]:
        if self._ordered_keys and self._session_map:
            visible = [
                self._session_map[key]
                for key in self._ordered_keys
                if not _is_separator_key(key) and key in self._session_map
            ]
            if visible:
                return visible

        computed_keys = self._compute_ordered_keys(self._sessions)
        computed_map = {session.session_id: session for session in self._sessions}
        return [
            computed_map[key]
            for key in computed_keys
            if not _is_separator_key(key) and key in computed_map
        ]

    # ------------------------------------------------------------------ #
    # Event handlers                                                       #
    # ------------------------------------------------------------------ #

    def on_project_tab_bar_tab_changed(self, message: ProjectTabBar.TabChanged) -> None:
        self._active_project_root = message.project_root
        self._update_table()

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        """Update selected session and preview when cursor moves."""
        idx = event.cursor_row
        if 0 <= idx < len(self._ordered_keys):
            key = self._ordered_keys[idx]
            if _is_separator_key(key):
                # Skip separator in the direction of travel, not always downward.
                d = self._nav_direction
                new_idx = idx + d
                while 0 <= new_idx < len(self._ordered_keys) and _is_separator_key(
                    self._ordered_keys[new_idx]
                ):
                    new_idx += d
                if 0 <= new_idx < len(self._ordered_keys):
                    dest_key = self._ordered_keys[new_idx]
                    if not _is_separator_key(dest_key):
                        self._selected_session = self._session_map.get(dest_key)
                    try:
                        event.data_table.move_cursor(row=new_idx)
                    except Exception:
                        pass
                return
            self._selected_session = self._session_map.get(key)
            if self._selected_session:
                # Hovering over a row clears the unseen-review pulse for that session.
                self._unseen_review_ids.discard(self._selected_session.session_id)
            try:
                input_label = self.query_one("#input-label", Static)
                input_label.update(
                    f"[dim]→ {self._selected_session.display_title[:40]}[/dim]"
                    if self._selected_session
                    else ""
                )
            except Exception:
                pass
            if self._selected_session:
                self._schedule_preview_update(self._selected_session)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.data_table.id == "session-table":
            self.action_select_session()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "filter-input":
            self._filter_text = event.value
            self._update_table()
            self._update_subtitle()
            return
        if event.input.id == "session-input":
            self._update_slash_command_popup(event.value)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "session-input":
            return

        if self._slash_popup_visible and self._slash_matches:
            self._apply_selected_slash_command()
            return

        text = event.value.strip()
        event.input.clear()
        self._hide_slash_command_popup()

        if text.lower().startswith("#desc:"):
            target = self._selected_session
            if self._tag_input_session_id:
                tagged = self._session_map.get(self._tag_input_session_id)
                if tagged is None and self._selected_session is not None:
                    if self._selected_session.session_id == self._tag_input_session_id:
                        tagged = self._selected_session
                if tagged is not None:
                    target = tagged

            if target is None:
                self.notify("No selected session to describe", severity="warning")
                self._clear_tag_input_mode()
                return

            description = self._set_session_description(target, text[6:])
            _save_session_descriptions(self._session_descriptions)
            self._update_table()
            self._update_preview()
            if description:
                self.notify("Session description saved", severity="information")
            else:
                self.notify("Session description cleared", severity="information")
            self._clear_tag_input_mode()
            return

        if self._tag_input_session_id:
            target = self._session_map.get(self._tag_input_session_id)
            if target is None and self._selected_session is not None:
                if self._selected_session.session_id == self._tag_input_session_id:
                    target = self._selected_session

            if not text:
                self._clear_tag_input_mode()
                return

            if text.startswith("#"):
                if target is None:
                    self.notify("No selected session to tag", severity="warning")
                    self._clear_tag_input_mode()
                    return

                if self._add_session_tag(target, text):
                    _save_session_tags(self._session_tags)
                    self.notify(
                        f"Saved tags: {target.tags_str or '(none)'}",
                        severity="information",
                    )
                    self._update_table()
                else:
                    self.notify(
                        "Tag not added (empty tag or max 5 tags reached)",
                        severity="warning",
                    )
                self._clear_tag_input_mode()
                return

            self._clear_tag_input_mode()

        if not text:
            return
        if text.startswith("/"):
            self._push_command_history(text)
        s = self._selected_session
        if s is None or not s.tmux_pane:
            return
        try:
            actions.send_input(self._tmux, s.tmux_pane, text)
            self._push_input_history(s.session_id, text)
        except Exception:
            log.exception("send_input error")

    def _push_input_history(self, session_id: str, text: str) -> None:
        """Add text to per-session history, capping at _INPUT_HISTORY_CAP."""
        command = text.strip()
        if not command:
            return
        hist = self._input_history.setdefault(session_id, [])
        hist = _dedupe_recent_entries([*hist, command], _INPUT_HISTORY_CAP)
        self._input_history[session_id] = hist
        self._input_history_idx[session_id] = len(hist)
        self._input_history_dirty = True
        self._save_input_history()

    def _push_command_history(self, text: str) -> None:
        command = text.strip()
        if not command.startswith("/"):
            return
        self._command_history = _dedupe_recent_entries(
            [*self._command_history, command], _INPUT_HISTORY_CAP
        )
        self._command_history_dirty = True
        self._save_command_history()

    def _hide_slash_command_popup(self) -> None:
        self._slash_popup_visible = False
        self._slash_matches = []
        self._slash_selected_idx = 0
        try:
            popup = self.query_one("#slash-command-popup", Static)
            popup.update("")
            popup.remove_class("visible")
        except Exception:
            pass

    def _render_slash_command_popup(self) -> None:
        try:
            popup = self.query_one("#slash-command-popup", Static)
        except Exception:
            return
        if not self._slash_matches:
            self._hide_slash_command_popup()
            return

        text = Text()
        for idx, command in enumerate(self._slash_matches[:5]):
            if idx:
                text.append("\n")
            if idx == self._slash_selected_idx:
                text.append("▶ ", style="bold #58a6ff")
                text.append(command, style="bold #cdd9e5")
            else:
                text.append("  ", style="#636e7b")
                text.append(command, style="#adbac7")
        popup.update(text)
        popup.add_class("visible")
        self._slash_popup_visible = True

    def _update_slash_command_popup(self, value: str) -> None:
        current = value or ""
        if not current.startswith("/"):
            self._hide_slash_command_popup()
            return
        matches = [cmd for cmd in _SLASH_COMMANDS if cmd.startswith(current)]
        if not matches:
            self._hide_slash_command_popup()
            return
        if matches != self._slash_matches:
            self._slash_selected_idx = 0
        self._slash_matches = matches
        self._slash_selected_idx = max(
            0,
            min(self._slash_selected_idx, len(self._slash_matches) - 1),
        )
        self._render_slash_command_popup()

    def _apply_selected_slash_command(self) -> None:
        if not self._slash_matches:
            self._hide_slash_command_popup()
            return
        selected = self._slash_matches[self._slash_selected_idx]
        try:
            input_widget = self.query_one("#session-input", Input)
            input_widget.value = selected
            input_widget.cursor_position = len(selected)
        except Exception:
            pass
        self._hide_slash_command_popup()

    def _preview_context_focused(self) -> bool:
        if self._panel_tab != 0:
            return False
        try:
            focused = self.focused
        except Exception:
            return False
        if focused is None:
            return True
        focused_id = getattr(focused, "id", "")
        return focused_id in {"preview-panel", "preview-content"}

    def _session_file_path(self, session: AgentSession) -> str | None:
        return _extract_session_file_path(session.resume_command)

    def on_key(self, event) -> None:
        key = str(event.key)
        if self._macro_recording and key not in {"@", "at", "at_sign"}:
            if len(self._macro_keys) < 50:
                self._macro_keys.append(key)

        if key == "ctrl+x":
            import time as _t

            self._subagent_nav_armed_until = _t.time() + 1.2
            return

        if key in ("up", "down"):
            try:
                focused = self.focused
            except Exception:
                focused = None
            if focused and getattr(focused, "id", None) == "session-input":
                if self._slash_popup_visible and self._slash_matches:
                    delta = -1 if key == "up" else 1
                    self._slash_selected_idx = (self._slash_selected_idx + delta) % len(
                        self._slash_matches
                    )
                    self._render_slash_command_popup()
                    event.prevent_default()
                    event.stop()
                    return
                session = self._selected_session
                if session is not None:
                    sid = session.session_id
                    hist = self._input_history.get(sid, [])
                    if hist:
                        idx = self._input_history_idx.get(sid, len(hist))
                        if key == "up":
                            new_idx = max(0, idx - 1)
                            self._input_history_idx[sid] = new_idx
                            try:
                                self.query_one("#session-input", Input).value = hist[
                                    new_idx
                                ]
                            except Exception:
                                pass
                        elif key == "down":
                            new_idx = min(len(hist), idx + 1)
                            self._input_history_idx[sid] = new_idx
                            try:
                                self.query_one("#session-input", Input).value = (
                                    "" if new_idx == len(hist) else hist[new_idx]
                                )
                            except Exception:
                                pass
                event.prevent_default()
                event.stop()
                return

        if key == "tab":
            try:
                focused = self.focused
            except Exception:
                focused = None
            if (
                focused
                and getattr(focused, "id", None) == "session-input"
                and self._slash_popup_visible
                and self._slash_matches
            ):
                self._apply_selected_slash_command()
                event.prevent_default()
                event.stop()
                return

        if key == "ctrl+c":
            try:
                focused = self.focused
            except Exception:
                focused = None
            if focused and getattr(focused, "id", None) == "session-input":
                session = self._selected_session
                if session and session.tmux_pane:
                    try:
                        self._tmux.send_keys(session.tmux_pane, "C-c", enter=False)
                    except Exception:
                        log.exception("send ctrl+c error")
                event.prevent_default()
                event.stop()
                return

        if key in ("left", "right"):
            import time as _t

            if (
                _t.time() <= self._subagent_nav_armed_until
                and self._preview_context_focused()
            ):
                self._cycle_subagent_view(-1 if key == "left" else 1)
                event.prevent_default()
                event.stop()
                return

        if key == "enter":
            try:
                focused = self.focused
            except Exception:
                focused = None
            if (
                focused
                and getattr(focused, "id", None) == "session-input"
                and self._slash_popup_visible
                and self._slash_matches
            ):
                self._apply_selected_slash_command()
                event.prevent_default()
                event.stop()
                return
            try:
                table = self.query_one("#session-table", DataTable)
                if table.has_focus:
                    self.action_select_session()
                    event.stop()
                    return
            except Exception:
                pass

        if key == "escape":
            if self._slash_popup_visible:
                self._hide_slash_command_popup()
                event.prevent_default()
                event.stop()
                return
            if self._broadcast_confirm_pending:
                self._cancel_pending_broadcast()
                event.prevent_default()
                event.stop()
                return
            if self._filter_visible:
                try:
                    fi = self.query_one("#filter-input", Input)
                    if fi.has_focus:
                        self.action_toggle_filter()
                        event.stop()
                except Exception:
                    pass

    async def _replay_macro_keys(self, keys: list[str]) -> None:
        for key in keys:
            await asyncio.sleep(0.05)
            try:
                self.simulate_key(key)
            except Exception:
                log.exception("macro replay failed for key %s", key)

    def action_toggle_macro_record(self) -> None:
        if not self._macro_recording:
            self._macro_recording = True
            self._macro_keys = []
            self.notify("Recording macro... (@ to stop)")
            self._update_subtitle()
            return

        self._macro_recording = False
        recorded = list(self._macro_keys)
        self._saved_macros["last"] = recorded
        self.notify(f"Macro saved: {len(recorded)} keys")
        self._update_subtitle()

    def action_replay_macro(self) -> None:
        keys = list(self._saved_macros.get("last", []))
        if not keys:
            self.notify("No macro recorded")
            return

        self.notify(f"Replaying {len(keys)} keys...")
        asyncio.create_task(self._replay_macro_keys(keys))

    # ------------------------------------------------------------------ #
    # Preview panel                                                        #
    # ------------------------------------------------------------------ #

    def _update_preview_border(self) -> None:
        """Update right-panel border colour based on selected session state."""
        try:
            panel = self.query_one("#right-panel")
        except Exception:
            return
        s = self._selected_session
        if s is None:
            panel.styles.border = ("round", "#444c56")
        elif s.status in ("stalled",):
            panel.styles.border = ("round", "#d29922")  # amber
        elif s.state == "active" and s.status not in ("idle", "offline", "unknown"):
            panel.styles.border = ("round", "#316dca")  # blue
        elif s.state != "active" or s.status in ("idle", "offline"):
            panel.styles.border = ("round", "#3d4451")  # dim
        else:
            panel.styles.border = ("round", "#444c56")

    def _update_diff_panel(self) -> None:
        """Populate #diff-content with enriched git diff HEAD output."""
        session = self._selected_session
        try:
            diff_widget = self.query_one("#diff-content", Static)
        except Exception:
            return
        if not session or not session.cwd:
            self._diff_hunk_positions = []
            self._diff_hunk_idx = 0
            self._diff_hunk_session_id = ""
            self._diff_hunk_raw_hash = 0
            diff_widget.update(Text("[no session selected]", style="#636e7b"))
            return
        try:
            import subprocess as _sp

            result = _sp.run(
                ["git", "diff", "HEAD"],
                cwd=session.cwd,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                message = (result.stderr or "").strip() or "git diff failed"
                self._diff_hunk_positions = []
                self._diff_hunk_idx = 0
                self._diff_hunk_session_id = ""
                self._diff_hunk_raw_hash = 0
                diff_widget.update(Text(f"[diff error: {message}]", style="#f85149"))
                return

            raw = result.stdout
            if not raw.strip():
                self._session_diff_totals[session.session_id] = (0, 0, 0)
                self._diff_hunk_positions = []
                self._diff_hunk_idx = 0
                self._diff_hunk_session_id = session.session_id
                self._diff_hunk_raw_hash = 0
                diff_widget.update(Text("No uncommitted changes", style="#636e7b"))
                return

            header = _render_diff_header(raw)
            rendered = Text()
            if header.plain:
                rendered.append_text(header)
                rendered.append("\n", style="#636e7b")
            rendered.append_text(_parse_diff_colored(raw))
            diff_widget.update(rendered)

            total_added, total_removed, file_breakdown = _parse_diff_stats(raw)
            self._session_diff_totals[session.session_id] = (
                total_added,
                total_removed,
                len(file_breakdown),
            )

            header_line_count = header.plain.count("\n") + 1 if header.plain else 0
            hunk_positions = [
                header_line_count + idx for idx in _diff_hunk_line_positions(raw)
            ]
            raw_hash = hash(raw)
            if (
                session.session_id != self._diff_hunk_session_id
                or raw_hash != self._diff_hunk_raw_hash
            ):
                self._diff_hunk_idx = -1
            elif self._diff_hunk_idx >= len(hunk_positions):
                self._diff_hunk_idx = len(hunk_positions) - 1
            self._diff_hunk_positions = hunk_positions
            self._diff_hunk_session_id = session.session_id
            self._diff_hunk_raw_hash = raw_hash
        except Exception as exc:
            self._diff_hunk_positions = []
            self._diff_hunk_idx = 0
            self._diff_hunk_session_id = ""
            self._diff_hunk_raw_hash = 0
            diff_widget.update(Text(f"[diff error: {exc}]", style="#f85149"))

    def _update_info_panel(self) -> None:
        """Populate #info-content with PR status for the selected session."""
        session = self._selected_session
        try:
            info_widget = self.query_one("#info-content", Static)
        except Exception:
            return
        if not session or not session.cwd:
            self._info_panel_last_url = ""
            info_widget.update(Text("[no session selected]", style="#636e7b"))
            return
        try:
            prs = self._github_adapter.list_prs(session.cwd)
        except Exception as exc:
            self._info_panel_last_url = ""
            info_widget.update(Text(f"[PR fetch error: {exc}]", style="#f85149"))
            return
        if not prs:
            self._info_panel_last_url = ""
            info_widget.update(Text("[no open PRs]", style="#636e7b"))
            return

        primary_pr = prs[0]
        self._info_panel_last_url = primary_pr.url
        pr_data: dict = {}
        branch_ref = (session.branch or "").strip()
        if branch_ref:
            pr_data = fetch_pr_details(branch_ref, session.cwd)
        if not pr_data:
            pr_data = fetch_pr_details(str(primary_pr.number), session.cwd)

        if pr_data:
            if not pr_data.get("url"):
                pr_data["url"] = primary_pr.url
            info_widget.update(_render_pr_panel_enhanced(pr_data))
            self._info_panel_last_url = str(pr_data.get("url") or primary_pr.url or "")
            return

        t = Text()
        for pr in prs:
            draft_tag = " [DRAFT]" if pr.draft else ""
            ci_glyph = pr.ci_glyph
            t.append(
                f"{ci_glyph} ",
                style=(
                    "#3fb950"
                    if ci_glyph == "✔"
                    else "#f85149"
                    if ci_glyph == "✘"
                    else "#d4a72c"
                ),
            )
            t.append(f"#{pr.number}", style="bold #6cb6ff")
            t.append(f" {pr.title[:45]}", style="#adbac7")
            t.append(draft_tag, style="#636e7b")
            t.append(f"  rev:{pr.review_glyph}\n", style="#636e7b")
        info_widget.update(t)
        self._info_panel_last_url = prs[0].url if prs else ""

    def _apply_panel_tab(self, tab_idx: int) -> None:
        """Switch visible right-panel tab and update border title."""
        self._panel_tab = tab_idx % len(self._RIGHT_PANEL_TABS)
        panel_ids = ["preview-panel", "diff-panel", "info-panel"]
        for i, panel_id in enumerate(panel_ids):
            try:
                container = self.query_one(f"#{panel_id}", ScrollableContainer)
                container.display = i == self._panel_tab
            except Exception:
                pass

        try:
            status_bar = self.query_one("#preview-status", Static)
            status_bar.display = self._panel_tab == 0
        except Exception:
            pass

        tab_label = self._RIGHT_PANEL_TABS[self._panel_tab]
        try:
            panel = self.query_one("#right-panel")
            if self._selected_session:
                existing = panel.border_title or ""
                for tab in self._RIGHT_PANEL_TABS:
                    existing = existing.replace(f" [{tab}]", "")
                panel.border_title = f"{existing.rstrip()} [{tab_label}]".strip()
            else:
                panel.border_title = tab_label
        except Exception:
            pass
        if self._panel_tab == 1:
            self.call_later(self._update_diff_panel)
        if self._panel_tab == 2:
            self.call_later(self._update_info_panel)

    def _subagent_status_label(self, session: AgentSession) -> str:
        if session.state == "active" and session.status not in {"offline", "idle"}:
            return "running"
        if session.status in {"stalled"}:
            return "failed"
        return "done"

    def _subagent_rows_for_session(
        self, session: AgentSession
    ) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for idx, child_id in enumerate(session.child_session_ids):
            child = self._session_map.get(child_id)
            if child is None:
                continue

            child_file = self._session_file_path(child)
            output_text = ""
            last_line = ""
            child_mtime = child.last_activity_ts or 0.0
            if child_file and os.path.exists(child_file):
                output_text, last_line, _ = _extract_latest_assistant_turn_from_file(
                    child_file, max_lines=200
                )
                try:
                    child_mtime = os.stat(child_file).st_mtime
                except OSError:
                    child_mtime = child.last_activity_ts or 0.0

            if not last_line:
                last_line = "[no output yet]"

            identifier = child.title.strip() or child.session_id[:12]
            rows.append(
                {
                    "index": idx,
                    "session_id": child.session_id,
                    "id": self._truncate_status_field(identifier, max_len=24),
                    "status": self._subagent_status_label(child),
                    "last_line": last_line,
                    "output": output_text.strip(),
                    "mtime": child_mtime,
                }
            )
        return rows

    def _cycle_subagent_view(self, direction: int) -> None:
        session = self._selected_session
        if session is None:
            return
        subagents = self._subagent_rows_for_session(session)
        count = len(subagents)
        if count == 0:
            return

        current = self._selected_subagent_index.get(session.session_id, -1)
        if direction < 0:
            if current == -1:
                new_idx = count - 1
            elif current == 0:
                new_idx = -1
            else:
                new_idx = current - 1
        else:
            if current == -1:
                new_idx = 0
            elif current >= count - 1:
                new_idx = -1
            else:
                new_idx = current + 1

        self._selected_subagent_index[session.session_id] = new_idx
        self._update_preview()

    def action_subagent_prev(self) -> None:
        if self._preview_context_focused():
            self._cycle_subagent_view(-1)

    def action_subagent_next(self) -> None:
        if self._preview_context_focused():
            self._cycle_subagent_view(1)

    def _schedule_preview_update(self, session: AgentSession) -> None:
        self._preview_pending_session_id = session.session_id
        if self._preview_debounce_handle is not None:
            try:
                self._preview_debounce_handle.stop()
            except Exception:
                try:
                    cancel = getattr(self._preview_debounce_handle, "cancel", None)
                    if callable(cancel):
                        cancel()
                except Exception:
                    pass
            self._preview_debounce_handle = None
        self._preview_debounce_handle = self.set_timer(0.15, self._do_preview_update)

    def _do_preview_update(self) -> None:
        self._preview_debounce_handle = None
        pending_id = self._preview_pending_session_id
        if not pending_id:
            return
        selected = self._selected_session
        # Only render if the pending session is still the selected one
        if selected is None or selected.session_id != pending_id:
            return
        self._update_preview_worker(pending_id)

    @work(thread=True, exclusive=False, group="preview-debounce")
    def _update_preview_worker(self, expected_session_id: str = "") -> None:
        if self._shutdown_started:
            return
        current_id = getattr(self, "_preview_pending_session_id", None)
        if expected_session_id and current_id and expected_session_id != current_id:
            return
        s = self._selected_session
        if expected_session_id and (s is None or s.session_id != expected_session_id):
            return
        if s is None:
            self.call_from_thread(self._update_preview)
            return
        if not (s.state == "active" and s.tmux_pane and s.harness == "omp"):
            self.call_from_thread(self._update_preview)
            return

        session_file = _extract_session_file_path(s.resume_command)
        if not session_file or not os.path.exists(session_file):
            self.call_from_thread(self._update_preview)
            return

        try:
            file_stat = os.stat(session_file)
        except OSError:
            self.call_from_thread(self._update_preview)
            return

        subagent_rows = self._subagent_rows_for_session(s)
        selected_idx = self._selected_subagent_index.get(s.session_id, -1)
        if selected_idx >= len(subagent_rows):
            selected_idx = -1
            self._selected_subagent_index[s.session_id] = -1

        selected_output = ""
        selected_label = ""
        if 0 <= selected_idx < len(subagent_rows):
            selected_row = subagent_rows[selected_idx]
            selected_output = str(selected_row.get("output") or "")
            selected_label = str(selected_row.get("id") or "subagent")
        preview_max_lines = self._preview_max_lines_setting()

        def _mtime_float(value: object) -> float:
            if isinstance(value, (int, float, str)):
                try:
                    return float(value)
                except ValueError:
                    return 0.0
            return 0.0

        subagent_key = tuple(
            (
                str(row.get("session_id") or ""),
                str(row.get("status") or ""),
                _mtime_float(row.get("mtime")),
            )
            for row in subagent_rows
        )
        preview_render_key: tuple[object, ...] = (
            s.session_id,
            file_stat.st_mtime,
            file_stat.st_size,
            selected_idx,
            s.last_activity_ts,
            subagent_key,
            preview_max_lines,
        )
        if preview_render_key == self._preview_last_render_key:
            return

        rendered = _render_active_preview(
            session_file,
            subagent_rows=subagent_rows,
            selected_subagent_index=selected_idx,
            selected_subagent_label=selected_label,
            selected_subagent_output=selected_output,
            session_model=s.model,
            session_role=s.role,
            session_branch=s.branch,
            session_context_pct=s.context_usage_pct,
            session_elapsed=s.elapsed_str,
            session_last_activity_ts=s.last_activity_ts,
            session_diff_stats=self._session_diff_totals.get(s.session_id),
            preview_max_lines=preview_max_lines,
        )
        branch_part = s.branch if s.branch else ""
        role_label, _ = s.role_rich
        panel_title = (
            f"{branch_part} — {role_label.strip()}"
            if branch_part
            else role_label.strip() or ""
        )
        status_line = self._preview_status_line(s)
        self.call_from_thread(
            self._apply_worker_preview,
            s.session_id,
            rendered,
            preview_render_key,
            panel_title,
            status_line,
        )

    def _apply_worker_preview(
        self,
        session_id: str,
        rendered: Text,
        preview_render_key: tuple[object, ...],
        panel_title: str,
        status_line: str,
    ) -> None:
        s = self._selected_session
        if s is None or s.session_id != session_id:
            return
        try:
            preview = self.query_one("#preview-content", Static)
            preview_status = self.query_one("#preview-status", Static)
            panel = self.query_one("#right-panel")
        except Exception:
            return
        panel.border_title = panel_title
        preview_status.update(status_line)
        self._preview_last_render_key = preview_render_key
        preview.update(rendered)
        self._apply_panel_tab(self._panel_tab)
        self._update_preview_border()

    def _update_preview(self) -> None:
        session = self._selected_session
        if session:
            saved_tab = self._panel_tab_state.get(session.session_id, 0)
            if not 0 <= saved_tab < len(self._RIGHT_PANEL_TABS):
                saved_tab = 0
                self._panel_tab_state[session.session_id] = 0
            if saved_tab != self._panel_tab:
                self._apply_panel_tab(saved_tab)
        try:
            preview = self.query_one("#preview-content", Static)
            preview_status = self.query_one("#preview-status", Static)
            panel = self.query_one("#right-panel")
        except Exception:
            return
        s = self._selected_session
        should_snap = False
        if s is None:
            panel.border_title = ""
            preview.update("")
            self._preview_last_render_key = None
            preview_status.update("")
        else:
            branch_part = s.branch if s.branch else ""
            role_label, _ = s.role_rich
            if branch_part:
                panel.border_title = f"{branch_part} — {role_label.strip()}"
            else:
                panel.border_title = role_label.strip() or ""
            preview_status.update(self._preview_status_line(s))

            should_snap = True
            if s.state == "active" and s.tmux_pane:
                session_file = None
                if s.harness == "omp":
                    session_file = _extract_session_file_path(s.resume_command)

                if session_file and os.path.exists(session_file):
                    file_stat = os.stat(session_file)
                    subagent_rows = self._subagent_rows_for_session(s)
                    selected_idx = self._selected_subagent_index.get(s.session_id, -1)
                    if selected_idx >= len(subagent_rows):
                        selected_idx = -1
                        self._selected_subagent_index[s.session_id] = -1

                    selected_output = ""
                    selected_label = ""
                    if 0 <= selected_idx < len(subagent_rows):
                        selected_row = subagent_rows[selected_idx]
                        selected_output = str(selected_row.get("output") or "")
                        selected_label = str(selected_row.get("id") or "subagent")
                    preview_max_lines = self._preview_max_lines_setting()

                    def _mtime_float(value: object) -> float:
                        if isinstance(value, (int, float, str)):
                            try:
                                return float(value)
                            except ValueError:
                                return 0.0
                        return 0.0

                    subagent_key = tuple(
                        (
                            str(row.get("session_id") or ""),
                            str(row.get("status") or ""),
                            _mtime_float(row.get("mtime")),
                        )
                        for row in subagent_rows
                    )
                    preview_render_key: tuple[object, ...] = (
                        s.session_id,
                        file_stat.st_mtime,
                        file_stat.st_size,
                        selected_idx,
                        s.last_activity_ts,
                        subagent_key,
                        preview_max_lines,
                    )
                    if preview_render_key != self._preview_last_render_key:
                        self._preview_last_render_key = preview_render_key
                        preview.update(
                            _render_active_preview(
                                session_file,
                                subagent_rows=subagent_rows,
                                selected_subagent_index=selected_idx,
                                selected_subagent_label=selected_label,
                                selected_subagent_output=selected_output,
                                session_model=s.model,
                                session_role=s.role,
                                session_branch=s.branch,
                                session_context_pct=s.context_usage_pct,
                                session_elapsed=s.elapsed_str,
                                session_last_activity_ts=s.last_activity_ts,
                                session_diff_stats=self._session_diff_totals.get(
                                    s.session_id
                                ),
                                preview_max_lines=preview_max_lines,
                            )
                        )
                    should_snap = False
                else:
                    try:
                        raw = self._tmux.capture_pane(s.tmux_pane, lines=200)
                        cleaned = _sanitize_preview_ansi(raw)
                        pane_render_key: tuple[object, ...] = (s.session_id, cleaned)
                        if pane_render_key == self._preview_last_render_key:
                            should_snap = False
                        else:
                            self._preview_last_render_key = pane_render_key
                            try:
                                from rich.text import Text as RichText

                                preview.update(
                                    RichText.from_ansi(cleaned)
                                    if cleaned
                                    else Text("[empty pane]", style="#636e7b")
                                )
                            except Exception:
                                preview.update(cleaned or "[empty pane]")
                    except Exception:
                        self._preview_last_render_key = None
                        preview.update(Text("[preview unavailable]", style="#636e7b"))
            else:
                self._preview_last_render_key = None
                # Metadata view for inactive sessions
                lines: list[Text] = []

                def row(label: str, value: str, style: str = "#adbac7") -> None:
                    t = Text()
                    t.append(f"{label:<10}", style="bold #636e7b")
                    t.append(value, style=style)
                    lines.append(t)

                label_txt, status_style = s.status_rich
                row("Status:", label_txt, status_style)
                row("Harness:", s.harness_label)
                row("CWD:", s.cwd, "#adbac7")
                if s.branch:
                    row("Branch:", s.branch, "italic #daaa3f")
                row("Age:", s.age_str, "#636e7b")
                row("ID:", s.session_id[:16], "#636e7b")
                if s.resume_command:
                    row("Resume:", s.resume_command, "#539bf5")
                description_text = (s.description or "").strip()
                if description_text:
                    lines.append(Text(""))
                    lines.append(Text("Description", style="bold #636e7b"))
                    for raw_line in description_text.splitlines():
                        line = raw_line.strip()
                        if not line:
                            continue
                        lines.append(Text(f"  {line[:100]}", style="#adbac7"))

                jsonl_path = _extract_session_file_path(s.resume_command)
                if jsonl_path:
                    last_msgs = _extract_last_user_messages(jsonl_path, n=2)
                    if last_msgs:
                        lines.append(Text(""))
                        for i, msg_text in enumerate(last_msgs):
                            t = Text()
                            t.append(f"[msg-{i + 1}] ", style="bold #444c56")
                            t.append(msg_text[:80], style="#636e7b")
                            lines.append(t)

                combined = Text("\n").join(lines)
                preview.update(combined)

        if should_snap:
            # Defer scroll-to-bottom so it runs after Textual has reflowed the
            # Static widget's new content height.
            def _snap() -> None:
                try:
                    self.query_one("#preview-panel", ScrollableContainer).scroll_end(
                        animate=False
                    )
                except Exception:
                    pass

            self.call_after_refresh(_snap)

        self._apply_panel_tab(self._panel_tab)
        self._update_preview_border()

    # ------------------------------------------------------------------ #
    # Actions                                                              #
    # ------------------------------------------------------------------ #

    def action_move_down(self) -> None:
        try:
            self._nav_direction = 1
            t = self.query_one("#session-table", DataTable)
            cur_idx = t.cursor_row
            dest_idx = cur_idx + 1
            while dest_idx < len(self._ordered_keys) and _is_separator_key(
                self._ordered_keys[dest_idx]
            ):
                dest_idx += 1
            if 0 <= dest_idx < len(self._ordered_keys):
                dest_key = self._ordered_keys[dest_idx]
                if not _is_separator_key(dest_key):
                    self._selected_session = self._session_map.get(dest_key)
            t.move_cursor(row=dest_idx)
        except Exception:
            pass

    def action_move_up(self) -> None:
        try:
            self._nav_direction = -1
            t = self.query_one("#session-table", DataTable)
            cur_idx = t.cursor_row
            dest_idx = cur_idx - 1
            while dest_idx >= 0 and _is_separator_key(self._ordered_keys[dest_idx]):
                dest_idx -= 1
            if 0 <= dest_idx < len(self._ordered_keys):
                dest_key = self._ordered_keys[dest_idx]
                if not _is_separator_key(dest_key):
                    self._selected_session = self._session_map.get(dest_key)
            t.move_cursor(row=dest_idx)
        except Exception:
            pass

    def action_preview_scroll_up(self) -> None:
        """Scroll the preview panel up."""
        try:
            self.query_one("#preview-panel", ScrollableContainer).scroll_relative(y=-5)
        except Exception:
            pass

    def action_preview_scroll_down(self) -> None:
        """Scroll the preview panel down."""
        try:
            self.query_one("#preview-panel", ScrollableContainer).scroll_relative(y=5)
        except Exception:
            pass

    def action_jump_top(self) -> None:
        try:
            t = self.query_one("#session-table", DataTable)
            first = next(
                (
                    i
                    for i, k in enumerate(self._ordered_keys)
                    if not _is_separator_key(k)
                ),
                0,
            )
            t.move_cursor(row=first)
        except Exception:
            pass

    def action_jump_bottom(self) -> None:
        try:
            t = self.query_one("#session-table", DataTable)
            last = next(
                (
                    i
                    for i, k in enumerate(reversed(self._ordered_keys))
                    if not _is_separator_key(k)
                ),
                0,
            )
            last = len(self._ordered_keys) - 1 - last
            t.move_cursor(row=last)
        except Exception:
            pass

    def action_toggle_bookmark(self) -> None:
        session = self._current_session()
        if session is None:
            return

        session_id = session.session_id
        title = session.display_title
        if session_id in self._bookmarks:
            self._bookmarks.remove(session_id)
            self.notify(f"Bookmark removed: {title}")
        else:
            self._bookmarks.add(session_id)
            self.notify(f"Bookmarked: {title}")

        _save_bookmarks(self._bookmarks)
        self._update_table()

    def action_next_bookmark(self) -> None:
        bookmark_rows = [
            idx
            for idx, key in enumerate(self._ordered_keys)
            if not _is_separator_key(key)
            and key in self._bookmarks
            and key in self._session_map
        ]
        if not bookmark_rows:
            self.notify("No bookmarks", severity="information")
            return

        try:
            table = self.query_one("#session-table", DataTable)
            current_row = table.cursor_row
        except Exception:
            return

        target_row = next(
            (row for row in bookmark_rows if row > current_row), bookmark_rows[0]
        )
        self._nav_direction = 1
        target_key = self._ordered_keys[target_row]
        self._selected_session = self._session_map.get(target_key)
        try:
            table.move_cursor(row=target_row)
        except Exception:
            pass

    def _focus_session_input(self) -> None:
        """Focus inline input when available."""
        try:
            self.query_one("#session-input", Input).focus()
        except Exception:
            pass

    def action_toggle_multi_select(self) -> None:
        if not self._is_table_focused():
            return
        session = self._current_session()
        if session is None:
            return
        updated = set(self._broadcast_selected_ids)
        if session.session_id in updated:
            updated.remove(session.session_id)
        else:
            updated.add(session.session_id)
        self._set_broadcast_selection(updated)
        self._update_table()

    def action_broadcast_selected(self) -> None:
        if not self._is_table_focused():
            return
        if not self._broadcast_selected_ids:
            return
        try:
            input_widget = self.query_one("#session-input", Input)
        except Exception:
            return
        text = input_widget.value.strip()
        if not text:
            return

        targets = self._broadcast_selected_targets()
        if not targets:
            return
        n = len(targets)

        if n > _BROADCAST_CONFIRM_THRESHOLD:
            if not self._broadcast_confirm_pending:
                self._arm_pending_broadcast(text)
                preview = text[:40]
                self.notify(
                    f"Broadcast to {n} sessions: '{preview}' — press B again to confirm",
                    severity="warning",
                )
                return
            text = self._broadcast_confirm_msg or text

        sent_to = actions.broadcast_input(self._tmux, targets, text)
        input_widget.clear()
        self._cancel_pending_broadcast()
        try:
            import json as _j
            import time as _t

            entry = {"ts": _t.time(), "message": text, "count": n}
            _BROADCAST_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(_BROADCAST_HISTORY_FILE, "a", encoding="utf-8") as f:
                f.write(_j.dumps(entry) + "\n")
        except Exception:
            pass
        self.notify(f"Broadcast sent to {len(sent_to)}/{n} sessions")

    def action_broadcast_template(self) -> None:
        def _handle_template(template_text: Optional[str]) -> None:
            if not template_text:
                return
            try:
                input_widget = self.query_one("#session-input", Input)
            except Exception:
                return
            input_widget.value = template_text
            if hasattr(input_widget, "cursor_position"):
                input_widget.cursor_position = len(template_text)

            if not self._broadcast_selected_ids:
                running_targets = self._running_broadcast_targets()
                if running_targets:
                    self._set_broadcast_selection(
                        {session.session_id for session in running_targets}
                    )
                    self._update_table()

            if not self._broadcast_selected_ids:
                self.notify(
                    "No running sessions available for broadcast", severity="warning"
                )
                return

            try:
                self.query_one("#session-table", DataTable).focus()
            except Exception:
                pass
            self.action_broadcast_selected()

        self.push_screen(BroadcastTemplateScreen(), callback=_handle_template)

    def action_broadcast_template_picker(self) -> None:
        self.action_broadcast_template()

    def action_column_picker(self) -> None:
        def _handle(config: Optional[dict[str, bool]]) -> None:
            if not isinstance(config, dict):
                return
            self._apply_column_config(config)

        self.push_screen(ColumnPickerScreen(self._column_config), callback=_handle)

    def action_broadcast_all_running(self) -> None:
        running_targets = self._running_broadcast_targets()
        if not running_targets:
            self.notify("No running sessions available", severity="warning")
            return
        self._set_broadcast_selection(
            {session.session_id for session in running_targets}
        )
        self._update_table()
        self._focus_session_input()
        self.notify(f"Selected {len(running_targets)} running session(s) for broadcast")

    def action_edit_description(self) -> None:
        if not self._is_table_focused():
            return
        session = self._current_session()
        if session is None:
            return
        try:
            input_widget = self.query_one("#session-input", Input)
        except Exception:
            return

        current_description = (session.description or "").strip()
        input_widget.placeholder = "Set description as #desc:TEXT"
        input_widget.value = (
            f"#desc:{current_description}" if current_description else "#desc:"
        )
        input_widget.cursor_position = len(input_widget.value)
        input_widget.focus()
        self.notify("Submit #desc:TEXT to save description", severity="information")

    def action_save_quick_note(self) -> None:
        if not self._is_table_focused():
            return
        session = self._current_session()
        if session is None:
            return
        try:
            input_widget = self.query_one("#session-input", Input)
        except Exception:
            return
        note = input_widget.value
        input_widget.clear()
        self._set_quick_note(session, note)
        self._save_quick_notes()
        self._update_table()

    def action_tag_session(self) -> None:
        if not self._is_table_focused():
            return
        session = self._current_session()
        if session is None:
            return
        try:
            input_widget = self.query_one("#session-input", Input)
        except Exception:
            return

        suggestion = _TAG_SUGGESTIONS[self._tag_cycle_index % len(_TAG_SUGGESTIONS)]
        self._tag_cycle_index += 1
        self._tag_input_session_id = session.session_id
        input_widget.placeholder = "Add tag as #tag (max 20 chars, up to 5 tags)"
        input_widget.value = f"#{suggestion}"
        input_widget.cursor_position = len(input_widget.value)
        input_widget.focus()
        self.notify(
            f"Current tags: {session.tags_str or '(none)'} | submit #tag to add",
            severity="information",
        )

    def action_history_search(self) -> None:
        """Open an in-app history picker for the current session."""
        session = self._selected_session
        if not session:
            return
        sid = session.session_id
        hist = self._input_history.get(sid, [])
        if not hist:
            self.notify("No history for this session", severity="information")
            return

        recent_history = list(reversed(hist[-10:]))

        def _handle_history_choice(choice: Optional[str]) -> None:
            if not choice:
                return
            self._fill_session_input(choice)

        self.push_screen(
            HistoryPickerScreen(recent_history), callback=_handle_history_choice
        )

    def action_select_session(self) -> None:
        s = self._current_session()
        if s is None:
            return
        try:
            if s.state == "active":
                actions.teleport(self._tmux, s)
            else:
                current = self._tmux.get_current_session() or ""
                actions.resume(self._tmux, s, current)
        except Exception:
            log.exception("action_select_session error")
        self._focus_session_input()

    def action_open_or_pr(self) -> None:
        """o key: open PR when available, otherwise open selected session window."""
        if self._panel_tab == 2:
            self.action_open_pr_browser()
            return

        session = self._selected_session
        if session and session.cwd:
            try:
                prs = self._github_adapter.list_prs(session.cwd)
            except Exception:
                prs = []
            if prs:
                self._info_panel_last_url = prs[0].url
                self.action_open_pr_browser()
                return
        self.action_open_session_window()

    def action_open_session_window(self) -> None:
        """Open or resume selected session in a tmux window and focus it."""
        session = self._selected_session
        if session is None:
            return
        current = self._tmux.get_current_session() or ""
        try:
            if session.state == "active":
                actions.teleport(self._tmux, session)
            else:
                actions.resume(self._tmux, session, current)
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def action_open_pr_browser(self) -> None:
        """Open the selected session PR URL in the browser."""
        url = getattr(self, "_info_panel_last_url", "")
        if not url:
            session = self._selected_session
            if session and session.cwd:
                try:
                    prs = self._github_adapter.list_prs(session.cwd)
                except Exception:
                    prs = []
                if prs:
                    url = prs[0].url
                    self._info_panel_last_url = url
        if not url:
            self.notify("No PR URL available", severity="warning")
            return
        import subprocess as _sp

        try:
            _sp.Popen(["xdg-open", url], start_new_session=True)
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def _palette_dispatch(self, command: str) -> None:
        """Execute a named command from the command palette."""
        if command.startswith("recent: /"):
            recent_command = command.removeprefix("recent: ").strip()
            self.call_after_refresh(
                lambda c=recent_command: self._fill_session_input(c)
            )
            return

        dispatch: dict[str, Callable[[], None]] = {
            "spawn": self.action_new_session,
            "kill all stalled": self._kill_all_stalled,
            "prune worktrees": self._open_prune_screen,
            "show recovery log": self.action_open_recovery_log,
            "show archive": self.action_open_archive,
            "export sessions": self.action_export_sessions,
            "broadcast all running": self.action_broadcast_all_running,
            "set model": self._palette_set_model_placeholder,
            "diff session": lambda: self._apply_panel_tab(1),
            "template": self.action_open_templates,
            "new worktree": self.action_open_worktree_screen,
            "Git: fetch": self.action_git_fetch,
            "Git: push": self.action_git_push,
            "Git: log": self.action_git_log,
        }
        fn = dispatch.get(command)
        if fn is None:
            self.notify(f"Unknown command: {command}", severity="warning")
            return
        self.call_after_refresh(fn)

    def _palette_commands(self) -> list[tuple[str, str]]:
        commands = list(AgentsViewCommandProvider.BASE_COMMANDS)
        for command in reversed(self._command_history[-10:]):
            commands.append((f"recent: {command}", "Insert recent slash command"))
        return commands

    def _fill_session_input(self, value: str) -> None:
        try:
            input_widget = self.query_one("#session-input", Input)
        except Exception:
            return
        input_widget.value = value
        if hasattr(input_widget, "cursor_position"):
            input_widget.cursor_position = len(value)
        self._update_slash_command_popup(value)
        input_widget.focus()

    def _palette_set_model_placeholder(self) -> None:
        """Placeholder for the future set-model command."""
        self.notify("Set model is not implemented yet", severity="information")

    def _kill_all_stalled(self) -> None:
        """Kill all sessions with status == stalled."""
        killed = 0
        for session in self._sessions:
            pane_id = getattr(session, "tmux_pane_id", None) or session.tmux_pane
            if session.status != "stalled" or not pane_id:
                continue
            try:
                self._tmux.send_keys(pane_id, "q", enter=True)
                killed += 1
            except Exception:
                pass
        self.notify(f"Sent kill signal to {killed} stalled session(s)")

    def _open_prune_screen(self) -> None:
        """Open the prune worktrees wizard for the current scope."""
        import os as _os

        try:
            scope_root = self._effective_scope_root()
            repo_root = scope_root if scope_root != "/" else _os.getcwd()
            worktrees = _parse_worktrees(repo_root)
            self.push_screen(
                PruneScreen(
                    worktrees=worktrees,
                    sessions=list(self._sessions),
                    repo_root=repo_root,
                ),
                callback=lambda _: self.action_refresh_now(),
            )
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def action_open_in_window(self) -> None:
        """Open the selected session in a dedicated new tmux window."""
        self.action_open_session_window()

    def action_new_session(self) -> None:
        """Open SpawnScreen overlay to create a new agent session."""
        prefill_branch = ""
        if self._selected_session:
            prefill_branch = self._selected_session.branch or ""
        self.push_screen(
            SpawnScreen(
                tmux=self._tmux,
                scope_root=self.scope_root,
                prefill_branch=prefill_branch,
            )
        )

    def action_open_templates(self) -> None:
        """Open fzf tmux popup to pick a session template."""
        templates = self._load_templates()
        if not templates:
            self.notify(
                "No templates found in ~/.omp/templates/", severity="information"
            )
            return

        import os as _os
        import subprocess as _sp
        import tempfile

        lines = [
            f"{t.get('name', '?')} | {t.get('role', '')} | {t.get('harness', 'omp')}"
            for t in templates
        ]
        fname = ""
        chosen = ""
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False, encoding="utf-8"
            ) as handle:
                handle.write("\n".join(lines))
                fname = handle.name
            result = _sp.run(
                ["tmux", "popup", "-E", f"cat '{fname}' | fzf"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            chosen = result.stdout.strip()
        except Exception as exc:
            self.notify(str(exc), severity="error")
            return
        finally:
            if fname:
                try:
                    _os.unlink(fname)
                except Exception:
                    pass

        if not chosen:
            return
        chosen_name = chosen.split(" | ", 1)[0]
        tpl = next((t for t in templates if t.get("name") == chosen_name), None)
        if not tpl:
            return

        session = self._current_session() or self._selected_session
        scope_root = self._effective_scope_root()
        project = _os.path.basename(scope_root.rstrip("/")) or (
            "(all)" if scope_root == "/" else scope_root
        )
        context = {
            "project": project,
            "branch": session.branch if session else "",
            "task": tpl.get("task", ""),
        }
        resolved = _resolve_template_vars(tpl, context)
        prefill = {k: v for k, v in resolved.items() if k != "_file"}
        self.push_screen(
            SpawnScreen(
                tmux=self._tmux,
                scope_root=self.scope_root,
                prefill_branch=session.branch if session else "",
                prefill=prefill,
            )
        )

    def action_kill_session(self) -> None:
        """Kill selected active session pane and remove it from view immediately."""
        session = self._current_session()
        if session is None or session.state != "active":
            return
        had_pane = bool(session.tmux_pane)
        try:
            actions.kill_session(self._tmux, session)
        except Exception:
            log.exception("action_kill_session error")
            return
        if not had_pane:
            return
        self._sessions = [
            s for s in self._sessions if s.session_id != session.session_id
        ]
        if (
            self._selected_session
            and self._selected_session.session_id == session.session_id
        ):
            self._selected_session = None
        self._dismissed_active_session_ids.discard(session.session_id)
        self._set_broadcast_selection(
            set(self._broadcast_selected_ids) - {session.session_id}
        )
        self._update_table()

    def action_kill_idle_sessions(self) -> None:
        idle_sessions = [
            session
            for session in self._sessions
            if session.status in ("idle", "offline") and session.state == "active"
        ]
        if not idle_sessions:
            self.notify("No idle sessions to kill")
            return
        killed = 0
        for session in idle_sessions:
            try:
                kill_fn = getattr(actions, "kill", None)
                if callable(kill_fn):
                    kill_fn(self._tmux, session)
                else:
                    actions.kill_session(self._tmux, session)
                killed += 1
            except Exception:
                pass
        self.notify(f"Killed {killed} idle sessions")

    def action_show_stalled(self) -> None:
        stalled_sessions = [
            session for session in self._sessions if session.status == "stalled"
        ]
        self.push_screen(StalledAgentsScreen(stalled_sessions, self._tmux))

    def action_show_settings(self) -> None:
        def _handle_save(saved_settings: dict[str, int]) -> None:
            self._apply_agents_view_settings(saved_settings)
            self._do_refresh_all()

        self.push_screen(
            SettingsScreen(self._settings_snapshot(), on_save=_handle_save)
        )

    def action_show_help(self) -> None:
        """Show the keybinding help overlay."""
        self.push_screen(HelpScreen())

    def action_show_metrics(self) -> None:
        """Open MetricsScreen with current session list."""
        self.push_screen(MetricsScreen(list(self._sessions)))

    def action_open_graph(self) -> None:
        """Open GraphScreen with current session list."""

        def _jump(session_id: str) -> None:
            try:
                table = self.query_one("#session-table", DataTable)
                for i, sid in enumerate(self._ordered_keys):
                    if sid == session_id:
                        table.move_cursor(row=i)
                        break
            except Exception:
                pass

        self.push_screen(GraphScreen(sessions=list(self._sessions), on_jump=_jump))

    def action_open_broadcast_groups(self) -> None:
        """Open BroadcastGroupScreen."""
        self.push_screen(
            BroadcastGroupScreen(tmux=self._tmux, sessions=list(self._sessions))
        )

    def action_open_archive(self) -> None:
        """Open ArchiveScreen."""
        self.push_screen(ArchiveScreen(tmux=self._tmux))

    def action_open_recovery_log(self) -> None:
        """Open RecoveryLogScreen."""
        self.push_screen(RecoveryLogScreen())

    def action_open_worktree_screen(self) -> None:
        """Open WorktreeScreen; pre-select row if selected session is in a known worktree."""
        preselect = None
        s = self._selected_session
        if s and s.cwd:
            cwd_norm = s.cwd.rstrip("/")
            if cwd_norm in self._cached_worktree_paths:
                preselect = cwd_norm

        def handle_result(path: Optional[str]) -> None:
            if path:
                self._filter_text = path
                self._update_table()
                self._update_subtitle()

        self.push_screen(
            WorktreeScreen(
                sessions=list(self._sessions),
                tmux=self._tmux,
                scope_root=self.scope_root,
                preselect_path=preselect,
            ),
            callback=handle_result,
        )

    def _tab_jump(self, idx: int) -> None:
        try:
            self.query_one(ProjectTabBar).select_tab(idx)
        except Exception:
            pass

    def action_tab_right(self) -> None:
        session = self._selected_session
        new_tab = (self._panel_tab + 1) % len(self._RIGHT_PANEL_TABS)
        if session:
            self._panel_tab_state[session.session_id] = new_tab
        self._apply_panel_tab(new_tab)

    def action_tab_left(self) -> None:
        session = self._selected_session
        new_tab = (self._panel_tab - 1) % len(self._RIGHT_PANEL_TABS)
        if session:
            self._panel_tab_state[session.session_id] = new_tab
        self._apply_panel_tab(new_tab)

    def action_project_tab_next(self) -> None:
        """Cycle to next project tab."""
        try:
            self.query_one(ProjectTabBar).next_tab()
        except Exception:
            pass

    def action_project_tab_prev(self) -> None:
        """Cycle to previous project tab."""
        try:
            self.query_one(ProjectTabBar).prev_tab()
        except Exception:
            pass

    def action_prev_hunk(self) -> None:
        """Scroll to previous @@ hunk header in diff panel."""
        if self._panel_tab != 1 or not self._diff_hunk_positions:
            return
        self._diff_hunk_idx = max(0, self._diff_hunk_idx - 1)
        target = self._diff_hunk_positions[self._diff_hunk_idx]
        try:
            container = self.query_one("#diff-panel", ScrollableContainer)
            container.scroll_to(y=target, animate=False)
        except Exception:
            pass

    def action_next_hunk(self) -> None:
        """Scroll to next @@ hunk header in diff panel."""
        if self._panel_tab != 1 or not self._diff_hunk_positions:
            return
        self._diff_hunk_idx = min(
            len(self._diff_hunk_positions) - 1,
            self._diff_hunk_idx + 1,
        )
        target = self._diff_hunk_positions[self._diff_hunk_idx]
        try:
            container = self.query_one("#diff-panel", ScrollableContainer)
            container.scroll_to(y=target, animate=False)
        except Exception:
            pass

    def action_diff_stage(self) -> None:
        """Send 'git add -p' to the selected session pane."""
        if self._panel_tab != 1:
            return
        session = self._selected_session
        if not session or not session.tmux_pane:
            return
        try:
            self._tmux.send_keys(session.tmux_pane, "git add -p")
        except Exception as exc:
            self.notify(str(exc), severity="error")

    def action_diff_commit(self) -> None:
        """Show lightweight commit guidance for staged changes."""
        if self._panel_tab != 1:
            return
        session = self._selected_session
        if not session or not session.cwd:
            self.notify("No session selected", severity="warning")
            return
        self.notify(
            "Type commit msg via 'c' then confirm — send 'git commit -m \"msg\"' to pane",
            severity="information",
        )
        if session.tmux_pane:
            try:
                self._tmux.send_keys(session.tmux_pane, "git commit")
            except Exception:
                pass

    def _current_session_cwd(self) -> Optional[str]:
        session = self._current_session() or self._selected_session
        return session.cwd if session else None

    @work(thread=True, exclusive=False, group="git-ops")
    def _run_git_bg(self, cwd: str, cmd: list[str], label: str) -> None:
        import subprocess as _sp

        try:
            r = _sp.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
            out = (r.stdout or r.stderr or "").strip()[:100]
            msg = f"{label}: {out or 'done'}"
            sev = "information"
            if r.returncode != 0:
                sev = "error"
                msg = f"{label} failed: {out}"
        except Exception as exc:
            msg = f"{label} error: {exc}"
            sev = "error"
        self.app.call_from_thread(self.notify, msg, severity=sev, timeout=6)

    @work(thread=True)
    def _load_git_log(self, cwd: str) -> None:
        import subprocess as _sp

        try:
            result = _sp.run(
                ["git", "log", "--oneline", "-20"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                err = result.stderr.strip()[:160] or "Failed"
                self.app.call_from_thread(
                    self.notify,
                    f"Git log failed: {err}",
                    severity="error",
                    timeout=8,
                )
                return
            output = (result.stdout or "").strip() or "No commits found"
            self.app.call_from_thread(self._show_git_log_screen, cwd, output)
        except Exception as exc:
            self.app.call_from_thread(
                self.notify,
                f"Git log error: {exc}",
                severity="error",
            )

    def _show_git_log_screen(self, cwd: str, output: str) -> None:
        self.push_screen(GitLogScreen(cwd=cwd, log_output=output))

    def action_git_fetch(self) -> None:
        cwd = self._current_session_cwd()
        if not cwd:
            self.notify("No session selected", severity="warning")
            return
        self.notify("Fetching...", timeout=4)
        self._run_git_bg(cwd, ["git", "fetch", "--prune"], "Fetch")

    def action_git_push(self) -> None:
        session = self._current_session() or self._selected_session
        cwd = self._current_session_cwd()
        if session is None or not cwd:
            self.notify("No session selected", severity="warning")
            return
        branch = (session.branch or "").strip()
        if not branch:
            self.notify("Selected session has no branch", severity="warning")
            return
        self.notify("Pushing...", timeout=4)
        self._run_git_bg(
            cwd,
            ["git", "push", "-u", "origin", branch],
            "Push",
        )

    def action_git_log(self) -> None:
        session = self._current_session() or self._selected_session
        if session is None or not session.cwd:
            self.notify("No session selected", severity="warning")
            return
        self.notify("Loading git log...", timeout=4)
        self._load_git_log(session.cwd)

    def action_tab_jump_0(self) -> None:
        self._tab_jump(0)

    def action_tab_jump_1(self) -> None:
        self._tab_jump(1)

    def action_tab_jump_2(self) -> None:
        self._tab_jump(2)

    def action_tab_jump_3(self) -> None:
        self._tab_jump(3)

    def action_tab_jump_4(self) -> None:
        self._tab_jump(4)

    def action_tab_jump_5(self) -> None:
        self._tab_jump(5)

    def action_tab_jump_6(self) -> None:
        self._tab_jump(6)

    def action_tab_jump_7(self) -> None:
        self._tab_jump(7)

    def action_tab_jump_8(self) -> None:
        self._tab_jump(8)

    def action_tab_jump_9(self) -> None:
        self._tab_jump(9)

    def action_cycle_focus(self) -> None:
        try:
            inp = self.query_one("#session-input", Input)
            tbl = self.query_one("#session-table", DataTable)
            if inp.has_focus:
                tbl.focus()
            else:
                inp.focus()
        except Exception:
            pass

    def action_toggle_filter(self) -> None:
        try:
            fi = self.query_one("#filter-input", Input)
        except Exception:
            return
        if self._filter_visible:
            self._filter_visible = False
            fi.remove_class("visible")
            self._filter_text = ""
            fi.value = ""
            fi.placeholder = "Filter sessions… (#tag for tag filter)"
            try:
                self.query_one("#session-table", DataTable).focus()
            except Exception:
                pass
            self._update_table()
            self._update_subtitle()
        else:
            self._filter_visible = True
            fi.add_class("visible")
            fi.placeholder = "Filter sessions… (#tag for tag filter)"
            fi.focus()

    def action_save_filter_preset(self) -> None:
        try:
            current_filter = self.query_one("#filter-input", Input).value.strip()
        except Exception:
            current_filter = self._filter_text.strip()

        if not current_filter:
            self.notify("No active filter to save", severity="warning")
            return

        next_index = len(self._filter_presets) + 1
        name = f"preset_{next_index}"
        while name in self._filter_presets:
            next_index += 1
            name = f"preset_{next_index}"

        self._filter_presets[name] = current_filter
        self._filter_preset_cycle_index = 0
        _save_filter_presets(self._filter_presets)
        self.notify(f"Saved as {name} (Ctrl+L to load)")

    def action_load_filter_preset(self) -> None:
        if not self._filter_presets:
            self.notify("No saved presets", severity="warning")
            return

        items = list(self._filter_presets.items())
        index = self._filter_preset_cycle_index % len(items)
        preset_name, filter_text = items[index]
        self._filter_preset_cycle_index = (index + 1) % len(items)

        try:
            fi = self.query_one("#filter-input", Input)
            self._filter_visible = True
            fi.add_class("visible")
            fi.value = filter_text
            fi.focus()
        except Exception:
            pass

        self._filter_text = filter_text
        self._update_table()
        self._update_subtitle()
        self.notify(f"Filter: {preset_name} = {filter_text}")

    def action_sort_by_status(self) -> None:
        self._set_sort("status")

    def action_sort_by_age(self) -> None:
        self._set_sort("age")

    def action_sort_by_role(self) -> None:
        self._set_sort("role")

    def action_sort_by_session(self) -> None:
        self._set_sort("session")

    def action_sort_by_ctx(self) -> None:
        self._set_sort("ctx")

    def action_sort_by_branch(self) -> None:
        self._set_sort("branch")

    def _set_sort(self, key: str) -> None:
        if self._sort_key == key:
            self._sort_reverse = not self._sort_reverse
        else:
            self._sort_key = key
            self._sort_reverse = False
        try:
            import json as _j

            _SORT_PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
            _SORT_PREFS_FILE.write_text(
                _j.dumps({"key": self._sort_key, "reverse": self._sort_reverse})
            )
        except Exception:
            pass
        direction = "↓" if not self._sort_reverse else "↑"
        self.notify(f"Sorted by {key} {direction}")
        self._update_subtitle()
        self._schedule_refresh()

    def _schedule_refresh(self) -> None:
        self._update_table()
        self._update_stats_bar()

    def action_toggle_pivot(self) -> None:
        self._pivot_mode = not self._pivot_mode
        mode_name = "status groups" if self._pivot_mode else "project tabs"
        try:
            tab_bar = self.query_one(ProjectTabBar)
            tab_bar.display = not self._pivot_mode
            if not self._pivot_mode:
                tab_bar.update_tabs(self._sessions, self.scope_root)
        except Exception:
            pass
        try:
            self.query_one(ResourceBar).set_pivot_mode(self._pivot_mode)
        except Exception:
            pass
        self.notify(f"View: {mode_name}")
        self._update_subtitle()
        self._schedule_refresh()

    def action_toggle_scope_mode(self) -> None:
        self._global_scope_enabled = not self._global_scope_enabled
        self._update_scope_subtitle()
        self._do_refresh_all()

    def action_yank_session(self) -> None:
        session = self._current_session() or self._selected_session
        if session is None:
            self.notify("No session selected", severity="warning")
            return
        payload = f"{session.title} | {session.session_id} | {session.branch}"
        if _copy_to_clipboard(payload):
            self.notify(f"Yanked: {session.title[:40]}")
            return
        self.notify(payload, severity="warning", timeout=6)

    def action_yank_session_info(self) -> None:
        session = self._current_session() or self._selected_session
        if session is None:
            self.notify("No session selected", severity="warning")
            return
        context_pct = session.context_usage_pct
        if context_pct is None:
            context_value = "—"
        else:
            pct_value = context_pct * 100 if context_pct <= 1 else context_pct
            context_value = str(round(pct_value))
        payload = "\n".join(
            [
                f"Title: {session.title}",
                f"ID: {session.session_id}",
                f"Branch: {session.branch}",
                f"Status: {session.status}",
                f"Role: {session.role}",
                f"CWD: {session.cwd}",
                f"Model: {session.model}",
                f"Context: {context_value}%",
            ]
        )
        if _copy_to_clipboard(payload):
            self.notify(f"Yanked: {session.title[:40]}")
            return
        self.notify(payload, severity="warning", timeout=8)

    def action_health_check(self) -> None:
        """Run health check on selected session."""
        session = self._current_session() or self._selected_session
        if session is None:
            self.notify("No session selected", severity="warning")
            return
        self._run_health_check(session)

    def action_toggle_follow(self) -> None:
        self._auto_follow = not self._auto_follow
        if not self._auto_follow:
            self._follow_target_session_id = None

        try:
            self.query_one(ResourceBar).set_follow_mode(self._auto_follow)
        except Exception:
            pass

        if self._auto_follow:
            self.notify("Follow mode ON — tracking most active session")
            self._update_table()
        else:
            self.notify("Follow mode OFF")
        self._update_subtitle()

    def action_jump_to_top(self) -> None:
        try:
            t = self.query_one("#session-table", DataTable)
            t.move_cursor(row=0)
        except Exception:
            pass

    def action_jump_to_bottom(self) -> None:
        try:
            t = self.query_one("#session-table", DataTable)
            last_row = max(0, t.row_count - 1)
            t.move_cursor(row=last_row)
        except Exception:
            pass

    def action_refresh_now(self) -> None:
        self._do_refresh_all()

    def action_mark_done(self) -> None:
        """Archive selected active session and remove it from the main list."""
        session = self._current_session()
        if session is None or session.state != "active":
            return
        self._dismissed_active_session_ids.discard(session.session_id)
        self._append_session_to_archive(session)
        archived_key = self._archive_session_key(session)
        self._sessions = [
            s for s in self._sessions if self._archive_session_key(s) != archived_key
        ]
        if self._selected_session is not None and self._archive_session_key(
            self._selected_session
        ) == archived_key:
            self._selected_session = None
        self._update_table()
        self._update_preview_border()

    def action_quit_safe(self) -> None:
        self._begin_shutdown()
        self.exit()

    def deliver_screenshot(
        self,
        filename: "str | None" = None,
        path: "str | None" = None,
        time_format: "str | None" = None,
    ) -> "str | None":
        """Save screenshot normally, then copy SVG content to the system clipboard."""
        import subprocess

        result = super().deliver_screenshot(filename, path, time_format)
        try:
            svg = self.export_screenshot()
            svg_bytes = svg.encode()
            # Try wl-copy (Wayland) then xclip (X11) as fallback.
            copied = False
            for cmd in (
                ["wl-copy", "--type", "image/svg+xml"],
                ["xclip", "-selection", "clipboard", "-t", "image/svg+xml"],
            ):
                try:
                    proc = subprocess.run(
                        cmd, input=svg_bytes, capture_output=True, timeout=3
                    )
                    if proc.returncode == 0:
                        copied = True
                        break
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    continue
            if copied:
                self.notify(
                    "Screenshot saved \u2014 SVG copied to clipboard", timeout=4
                )
            else:
                self.notify("Screenshot saved (clipboard unavailable)", timeout=3)
        except Exception as exc:
            log.debug("deliver_screenshot clipboard copy failed: %s", exc)
        return result


def _load_filter_presets() -> dict[str, str]:
    try:
        raw = json.loads(_FILTER_PRESETS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}

    if not isinstance(raw, dict):
        return {}

    presets: dict[str, str] = {}
    for name, filter_text in raw.items():
        if not isinstance(name, str) or not isinstance(filter_text, str):
            continue
        preset_name = name.strip()
        preset_filter = filter_text.strip()
        if not preset_name or not preset_filter:
            continue
        presets[preset_name] = preset_filter
    return presets


def _save_filter_presets(presets: dict[str, str]) -> None:
    payload = {
        name.strip(): filter_text.strip()
        for name, filter_text in presets.items()
        if isinstance(name, str)
        and isinstance(filter_text, str)
        and name.strip()
        and filter_text.strip()
    }
    tmp = _FILTER_PRESETS_FILE.with_suffix(".tmp")
    try:
        _FILTER_PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(_FILTER_PRESETS_FILE)
    except Exception as exc:
        log.debug("filter presets save failed: %s", exc)
        try:
            tmp.unlink()
        except Exception:
            pass


class GitLogScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
    ]

    CSS = """
    GitLogScreen { background: #22272e; }
    GitLogScreen Static#git-log-title {
        height: auto;
        background: #1c2128;
        border: round #30363d;
        margin: 0 1;
        padding: 1 2;
        color: #adbac7;
    }
    GitLogScreen ScrollableContainer#git-log-container {
        height: 1fr;
        background: #22272e;
        border: round #444c56;
        margin: 0 1;
        padding: 1 2;
    }
    GitLogScreen Static#git-log-content {
        color: #adbac7;
    }
    """

    def __init__(self, cwd: str, log_output: str) -> None:
        super().__init__()
        self._cwd = cwd
        self._log_output = log_output

    def compose(self) -> ComposeResult:
        repo_name = os.path.basename(self._cwd.rstrip("/")) or self._cwd
        yield Header()
        yield Static(f"Git log — {repo_name}", id="git-log-title")
        with ScrollableContainer(id="git-log-container"):
            yield Static(self._log_output, id="git-log-content", markup=False)
        yield Footer()


class SessionLogScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("/", "toggle_search", "Search"),
        Binding("n", "next_match", "Next match"),
        Binding("N", "prev_match", "Prev match", show=False),
        Binding("g", "jump_top", "Top"),
        Binding("G", "jump_bottom", "Bottom"),
        Binding("u", "page_up", "Page up"),
        Binding("d", "page_down", "Page down"),
    ]

    CSS = """
    SessionLogScreen { background: #22272e; }
    SessionLogScreen Static#log-title {
        height: auto;
        background: #1c2128;
        border: round #30363d;
        margin: 0 1;
        padding: 1 2;
        color: #adbac7;
    }
    SessionLogScreen Input#log-search {
        display: none;
        height: 3;
        background: #2d333b;
        border: solid #316dca;
        color: #adbac7;
        margin: 0 1;
    }
    SessionLogScreen Input#log-search.visible {
        display: block;
    }
    SessionLogScreen ScrollableContainer#log-container {
        height: 1fr;
        background: #22272e;
        padding: 0 1;
    }
    SessionLogScreen Static#log-content {
        color: #adbac7;
        padding: 0 1;
    }
    SessionLogScreen Static#log-status {
        height: 1;
        border-top: solid #384048;
        padding: 0 1;
        color: #636e7b;
    }
    """

    def __init__(self, session: AgentSession, log_path: str) -> None:
        super().__init__()
        self._session = session
        self._log_path = log_path
        self._rows: list[tuple[int, str, str, str]] = []
        self._search_visible = False
        self._search_term = ""
        self._match_indices: list[int] = []
        self._match_cursor = -1

    def compose(self) -> ComposeResult:
        yield Header()
        title = self._session.title or self._session.session_id or "Session"
        yield Static(f"Session log — {title}", id="log-title")
        yield Input(id="log-search", placeholder="Search in log...")
        with ScrollableContainer(id="log-container"):
            yield Static("", id="log-content")
        yield Static("", id="log-status")
        yield Footer()

    def on_mount(self) -> None:
        self._load_rows()
        self._render_log()

    def _truncate(self, text: str, limit: int = 120) -> str:
        compact = " ".join(str(text).split())
        if len(compact) <= limit:
            return compact
        return compact[: max(1, limit - 1)] + "…"

    def _format_arg_value(self, value: object) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return repr(self._truncate(value, limit=30))
        if isinstance(value, dict):
            return f"{{{len(value)} keys}}"
        if isinstance(value, list):
            return f"[{len(value)} items]"
        if value is None:
            return "null"
        return self._truncate(str(value), limit=30)

    def _first_text(self, content: object) -> str:
        texts = _extract_text_blocks(content)
        if texts:
            return self._truncate(texts[0])
        if isinstance(content, str):
            return self._truncate(content)
        return ""

    def _summarize_tool_call(self, call: dict[str, object]) -> str:
        name = str(call.get("name") or "tool")
        args = call.get("args")
        parts: list[str] = []
        if isinstance(args, dict):
            for key, value in args.items():
                key_str = str(key)
                if key_str == "agent__intent":
                    continue
                parts.append(f"{key_str}={self._format_arg_value(value)}")
                if len(parts) >= 3:
                    break
        arg_summary = ", ".join(parts) if parts else "no args"
        return self._truncate(f"{name}({arg_summary})")

    def _summarize_tool_result(self, message: dict[str, object]) -> str:
        tool_name = str(message.get("toolName") or "tool")
        status = "error" if bool(message.get("isError")) else "ok"
        preview = ""
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    preview = str(block.get("text") or "")
                    break
        elif isinstance(content, str):
            preview = content
        elif content is not None:
            preview = str(content)
        summary = f"{tool_name}: {status}"
        if preview.strip():
            summary = f"{summary} — {self._truncate(preview)}"
        return self._truncate(summary)

    def _summarize_row(self, parsed: dict[str, object]) -> tuple[str, str, str]:
        message = parsed.get("message")
        if isinstance(message, dict):
            role = str(message.get("role") or "")
            content = message.get("content")
            if role == "user":
                text = self._first_text(content) or "[no text]"
                return "•", "#6cb6ff", text
            if role == "assistant":
                tool_calls = _iter_tool_calls(content)
                if tool_calls:
                    summary = self._summarize_tool_call(tool_calls[0])
                    if len(tool_calls) > 1:
                        summary = self._truncate(
                            f"{summary} (+{len(tool_calls) - 1} more)",
                            limit=120,
                        )
                    return "•", "#d4a72c", summary
                text = self._first_text(content) or "[assistant message]"
                return "•", "#3fb950", text
            if role == "toolResult":
                return "•", "#636e7b", self._summarize_tool_result(message)
        record_type = str(parsed.get("type") or "record")
        return "•", "#636e7b", self._truncate(f"{record_type} event")

    def _load_rows(self) -> None:
        self._rows = []
        try:
            tail_lines = _read_jsonl_tail_lines(self._log_path)[-200:]
        except OSError:
            self.query_one("#log-content", Static).update(
                Text("[session file unavailable]", style="#f85149")
            )
            self.query_one("#log-status", Static).update(
                Text("0 lines", style="#636e7b")
            )
            return

        if not tail_lines:
            self.query_one("#log-content", Static).update(
                Text("Empty log", style="#636e7b")
            )
            self.query_one("#log-status", Static).update(
                Text("0 lines", style="#636e7b")
            )
            return

        for line_no, raw in enumerate(tail_lines, start=1):
            payload = raw.strip()
            if not payload:
                self._rows.append((line_no, "•", "#636e7b", "[blank line]"))
                continue
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                self._rows.append(
                    (
                        line_no,
                        "•",
                        "#f85149",
                        self._truncate(f"[invalid JSON] {payload}"),
                    )
                )
                continue
            if not isinstance(parsed, dict):
                self._rows.append((line_no, "•", "#636e7b", "[non-object JSON record]"))
                continue
            bullet, color, summary = self._summarize_row(parsed)
            self._rows.append((line_no, bullet, color, self._truncate(summary)))

    def _sync_matches(self) -> None:
        term = self._search_term.lower()
        if not term:
            self._match_indices = []
            self._match_cursor = -1
            return
        self._match_indices = [
            idx
            for idx, (_, _, _, summary) in enumerate(self._rows)
            if term in summary.lower()
        ]
        if not self._match_indices:
            self._match_cursor = -1
            return
        if self._match_cursor < 0 or self._match_cursor >= len(self._match_indices):
            self._match_cursor = 0

    def _update_status(self) -> None:
        total = len(self._rows)
        status = f"{total} lines"
        if self._search_term:
            if self._match_indices:
                current = self._match_cursor + 1 if self._match_cursor >= 0 else 1
                status += f" | {len(self._match_indices)} matches ({current}/{len(self._match_indices)})"
            else:
                status += f" | no matches for '{self._search_term}'"
        self.query_one("#log-status", Static).update(Text(status, style="#636e7b"))

    def _render_log(self) -> None:
        self._sync_matches()
        if not self._rows:
            self._update_status()
            return

        highlighted_rows = set(self._match_indices)
        rendered = Text()
        for idx, (line_no, bullet, color, summary) in enumerate(self._rows):
            is_match = idx in highlighted_rows
            line_style = "bold yellow" if is_match else "#adbac7"
            rendered.append(
                f"{line_no:>4} ", style=line_style if is_match else "#636e7b"
            )
            rendered.append(f"{bullet} ", style=line_style if is_match else color)
            rendered.append(summary, style=line_style)
            rendered.append("\n")
        self.query_one("#log-content", Static).update(rendered)
        self._update_status()

    def _scroll_to_current_match(self) -> None:
        if not self._match_indices or self._match_cursor < 0:
            return
        row_index = self._match_indices[self._match_cursor]
        try:
            self.query_one("#log-container", ScrollableContainer).scroll_to(
                y=max(0, row_index - 1), animate=False
            )
        except Exception:
            pass

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "log-search":
            return
        self._search_term = event.value.strip()
        self._match_cursor = 0 if self._search_term else -1
        self._render_log()

    def action_toggle_search(self) -> None:
        search = self.query_one("#log-search", Input)
        self._search_visible = not self._search_visible
        if self._search_visible:
            search.add_class("visible")
            search.focus()
            return
        search.remove_class("visible")
        search.value = ""
        self._search_term = ""
        self._match_indices = []
        self._match_cursor = -1
        self._render_log()

    def action_next_match(self) -> None:
        if not self._match_indices:
            return
        self._match_cursor = (self._match_cursor + 1) % len(self._match_indices)
        self._update_status()
        self._scroll_to_current_match()

    def action_prev_match(self) -> None:
        if not self._match_indices:
            return
        self._match_cursor = (self._match_cursor - 1) % len(self._match_indices)
        self._update_status()
        self._scroll_to_current_match()

    def action_jump_top(self) -> None:
        try:
            self.query_one("#log-container", ScrollableContainer).scroll_home(
                animate=False
            )
        except Exception:
            pass

    def action_jump_bottom(self) -> None:
        try:
            self.query_one("#log-container", ScrollableContainer).scroll_end(
                animate=False
            )
        except Exception:
            pass

    def action_page_up(self) -> None:
        try:
            self.query_one("#log-container", ScrollableContainer).scroll_relative(
                y=-20, animate=False
            )
        except Exception:
            pass

    def action_page_down(self) -> None:
        try:
            self.query_one("#log-container", ScrollableContainer).scroll_relative(
                y=20, animate=False
            )
        except Exception:
            pass


def _action_view_session_log(self: AgentsViewApp) -> None:
    """Open SessionLogScreen for the selected session."""
    session = self._current_session()
    if session is None:
        return

    log_path = _extract_session_file_path(session.resume_command)
    if log_path and os.path.exists(log_path):
        self.push_screen(SessionLogScreen(session, log_path))
        return

    sessions_root = Path("~/.omp/agent/sessions").expanduser()
    found_path = next(
        (
            str(path)
            for path in sessions_root.glob(f"**/*_{session.session_id}.jsonl")
            if path.is_file()
        ),
        None,
    )
    if not found_path:
        self.notify("Log file not found")
        return

    self.push_screen(SessionLogScreen(session, found_path))


AgentsViewApp.action_view_session_log = _action_view_session_log


class MetricsScreen(Screen):
    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    CSS = """
    MetricsScreen { background: #22272e; }
    #metrics-scroll {
        height: 1fr;
        background: #22272e;
        padding: 1 2;
    }
    #metrics-content { color: #adbac7; }
    """

    def __init__(self, sessions: list[AgentSession]) -> None:
        super().__init__()
        self._sessions = list(sessions)

    def compose(self) -> ComposeResult:
        yield Header()
        with ScrollableContainer(id="metrics-scroll"):
            yield Static("Loading metrics...", id="metrics-content", markup=False)
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_metrics()

    def action_refresh(self) -> None:
        self._refresh_metrics()

    @work(thread=True, exclusive=True, group="metrics-refresh")
    def _refresh_metrics(self) -> None:
        content = self._build_metrics_content(self._sessions)
        self.app.call_from_thread(self._apply_metrics_content, content)

    def _apply_metrics_content(self, content: Text) -> None:
        self.query_one("#metrics-content", Static).update(content)

    def _build_metrics_content(self, sessions: list[AgentSession]) -> Text:
        if not sessions:
            return Text("No sessions to report", style="#636e7b")

        total = len(sessions)
        safe_total = max(1, total)

        def _bar(count: int, width: int) -> str:
            filled = int(round((count / safe_total) * width))
            filled = max(0, min(width, filled))
            return "█" * filled + "░" * (width - filled)

        def _heat(count: int) -> str:
            if count == 0:
                return "░"
            if count <= 2:
                return "▒"
            if count <= 5:
                return "▓"
            return "█"

        content = Text()

        def _section(title: str) -> None:
            content.append(f"{title}\n", style="bold #cdd9e5")
            content.append(f"{'─' * len(title)}\n", style="#636e7b")

        status_counts = {"running": 0, "waiting": 0, "stalled": 0, "idle": 0}
        for session in sessions:
            status = (session.status or "").lower()
            if status in {"running", "delegating"}:
                status_counts["running"] += 1
            elif status in {"wait", "waiting", "review", "asking"}:
                status_counts["waiting"] += 1
            elif status == "stalled":
                status_counts["stalled"] += 1
            else:
                status_counts["idle"] += 1

        _section("Status Distribution")
        for label, count in (
            ("⚡ Running", status_counts["running"]),
            ("⏳ Waiting", status_counts["waiting"]),
            ("● Stalled", status_counts["stalled"]),
            ("○ Idle", status_counts["idle"]),
        ):
            pct = int(round((count / safe_total) * 100))
            content.append(
                f"{label} {_bar(count, 18)}  {count:>2} ({pct:>2}%)\n",
                style="#adbac7",
            )
        content.append("\n")

        _section("Role Distribution")
        orchestrators = sum(1 for session in sessions if session.role == "orchestrator")
        defaults = sum(1 for session in sessions if session.role == "default")
        content.append(f"⬡ Orchestrators   {orchestrators}\n", style="#adbac7")
        content.append(f"◈ Default         {defaults}\n\n", style="#adbac7")

        _section("Harness Distribution")
        harness_counts: dict[str, int] = {}
        for session in sessions:
            label = session.harness_label or "Unknown"
            harness_counts[label] = harness_counts.get(label, 0) + 1
        for label, count in sorted(
            harness_counts.items(), key=lambda item: (-item[1], item[0])
        ):
            pct = int(round((count / safe_total) * 100))
            content.append(
                f"{label[:10]:<10} {count:>2} ({pct:>2}%)  {_bar(count, 20)}\n",
                style="#adbac7",
            )
        content.append("\n")

        _section("Activity (last 24h)")
        now = time.time()
        hourly_counts = [0] * 24
        for session in sessions:
            ts = session.last_activity_ts
            if ts is None or ts > now or now - ts > 24 * 3600:
                continue
            hour = time.localtime(ts).tm_hour
            hourly_counts[hour] += 1
        content.append(
            " ".join(f"{hour:02d}" for hour in range(24)) + "\n", style="#768390"
        )
        content.append(
            " ".join(_heat(count) for count in hourly_counts) + "\n\n", style="#adbac7"
        )

        _section("Projects")
        project_stats: dict[str, dict[str, int]] = {}
        for session in sessions:
            project = (session.repo or "").strip()
            if not project:
                cwd = (session.cwd or "").rstrip("/")
                project = os.path.basename(cwd) if cwd else "(unknown)"
            project = project[:20]
            if project not in project_stats:
                project_stats[project] = {"active": 0, "stalled": 0}
            if (session.status or "").lower() == "stalled":
                project_stats[project]["stalled"] += 1
            elif session.state == "active":
                project_stats[project]["active"] += 1
        for project, stats in sorted(
            project_stats.items(),
            key=lambda item: (-(item[1]["active"] + item[1]["stalled"]), item[0]),
        ):
            content.append(
                f"{project:<20} {stats['active']:>2} active   {stats['stalled']:>2} stalled\n",
                style="#adbac7",
            )

        return content


def _agents_view_theme_value(self: AgentsViewApp, key: str) -> str:
    return self._theme.get(key, _THEMES["github-dark"][key])


def _agents_view_save_theme_preference(self: AgentsViewApp, theme_name: str) -> None:
    try:
        _THEME_PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _THEME_PREFS_FILE.write_text(
            json.dumps({"theme": theme_name}, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        log.debug("theme preference save failed: %s", exc)


def _agents_view_apply_theme(self: AgentsViewApp, theme: dict[str, str]) -> None:
    self._theme = dict(theme)
    self.styles.background = _agents_view_theme_value(self, "bg_primary")
    self.styles.color = _agents_view_theme_value(self, "text_primary")

    try:
        header = self.query_one(Header)
        header.styles.background = _agents_view_theme_value(self, "bg_tertiary")
        header.styles.color = _agents_view_theme_value(self, "text_bright")
    except Exception:
        pass

    try:
        footer = self.query_one(Footer)
        footer.styles.background = _agents_view_theme_value(self, "bg_tertiary")
        footer.styles.color = _agents_view_theme_value(self, "text_dim")
    except Exception:
        pass

    for selector, bg_key, text_key in (
        ("#left-panel", "bg_primary", None),
        ("#session-table", "bg_primary", "text_primary"),
        ("#filter-input", "bg_secondary", "text_primary"),
        ("#preview-panel", "bg_primary", None),
        ("#diff-panel", "bg_primary", None),
        ("#info-panel", "bg_primary", None),
        ("#session-input", "bg_primary", "text_primary"),
        ("#slash-command-popup", "bg_secondary", None),
        ("#preview-status", None, "text_primary"),
        ("#preview-content", None, "text_primary"),
        ("#diff-content", None, "text_primary"),
        ("#info-content", None, "text_primary"),
        ("#input-label", None, "text_dim"),
    ):
        try:
            widget = self.query_one(selector)
        except Exception:
            continue
        if bg_key:
            widget.styles.background = _agents_view_theme_value(self, bg_key)
        if text_key:
            widget.styles.color = _agents_view_theme_value(self, text_key)

    for selector in ("#right-panel", "#preview-panel", "#slash-command-popup"):
        try:
            widget = self.query_one(selector)
            widget.styles.border = ("round", _agents_view_theme_value(self, "border"))
        except Exception:
            pass

    try:
        project_tab_bar = self.query_one(ProjectTabBar)
        project_tab_bar.styles.background = _agents_view_theme_value(self, "bg_primary")
    except Exception:
        pass

    try:
        resource_bar = self.query_one(ResourceBar)
        resource_bar.styles.background = _agents_view_theme_value(self, "bg_secondary")
        resource_bar.styles.color = _agents_view_theme_value(self, "text_primary")
    except Exception:
        pass

    self.refresh()


def _agents_view_action_cycle_theme(self: AgentsViewApp) -> None:
    self._current_theme_idx = (self._current_theme_idx + 1) % len(_THEME_ORDER)
    theme_name = _THEME_ORDER[self._current_theme_idx]
    theme = _THEMES[theme_name]
    _agents_view_apply_theme(self, theme)
    _agents_view_save_theme_preference(self, theme_name)
    self.notify(f"Theme: {theme_name}", timeout=2)


AgentsViewApp._t = _agents_view_theme_value  # type: ignore[attr-defined,method-assign]
AgentsViewApp._save_theme_preference = _agents_view_save_theme_preference  # type: ignore[attr-defined,method-assign]
AgentsViewApp._apply_theme = _agents_view_apply_theme  # type: ignore[attr-defined,method-assign]
AgentsViewApp.action_cycle_theme = _agents_view_action_cycle_theme  # type: ignore[attr-defined,method-assign]


class GlobalSearchScreen(Screen):
    """Search across all session JSONL tails."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("enter", "jump_to_result", "Jump"),
    ]

    CSS = """
    GlobalSearchScreen { background: #22272e; }
    GlobalSearchScreen Input#search-input {
        height: 3;
        background: #2d333b;
        border: solid #316dca;
        color: #adbac7;
        margin: 0 1;
    }
    GlobalSearchScreen Static#search-status {
        height: auto;
        color: #768390;
        margin: 0 1;
    }
    GlobalSearchScreen DataTable#search-results {
        height: 1fr;
        background: #22272e;
    }
    """

    def __init__(
        self,
        sessions: list[AgentSession],
        on_jump: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__()
        self._sessions = sessions
        self._on_jump = on_jump
        self._search_generation: int = 0
        self._search_timer: object | None = None
        self._ordered_session_ids: list[str] = []
        self._session_file_paths: dict[str, str] = {}
        self._resolve_session_file_paths()

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(
            "Global Search — type to search all session logs",
            style="bold #adbac7",
        )
        yield Input(id="search-input", placeholder="Search text...")
        yield Static("0 results", id="search-status")
        yield DataTable(id="search-results", cursor_type="row", show_cursor=True)
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#search-results", DataTable)
        table.add_column("SESSION", width=30, key="session")
        table.add_column("MATCH", width=60, key="match")
        table.add_column("AGE", width=8, key="age")
        self.query_one("#search-input", Input).focus()

    def on_unmount(self) -> None:
        self._search_generation += 1
        if self._search_timer is None:
            return
        cancel = getattr(self._search_timer, "cancel", None)
        if callable(cancel):
            cancel()
        else:
            stop = getattr(self._search_timer, "stop", None)
            if callable(stop):
                stop()
        self._search_timer = None

    def _resolve_session_file_paths(self) -> None:
        sessions_root = Path("~/.omp/agent/sessions").expanduser()
        for session in self._sessions:
            sid = session.session_id
            if not sid:
                continue
            resolved = self._resolve_session_file_path(session, sessions_root)
            if resolved:
                self._session_file_paths[sid] = resolved

    def _resolve_session_file_path(
        self, session: AgentSession, sessions_root: Path
    ) -> str | None:
        candidates: list[str] = []
        resume_path = _extract_session_file_path(session.resume_command)
        if resume_path:
            candidates.append(resume_path)
        session_file_path = getattr(session, "session_file_path", None)
        if isinstance(session_file_path, str) and session_file_path.strip():
            candidates.append(session_file_path.strip())

        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate

        sid = session.session_id
        if not sid:
            return None

        try:
            exact = next(
                (
                    str(path)
                    for path in sessions_root.glob(f"**/*_{sid}.jsonl")
                    if path.is_file()
                ),
                None,
            )
            if exact:
                return exact
            return next(
                (
                    str(path)
                    for path in sessions_root.glob(f"**/*{sid}*.jsonl")
                    if path.is_file()
                ),
                None,
            )
        except Exception:
            return None

    @staticmethod
    def _match_excerpt(text: str, query_lower: str) -> str | None:
        normalized = " ".join(str(text).split())
        if not normalized:
            return None

        idx = normalized.lower().find(query_lower)
        if idx < 0:
            return None

        start = max(0, idx - 40)
        end = min(len(normalized), idx + len(query_lower) + 40)
        snippet = normalized[start:end]
        if start > 0:
            snippet = f"...{snippet}"
        if end < len(normalized):
            snippet = f"{snippet}..."
        return snippet

    def _search_sessions(
        self, query: str
    ) -> tuple[list[tuple[AgentSession, str]], str]:
        cleaned_query = query.strip()
        if len(cleaned_query) < 3:
            return [], "Type at least 3 characters"

        query_lower = cleaned_query.lower()
        matches: list[tuple[AgentSession, str]] = []
        for session in self._sessions:
            session_path = self._session_file_paths.get(session.session_id)
            if not session_path:
                continue
            try:
                lines = _read_jsonl_tail_lines(
                    session_path, tail_bytes=_JSONL_TAIL_BYTES
                )
            except OSError:
                continue

            excerpt: str | None = None
            for raw in lines:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(obj, dict):
                    continue

                msg = obj.get("message")
                if not isinstance(msg, dict):
                    continue
                role = str(msg.get("role") or "")
                if role not in {"user", "assistant"}:
                    continue

                content = msg.get("content")
                text_blocks = _extract_text_blocks(content)
                if (
                    not text_blocks
                    and content is not None
                    and not isinstance(content, list)
                ):
                    text_blocks = [str(content)]

                for text in text_blocks:
                    excerpt = self._match_excerpt(text, query_lower)
                    if excerpt:
                        break
                if excerpt:
                    break

            if excerpt:
                matches.append((session, excerpt))
            if len(matches) >= 50:
                break

        if not matches:
            return [], "No matches found"
        if len(matches) >= 50:
            return matches, "50 results (capped)"
        suffix = "result" if len(matches) == 1 else "results"
        return matches, f"{len(matches)} {suffix}"

    @work(thread=True)
    def _do_search(self, query: str, generation: int) -> list[tuple[AgentSession, str]]:
        matches, status = self._search_sessions(query)
        if generation != self._search_generation:
            return matches
        self.app.call_from_thread(
            self._apply_search_results,
            generation,
            matches,
            status,
        )
        return matches

    def _apply_search_results(
        self,
        generation: int,
        matches: list[tuple[AgentSession, str]],
        status: str,
    ) -> None:
        if generation != self._search_generation:
            return
        table = self.query_one("#search-results", DataTable)
        table.clear()
        self._ordered_session_ids = []
        for session, excerpt in matches:
            session_label = (session.display_title or session.session_id)[:30]
            table.add_row(
                Text(session_label, style="#adbac7"),
                Text(excerpt[:120], style="#768390"),
                Text(session.age_str[:8], style="#636e7b"),
                key=session.session_id,
            )
            self._ordered_session_ids.append(session.session_id)

        if self._ordered_session_ids:
            try:
                table.move_cursor(row=0)
            except Exception:
                pass
        self.query_one("#search-status", Static).update(status)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "search-input":
            return

        self._search_generation += 1
        generation = self._search_generation
        query = event.value.strip()

        if self._search_timer is not None:
            cancel = getattr(self._search_timer, "cancel", None)
            if callable(cancel):
                cancel()
            else:
                stop = getattr(self._search_timer, "stop", None)
                if callable(stop):
                    stop()
            self._search_timer = None

        if len(query) < 3:
            self._apply_search_results(generation, [], "Type at least 3 characters")
            return

        self.query_one("#search-status", Static).update("Searching…")
        self._search_timer = self.set_timer(
            0.3, lambda q=query, g=generation: self._do_search(q, g)
        )

    def action_jump_to_result(self) -> None:
        try:
            idx = self.query_one("#search-results", DataTable).cursor_row
        except Exception:
            return
        if idx < 0 or idx >= len(self._ordered_session_ids):
            return

        session_id = self._ordered_session_ids[idx]
        self.dismiss()
        if self._on_jump:
            self._on_jump(session_id)


if not globals().get("_STALLED_AGENTS_PATCH_APPLIED"):
    _STALLED_AGENTS_PATCH_APPLIED = True

    class StalledAgentsScreen(Screen):
        BINDINGS = [
            Binding("escape", "dismiss", "Close"),
            Binding("k", "kill_selected", "Kill"),
            Binding("r", "restart_selected", "Restart"),
            Binding("K", "kill_all", "Kill all"),
            Binding("enter", "kill_selected", "Kill"),
        ]

        def __init__(self, sessions: list[AgentSession], tmux: TmuxClient) -> None:
            super().__init__()
            self._sessions = [
                session for session in sessions if session.status == "stalled"
            ]
            self._tmux = tmux
            self._ordered_ids: list[str] = []
            self._confirm_kill_all = False

        def compose(self) -> ComposeResult:
            yield Header()
            yield Static("Stalled Agents — k:kill r:restart K:kill all")
            yield DataTable(id="stalled-table", cursor_type="row", show_cursor=True)
            yield Footer()

        def on_mount(self) -> None:
            table = self.query_one("#stalled-table", DataTable)
            table.add_column("STATUS", width=10, key="status")
            table.add_column("SESSION", width=35, key="session")
            table.add_column("IDLE_TIME", width=10, key="idle")
            table.add_column("ROLE", width=8, key="role")
            self._refresh_table()

        def action_dismiss(self) -> None:
            self._confirm_kill_all = False
            self.dismiss()

        @staticmethod
        def _format_idle_time(last_activity_ts: Optional[float]) -> str:
            if last_activity_ts is None:
                return "?"
            try:
                idle_seconds = max(0, int(time.time() - float(last_activity_ts)))
            except (TypeError, ValueError):
                return "?"
            if idle_seconds < 60:
                return f"{idle_seconds}s"
            if idle_seconds < 3600:
                return f"{idle_seconds // 60}m"
            if idle_seconds < 86400:
                return f"{idle_seconds // 3600}h"
            return f"{idle_seconds // 86400}d"

        def _refresh_table(self) -> None:
            table = self.query_one("#stalled-table", DataTable)
            table.clear()
            self._ordered_ids = []
            self._sessions = [
                session for session in self._sessions if session.status == "stalled"
            ]

            if not self._sessions:
                table.add_row(
                    Text("", style="#636e7b"),
                    Text("No stalled agents", style="#636e7b"),
                    Text("", style="#636e7b"),
                    Text("", style="#636e7b"),
                )
                return

            ordered = sorted(
                self._sessions, key=lambda session: -(session.last_activity_ts or 0.0)
            )
            for session in ordered:
                title = (session.title or session.session_id)[:35]
                self._ordered_ids.append(session.session_id)
                table.add_row(
                    Text("stalled", style="#f85149"),
                    Text(title, style="#adbac7"),
                    Text(
                        self._format_idle_time(session.last_activity_ts),
                        style="#f0883e",
                    ),
                    Text((session.role or "")[:8], style="#636e7b"),
                    key=session.session_id,
                )

        def _current_session(self) -> Optional[AgentSession]:
            try:
                row = self.query_one("#stalled-table", DataTable).cursor_row
            except Exception:
                return None
            if not (0 <= row < len(self._ordered_ids)):
                return None
            session_id = self._ordered_ids[row]
            return next(
                (
                    session
                    for session in self._sessions
                    if session.session_id == session_id
                ),
                None,
            )

        def _kill_session(self, session: AgentSession) -> None:
            kill_fn = getattr(actions, "kill", None)
            if callable(kill_fn):
                kill_fn(self._tmux, session)
                return
            actions.kill_session(self._tmux, session)

        def action_kill_selected(self) -> None:
            session = self._current_session()
            if session is None:
                self.notify("No stalled agent selected", severity="warning")
                return
            try:
                self._kill_session(session)
            except Exception as exc:
                self.notify(str(exc), severity="error")
                return

            self._confirm_kill_all = False
            self._sessions = [
                item for item in self._sessions if item.session_id != session.session_id
            ]
            self._refresh_table()
            self.notify(f"Killed stalled: {(session.title or session.session_id)[:30]}")

        def action_restart_selected(self) -> None:
            session = self._current_session()
            if session is None:
                self.notify("No stalled agent selected", severity="warning")
                return
            current_tmux = self._tmux.get_current_session() or ""
            try:
                actions.resume(self._tmux, session, current_tmux)
            except Exception as exc:
                self.notify(str(exc), severity="error")
                return

            self._confirm_kill_all = False
            self.notify(
                f"Restart triggered: {(session.title or session.session_id)[:30]}"
            )

        def action_kill_all(self) -> None:
            stalled_sessions = [
                session for session in self._sessions if session.status == "stalled"
            ]
            if not stalled_sessions:
                self._confirm_kill_all = False
                self.notify("No stalled agents", severity="information")
                return
            if not self._confirm_kill_all:
                self._confirm_kill_all = True
                self.notify(
                    f"Confirm kill all stalled: {len(stalled_sessions)} (press K again)"
                )
                return

            self._confirm_kill_all = False
            killed_ids: set[str] = set()
            failures = 0
            for session in stalled_sessions:
                try:
                    self._kill_session(session)
                    killed_ids.add(session.session_id)
                except Exception:
                    failures += 1

            self._sessions = [
                item for item in self._sessions if item.session_id not in killed_ids
            ]
            self._refresh_table()
            message = f"Killed {len(killed_ids)} stalled session(s)"
            if failures:
                message += f" ({failures} failed)"
            self.notify(message, severity="warning" if failures else "information")

    def _agents_view_load_auto_kill_stalled_minutes(self: "AgentsViewApp") -> int:
        return _load_agents_view_settings()["auto_kill_stalled_minutes"]

    def _agents_view_idle_seconds_since_last_activity(
        self: "AgentsViewApp", session: AgentSession
    ) -> Optional[float]:
        if session.last_activity_ts is None:
            return None
        try:
            return max(0.0, time.time() - float(session.last_activity_ts))
        except (TypeError, ValueError):
            return None

    def _agents_view_auto_kill_stalled_sessions(
        self: "AgentsViewApp", sessions: list[AgentSession]
    ) -> None:
        minutes = getattr(self, "_auto_kill_stalled_minutes", 0)
        if minutes <= 0:
            if hasattr(self, "_auto_killed_stalled_ids"):
                self._auto_killed_stalled_ids.clear()
            return

        if not hasattr(self, "_auto_killed_stalled_ids"):
            self._auto_killed_stalled_ids = set()

        stalled_ids = {
            session.session_id
            for session in sessions
            if session.state == "active" and session.status == "stalled"
        }
        self._auto_killed_stalled_ids.intersection_update(stalled_ids)
        threshold_seconds = minutes * 60

        for session in sessions:
            if session.state != "active" or session.status != "stalled":
                continue
            if session.session_id in self._auto_killed_stalled_ids:
                continue
            idle_seconds = self._idle_seconds_since_last_activity(session)
            if idle_seconds is None or idle_seconds < threshold_seconds:
                continue

            try:
                kill_fn = getattr(actions, "kill", None)
                if callable(kill_fn):
                    kill_fn(self._tmux, session)
                else:
                    actions.kill_session(self._tmux, session)
            except Exception:
                log.exception("auto-kill stalled failed for %s", session.session_id)
                continue

            self._auto_killed_stalled_ids.add(session.session_id)
            _log_recovery(
                session_id=session.session_id,
                title=session.title or "",
                pattern="stalled",
                action="auto_kill",
                auto=True,
            )
            self.notify(
                f"Auto-killed stalled: {(session.title or session.session_id)[:30]}",
                severity="warning",
            )

    def _agents_view_action_show_stalled(self: "AgentsViewApp") -> None:
        stalled_sessions = [
            session for session in self._sessions if session.status == "stalled"
        ]
        self.push_screen(StalledAgentsScreen(stalled_sessions, self._tmux))

    _original_agents_view_init = AgentsViewApp.__init__

    def _agents_view_init_with_stalled_patch(
        self: "AgentsViewApp", scope_root: str
    ) -> None:
        _original_agents_view_init(self, scope_root)
        self._auto_kill_stalled_minutes = self._load_auto_kill_stalled_minutes()
        self._auto_killed_stalled_ids: set[str] = set()

    _original_apply_refreshed_sessions = AgentsViewApp._apply_refreshed_sessions

    def _apply_refreshed_sessions_with_auto_kill(
        self: "AgentsViewApp", sessions: list[AgentSession]
    ) -> None:
        self._apply_stall_status(sessions)
        self._auto_kill_stalled_sessions(sessions)
        _original_apply_refreshed_sessions(self, sessions)

    def _resource_bar_render_with_stalled_badge(self: ResourceBar) -> Text:
        elapsed = int(time.time() - self._uptime_start)
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        uptime = f"{h:02d}:{m:02d}:{s:02d}"
        parts = [
            (f" ⚡ {self._active} active", "#3fb950" if self._active else "#636e7b"),
        ]
        if self._stalled > 0:
            parts.extend(
                [
                    ("  ", "#636e7b"),
                    (f"● {self._stalled} stalled", "#f85149"),
                ]
            )
        parts.extend(
            [
                ("  ", "#636e7b"),
                (f"✓ {self._done} done", "#636e7b"),
                ("  ", "#636e7b"),
                (f"⏱ {uptime}", "#636e7b"),
            ]
        )
        if self._follow_mode:
            parts.extend([("  │ ", "#636e7b"), ("◉ FOLLOW", "#d4a72c")])
        text = Text()
        for value, style in parts:
            text.append(value, style=style)
        return text

    AgentsViewApp.__init__ = _agents_view_init_with_stalled_patch
    AgentsViewApp._load_auto_kill_stalled_minutes = (
        _agents_view_load_auto_kill_stalled_minutes
    )
    AgentsViewApp._idle_seconds_since_last_activity = (
        _agents_view_idle_seconds_since_last_activity
    )
    AgentsViewApp._auto_kill_stalled_sessions = _agents_view_auto_kill_stalled_sessions
    AgentsViewApp._apply_refreshed_sessions = _apply_refreshed_sessions_with_auto_kill
    AgentsViewApp.action_show_stalled = _agents_view_action_show_stalled
    ResourceBar.render = _resource_bar_render_with_stalled_badge

    if not any(
        getattr(binding, "action", "") == "show_stalled"
        for binding in AgentsViewApp.BINDINGS
    ):
        AgentsViewApp.BINDINGS.append(Binding("S", "show_stalled", "Stalled agents"))

    if ("Screens", "S", "Stalled agents") not in HelpScreen._BINDINGS_TABLE:
        insert_idx = next(
            (
                idx + 1
                for idx, row in enumerate(HelpScreen._BINDINGS_TABLE)
                if row[0] == "Screens" and row[1] == "L"
            ),
            None,
        )
        if insert_idx is None:
            HelpScreen._BINDINGS_TABLE.append(("Screens", "S", "Stalled agents"))
        else:
            HelpScreen._BINDINGS_TABLE.insert(
                insert_idx, ("Screens", "S", "Stalled agents")
            )

    if "    S            Stalled agents" not in _HELP_TEXT:
        _HELP_TEXT = _HELP_TEXT.replace(
            "    L            Recovery log\n",
            "    L            Recovery log\n    S            Stalled agents\n",
        )


def _jump_to_session_row(self: AgentsViewApp, session_id: str) -> None:
    try:
        table = self.query_one("#session-table", DataTable)
        for i, sid in enumerate(self._ordered_keys):
            if sid == session_id:
                table.move_cursor(row=i)
                break
    except Exception:
        pass


def _action_global_search(self: AgentsViewApp) -> None:
    """Open GlobalSearchScreen with current session list."""
    self.push_screen(
        GlobalSearchScreen(
            sessions=list(self._sessions),
            on_jump=lambda session_id: self._jump_to_session_row(session_id),
        )
    )


AgentsViewApp._jump_to_session_row = _jump_to_session_row
AgentsViewApp.action_global_search = _action_global_search


def _agents_view_palette_commands(
    provider: AgentsViewCommandProvider,
    app: "AgentsViewApp",
) -> list[tuple[str, str, str, Callable[[], None]]]:
    def _notify(message: str, severity: str = "information") -> None:
        try:
            app.notify(message, severity=severity)
        except Exception:
            pass

    def _run_on_ui(fn: Callable[[], None]) -> None:
        try:
            app.call_from_thread(fn)
            return
        except Exception:
            pass
        try:
            fn()
        except Exception as exc:
            _notify(str(exc), severity="warning")

    def _invoke(
        action_name: str,
        unavailable_message: str,
        fallback: Optional[Callable[[], None]] = None,
    ) -> None:
        action = getattr(app, action_name, None)
        if callable(action):
            _run_on_ui(action)
            return
        if fallback is not None:
            _run_on_ui(fallback)
            return
        _notify(unavailable_message, severity="warning")

    def _require_selected_session() -> bool:
        session = None
        current = getattr(app, "_current_session", None)
        if callable(current):
            try:
                session = current()
            except Exception:
                session = None
        if session is None:
            session = getattr(app, "_selected_session", None)
        if session is None:
            _notify("No session selected", severity="warning")
            return False
        return True

    def _selected_action(action_name: str, label: str) -> None:
        if not _require_selected_session():
            return
        _invoke(action_name, f"{label} is unavailable in this build")

    def _jump_to_running_session() -> None:
        sessions = list(getattr(app, "_sessions", []) or [])
        target = next(
            (
                session
                for session in sessions
                if getattr(session, "state", "") == "active"
                and getattr(session, "status", "") == "running"
            ),
            None,
        )
        if target is None:
            target = next(
                (
                    session
                    for session in sessions
                    if getattr(session, "state", "") == "active"
                    and getattr(session, "status", "")
                    not in {"offline", "idle", "inactive"}
                ),
                None,
            )
        if target is None:
            _notify("No running sessions available", severity="warning")
            return
        session_id = getattr(target, "session_id", "")
        if not session_id:
            _notify("Unable to resolve running session", severity="warning")
            return

        def _jump() -> None:
            jump = getattr(app, "_jump_to_session_row", None)
            if callable(jump):
                jump(session_id)
                return
            table = app.query_one("#session-table", DataTable)
            row = list(getattr(app, "_ordered_keys", [])).index(session_id)
            table.move_cursor(row=row)

        _run_on_ui(_jump)

    def _toggle_pivot() -> None:
        if callable(getattr(app, "action_toggle_pivot", None)):
            _invoke("action_toggle_pivot", "Pivot view is unavailable")
            return
        if callable(getattr(app, "action_toggle_scope_mode", None)):
            _invoke("action_toggle_scope_mode", "Pivot view is unavailable")
            return
        _notify("Pivot view is unavailable in this build", severity="warning")

    def _open_settings() -> None:
        if callable(getattr(app, "action_show_settings", None)):
            _invoke("action_show_settings", "Settings screen is unavailable")
            return
        if callable(getattr(app, "action_open_settings", None)):
            _invoke("action_open_settings", "Settings screen is unavailable")
            return
        settings_cls = globals().get("SettingsScreen")
        if settings_cls is None:
            _notify("Settings screen is unavailable in this build", severity="warning")
            return
        _run_on_ui(lambda: app.push_screen(settings_cls(_load_agents_view_settings())))

    def _toggle_columns() -> None:
        if callable(getattr(app, "action_column_picker", None)):
            _invoke("action_column_picker", "Column visibility picker is unavailable")
            return
        _notify(
            "Column visibility picker is unavailable in this build", severity="warning"
        )

    def _broadcast_to_selected() -> None:
        def _send() -> None:
            focus = getattr(app, "_focus_session_input", None)
            if callable(focus):
                focus()

            selected_ids = set(getattr(app, "_broadcast_selected_ids", set()) or set())
            if not selected_ids:
                current = getattr(app, "_current_session", None)
                session = current() if callable(current) else None
                if session is not None:
                    set_selection = getattr(app, "_set_broadcast_selection", None)
                    if callable(set_selection):
                        set_selection({session.session_id})
                        update_table = getattr(app, "_update_table", None)
                        if callable(update_table):
                            update_table()
                        selected_ids = {session.session_id}
            if not selected_ids:
                app.notify("No sessions selected for broadcast", severity="warning")
                return

            input_widget = app.query_one("#session-input", Input)
            if not input_widget.value.strip():
                app.notify(
                    "Type a broadcast message first, then run Broadcast to selected",
                    severity="warning",
                )
                return

            try:
                app.query_one("#session-table", DataTable).focus()
            except Exception:
                pass
            send_action = getattr(app, "action_broadcast_selected", None)
            if callable(send_action):
                send_action()

        _run_on_ui(_send)

    def _broadcast_template(message: str) -> None:
        def _send() -> None:
            input_widget = app.query_one("#session-input", Input)
            input_widget.value = message
            if hasattr(input_widget, "cursor_position"):
                input_widget.cursor_position = len(message)

            selected_ids = set(getattr(app, "_broadcast_selected_ids", set()) or set())
            if not selected_ids:
                running_fn = getattr(app, "_running_broadcast_targets", None)
                set_selection = getattr(app, "_set_broadcast_selection", None)
                if callable(running_fn) and callable(set_selection):
                    running_targets = running_fn()
                    if running_targets:
                        target_ids = {session.session_id for session in running_targets}
                        set_selection(target_ids)
                        update_table = getattr(app, "_update_table", None)
                        if callable(update_table):
                            update_table()
                        selected_ids = target_ids
            if not selected_ids:
                app.notify(
                    "No running sessions available for broadcast", severity="warning"
                )
                return

            try:
                app.query_one("#session-table", DataTable).focus()
            except Exception:
                pass
            send_action = getattr(app, "action_broadcast_selected", None)
            if callable(send_action):
                send_action()

        _run_on_ui(_send)

    return [
        (
            "Navigation",
            "Jump to top",
            "Move to the first row in the sessions table",
            lambda: _invoke(
                "action_jump_to_top",
                "Jump to top is unavailable",
                fallback=lambda: app.query_one("#session-table", DataTable).move_cursor(
                    row=0
                ),
            ),
        ),
        (
            "Navigation",
            "Jump to bottom",
            "Move to the last row in the sessions table",
            lambda: _invoke(
                "action_jump_to_bottom",
                "Jump to bottom is unavailable",
                fallback=lambda: app.query_one("#session-table", DataTable).move_cursor(
                    row=max(0, app.query_one("#session-table", DataTable).row_count - 1)
                ),
            ),
        ),
        (
            "Navigation",
            "Jump to running session",
            "Move cursor to the first running session",
            _jump_to_running_session,
        ),
        (
            "Navigation",
            "Jump to stalled sessions",
            "Open the stalled sessions view",
            lambda: _invoke(
                "action_show_stalled", "Stalled sessions view is unavailable"
            ),
        ),
        (
            "Navigation",
            "Next bookmark",
            "Jump to the next bookmarked session",
            lambda: _invoke(
                "action_next_bookmark", "Bookmark navigation is unavailable"
            ),
        ),
        (
            "View",
            "Toggle pivot view",
            "Switch between standard and pivoted session views",
            _toggle_pivot,
        ),
        (
            "View",
            "Toggle follow mode",
            "Toggle automatic follow of active sessions",
            lambda: _invoke(
                "action_toggle_follow", "Follow mode toggle is unavailable"
            ),
        ),
        (
            "View",
            "Open metrics dashboard",
            "Open the metrics dashboard",
            lambda: _invoke("action_show_metrics", "Metrics dashboard is unavailable"),
        ),
        (
            "View",
            "Open global search",
            "Search across all session logs",
            lambda: _invoke("action_global_search", "Global search is unavailable"),
        ),
        ("View", "Open settings", "Open application settings", _open_settings),
        (
            "View",
            "Open session log",
            "Open the selected session log viewer",
            lambda: _selected_action("action_view_session_log", "Session log viewer"),
        ),
        (
            "View",
            "Open archive",
            "Open archived sessions",
            lambda: _invoke("action_open_archive", "Archive screen is unavailable"),
        ),
        (
            "View",
            "Open recovery log",
            "Open the recovery event log",
            lambda: _invoke("action_open_recovery_log", "Recovery log is unavailable"),
        ),
        (
            "View",
            "Open worktree manager",
            "Open the worktree manager",
            lambda: _invoke(
                "action_open_worktree_screen", "Worktree manager is unavailable"
            ),
        ),
        (
            "View",
            "Cycle color theme",
            "Switch to the next color theme",
            lambda: _invoke("action_cycle_theme", "Theme cycling is unavailable"),
        ),
        (
            "View",
            "Toggle column visibility",
            "Open column visibility picker",
            _toggle_columns,
        ),
        (
            "Sort",
            "Sort by status",
            "Sort sessions by status",
            lambda: _invoke(
                "action_sort_by_status", "Status sorting is unavailable in this build"
            ),
        ),
        (
            "Sort",
            "Sort by age",
            "Sort sessions by age",
            lambda: _invoke(
                "action_sort_by_age", "Age sorting is unavailable in this build"
            ),
        ),
        (
            "Sort",
            "Sort by context usage",
            "Sort sessions by context usage",
            lambda: _invoke(
                "action_sort_by_ctx",
                "Context usage sorting is unavailable in this build",
            ),
        ),
        (
            "Sort",
            "Sort by branch",
            "Sort sessions by branch",
            lambda: _invoke(
                "action_sort_by_branch", "Branch sorting is unavailable in this build"
            ),
        ),
        (
            "Session Actions",
            "Kill selected session",
            "Kill the currently selected active session",
            lambda: _selected_action("action_kill_session", "Kill selected session"),
        ),
        (
            "Session Actions",
            "Mark selected done",
            "Hide selected active session until it finishes",
            lambda: _selected_action("action_mark_done", "Mark selected done"),
        ),
        (
            "Session Actions",
            "Bookmark session",
            "Toggle bookmark on the selected session",
            lambda: _selected_action("action_toggle_bookmark", "Bookmark session"),
        ),
        (
            "Session Actions",
            "Yank session ID",
            "Copy selected session details to clipboard",
            lambda: _selected_action("action_yank_session", "Yank session ID"),
        ),
        (
            "Session Actions",
            "Export sessions to JSON/CSV",
            "Export currently visible sessions",
            lambda: _invoke("action_export_sessions", "Session export is unavailable"),
        ),
        (
            "Session Actions",
            "Kill all stalled sessions",
            "Open stalled sessions manager for bulk actions",
            lambda: _invoke(
                "action_show_stalled", "Stalled sessions manager is unavailable"
            ),
        ),
        (
            "Session Actions",
            "Broadcast to selected",
            "Focus broadcast input and send current message to selected sessions",
            _broadcast_to_selected,
        ),
        (
            "Broadcast Templates",
            "Broadcast: continue",
            "Send 'continue' to selected sessions",
            lambda m="continue": _broadcast_template(m),
        ),
        (
            "Broadcast Templates",
            "Broadcast: /compact",
            "Send '/compact' to selected sessions",
            lambda m="/compact": _broadcast_template(m),
        ),
        (
            "Broadcast Templates",
            "Broadcast: commit changes",
            "Send commit reminder to selected sessions",
            lambda m="please commit your changes": _broadcast_template(m),
        ),
        (
            "Broadcast Templates",
            "Broadcast: run tests",
            "Send test reminder to selected sessions",
            lambda m="run the tests and fix any failures": _broadcast_template(m),
        ),
        (
            "General",
            "Spawn agent",
            "Open the spawn session screen",
            lambda: _invoke("action_new_session", "Spawn session is unavailable"),
        ),
        (
            "General",
            "Open template picker",
            "Pick and apply an agent template",
            lambda: _invoke("action_open_templates", "Template picker is unavailable"),
        ),
        (
            "General",
            "Open prune worktrees wizard",
            "Open prune worktrees workflow",
            lambda: _invoke(
                "_open_prune_screen", "Prune worktrees wizard is unavailable"
            ),
        ),
        (
            "General",
            "Select all running for broadcast",
            "Select running sessions and focus broadcast input",
            lambda: _invoke(
                "action_broadcast_all_running",
                "Running-session broadcast selection is unavailable",
            ),
        ),
    ]


async def _agents_view_palette_search(
    self: AgentsViewCommandProvider, query: str
) -> Hits:
    matcher = self.matcher(query)
    query_norm = query.strip().lower()
    for group, name, help_text, command in _agents_view_palette_commands(
        self, self.app
    ):
        fuzzy_score = matcher.match(name)
        substring_match = bool(query_norm) and query_norm in name.lower()
        if query_norm and fuzzy_score <= 0 and not substring_match:
            continue
        score = (
            fuzzy_score
            if fuzzy_score > 0
            else (len(query_norm) + 1 if substring_match else 1)
        )
        display_text = Text(f"{group} · {name}")
        if fuzzy_score > 0:
            try:
                display_text = Text(f"{group} · ")
                display_text.append_text(matcher.highlight(name))
            except Exception:
                display_text = Text(f"{group} · {name}")
        try:
            yield Hit(
                score=score, display=display_text, command=command, help=Text(help_text)
            )
        except TypeError:
            yield Hit(score, display_text, command, help=help_text)


async def _agents_view_palette_discover(self: AgentsViewCommandProvider) -> Hits:
    app = self.app

    def _broadcast_message(message: str) -> None:
        try:
            input_widget = app.query_one("#session-input", Input)
        except Exception:
            return
        input_widget.value = message
        if hasattr(input_widget, "cursor_position"):
            input_widget.cursor_position = len(message)

        selected_ids = set(getattr(app, "_broadcast_selected_ids", set()) or set())
        if not selected_ids:
            running_fn = getattr(app, "_running_broadcast_targets", None)
            set_selection = getattr(app, "_set_broadcast_selection", None)
            if callable(running_fn) and callable(set_selection):
                running_targets = running_fn()
                if running_targets:
                    target_ids = {session.session_id for session in running_targets}
                    set_selection(target_ids)
                    update_table = getattr(app, "_update_table", None)
                    if callable(update_table):
                        update_table()
                    selected_ids = target_ids

        if not selected_ids:
            app.notify(
                "No running sessions available for broadcast", severity="warning"
            )
            return

        try:
            app.query_one("#session-table", DataTable).focus()
        except Exception:
            pass
        send_action = getattr(app, "action_broadcast_selected", None)
        if callable(send_action):
            send_action()

    emitted_names = {
        "Open metrics dashboard",
        "Toggle pivot view",
        "Toggle follow mode",
        "Open global search",
        "Open session log",
        "Open stalled agents",
        "Open settings",
        "Cycle color theme",
        "Sort by status",
        "Sort by age",
        "Sort by context",
        "Export sessions",
        "Yank session ID",
        "Bookmark session",
        "Git fetch",
        "Git push",
        "Broadcast: continue",
        "Broadcast: /compact",
        "Open broadcast templates",
        "Compare sessions",
        "Kill all idle sessions",
        "Kill all offline sessions",
    }

    try:
        yield DiscoveryHit(
            display=Text("Open metrics dashboard"),
            help=Text("Open the metrics dashboard"),
            command=lambda app=app: getattr(app, "action_show_metrics", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Toggle pivot view"),
            help=Text("Switch between standard and pivoted session views"),
            command=lambda app=app: getattr(app, "action_toggle_pivot", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Toggle follow mode"),
            help=Text("Toggle automatic follow of active sessions"),
            command=lambda app=app: getattr(
                app, "action_toggle_follow", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Open global search"),
            help=Text("Search across all session logs (Ctrl+F)"),
            command=lambda app=app: getattr(
                app, "action_global_search", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Open session log"),
            help=Text("Open the selected session log viewer"),
            command=lambda app=app: getattr(
                app, "action_view_session_log", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Open stalled agents"),
            help=Text("Open the stalled sessions view"),
            command=lambda app=app: getattr(app, "action_show_stalled", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Kill all idle sessions"),
            help=Text("Kill all sessions with idle/offline status"),
            command=lambda app=app: getattr(
                app, "action_kill_idle_sessions", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Kill all offline sessions"),
            help=Text("Kill all sessions with idle/offline status"),
            command=lambda app=app: getattr(
                app, "action_kill_idle_sessions", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Open settings"),
            help=Text("Open application settings"),
            command=lambda app=app: getattr(
                app, "action_show_settings", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Cycle color theme"),
            help=Text("Switch to the next color theme"),
            command=lambda app=app: getattr(app, "action_cycle_theme", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Sort by status"),
            help=Text("Sort sessions by status"),
            command=lambda app=app: getattr(
                app, "action_sort_by_status", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Sort by age"),
            help=Text("Sort sessions by age"),
            command=lambda app=app: getattr(app, "action_sort_by_age", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Sort by context"),
            help=Text("Sort sessions by context usage"),
            command=lambda app=app: getattr(app, "action_sort_by_ctx", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Export sessions"),
            help=Text("Export currently visible sessions"),
            command=lambda app=app: getattr(
                app, "action_export_sessions", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Yank session ID"),
            help=Text("Copy selected session details to clipboard"),
            command=lambda app=app: getattr(app, "action_yank_session", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Bookmark session"),
            help=Text("Toggle bookmark on the selected session"),
            command=lambda app=app: getattr(
                app, "action_toggle_bookmark", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Git fetch"),
            help=Text("Fetch latest remote updates for selected session repo"),
            command=lambda app=app: getattr(app, "action_git_fetch", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Git push"),
            help=Text("Push selected session branch to origin"),
            command=lambda app=app: getattr(app, "action_git_push", lambda: None)(),
        )
        yield DiscoveryHit(
            display=Text("Broadcast: continue"),
            help=Text("Send 'continue' to selected sessions"),
            command=lambda app=app: _broadcast_message("continue"),
        )
        yield DiscoveryHit(
            display=Text("Broadcast: /compact"),
            help=Text("Send '/compact' to selected sessions"),
            command=lambda app=app: _broadcast_message("/compact"),
        )
        yield DiscoveryHit(
            display=Text("Open broadcast templates"),
            help=Text("Open the broadcast template picker"),
            command=lambda app=app: getattr(
                app, "action_broadcast_template", lambda: None
            )(),
        )
        yield DiscoveryHit(
            display=Text("Compare sessions"),
            help=Text("Select sessions for side-by-side comparison"),
            command=lambda app=app: getattr(
                app, "action_select_for_compare", lambda: None
            )(),
        )
    except TypeError:
        yield DiscoveryHit(
            Text("Open metrics dashboard"),
            lambda app=app: getattr(app, "action_show_metrics", lambda: None)(),
            help="Open the metrics dashboard",
        )
        yield DiscoveryHit(
            Text("Toggle pivot view"),
            lambda app=app: getattr(app, "action_toggle_pivot", lambda: None)(),
            help="Switch between standard and pivoted session views",
        )
        yield DiscoveryHit(
            Text("Toggle follow mode"),
            lambda app=app: getattr(app, "action_toggle_follow", lambda: None)(),
            help="Toggle automatic follow of active sessions",
        )
        yield DiscoveryHit(
            Text("Open global search"),
            lambda app=app: getattr(app, "action_global_search", lambda: None)(),
            help="Search across all session logs (Ctrl+F)",
        )
        yield DiscoveryHit(
            Text("Open session log"),
            lambda app=app: getattr(app, "action_view_session_log", lambda: None)(),
            help="Open the selected session log viewer",
        )
        yield DiscoveryHit(
            Text("Open stalled agents"),
            lambda app=app: getattr(app, "action_show_stalled", lambda: None)(),
            help="Open the stalled sessions view",
        )
        yield DiscoveryHit(
            Text("Kill all idle sessions"),
            lambda app=app: getattr(app, "action_kill_idle_sessions", lambda: None)(),
            help="Kill all sessions with idle/offline status",
        )
        yield DiscoveryHit(
            Text("Kill all offline sessions"),
            lambda app=app: getattr(app, "action_kill_idle_sessions", lambda: None)(),
            help="Kill all sessions with idle/offline status",
        )
        yield DiscoveryHit(
            Text("Open settings"),
            lambda app=app: getattr(app, "action_show_settings", lambda: None)(),
            help="Open application settings",
        )
        yield DiscoveryHit(
            Text("Cycle color theme"),
            lambda app=app: getattr(app, "action_cycle_theme", lambda: None)(),
            help="Switch to the next color theme",
        )
        yield DiscoveryHit(
            Text("Sort by status"),
            lambda app=app: getattr(app, "action_sort_by_status", lambda: None)(),
            help="Sort sessions by status",
        )
        yield DiscoveryHit(
            Text("Sort by age"),
            lambda app=app: getattr(app, "action_sort_by_age", lambda: None)(),
            help="Sort sessions by age",
        )
        yield DiscoveryHit(
            Text("Sort by context"),
            lambda app=app: getattr(app, "action_sort_by_ctx", lambda: None)(),
            help="Sort sessions by context usage",
        )
        yield DiscoveryHit(
            Text("Export sessions"),
            lambda app=app: getattr(app, "action_export_sessions", lambda: None)(),
            help="Export currently visible sessions",
        )
        yield DiscoveryHit(
            Text("Yank session ID"),
            lambda app=app: getattr(app, "action_yank_session", lambda: None)(),
            help="Copy selected session details to clipboard",
        )
        yield DiscoveryHit(
            Text("Bookmark session"),
            lambda app=app: getattr(app, "action_toggle_bookmark", lambda: None)(),
            help="Toggle bookmark on the selected session",
        )
        yield DiscoveryHit(
            Text("Git fetch"),
            lambda app=app: getattr(app, "action_git_fetch", lambda: None)(),
            help="Fetch latest remote updates for selected session repo",
        )
        yield DiscoveryHit(
            Text("Git push"),
            lambda app=app: getattr(app, "action_git_push", lambda: None)(),
            help="Push selected session branch to origin",
        )
        yield DiscoveryHit(
            Text("Broadcast: continue"),
            lambda app=app: _broadcast_message("continue"),
            help="Send 'continue' to selected sessions",
        )
        yield DiscoveryHit(
            Text("Broadcast: /compact"),
            lambda app=app: _broadcast_message("/compact"),
            help="Send '/compact' to selected sessions",
        )
        yield DiscoveryHit(
            Text("Open broadcast templates"),
            lambda app=app: getattr(app, "action_broadcast_template", lambda: None)(),
            help="Open the broadcast template picker",
        )
        yield DiscoveryHit(
            Text("Compare sessions"),
            lambda app=app: getattr(app, "action_select_for_compare", lambda: None)(),
            help="Select sessions for side-by-side comparison",
        )

    for group, name, help_text, command in _agents_view_palette_commands(self, app):
        if name in emitted_names:
            continue
        display_text = Text(f"{group} · {name}")
        help_rich = Text(help_text)
        try:
            yield DiscoveryHit(display=display_text, help=help_rich, command=command)
        except TypeError:
            yield DiscoveryHit(display_text, command, help=help_text)


AgentsViewCommandProvider.search = _agents_view_palette_search  # type: ignore[assignment]
AgentsViewCommandProvider.discover = _agents_view_palette_discover  # type: ignore[assignment]


def _action_select_for_compare(self: AgentsViewApp) -> None:
    session = self._current_session() or self._selected_session
    if session is None:
        self.notify("Compare: no session selected", severity="warning")
        return

    session_id = session.session_id
    if session_id in self._compare_sessions:
        self._compare_sessions = [
            sid for sid in self._compare_sessions if sid != session_id
        ]
    else:
        if len(self._compare_sessions) >= 2:
            self._compare_sessions.pop(0)
        self._compare_sessions.append(session_id)

    selected_count = len(self._compare_sessions)
    self.notify(f"Compare: {selected_count}/2 sessions selected")
    if selected_count < 2:
        return

    by_id = {item.session_id: item for item in self._sessions}
    session_a = by_id.get(self._compare_sessions[0])
    session_b = by_id.get(self._compare_sessions[1])
    if session_a is None or session_b is None:
        self.notify(
            "Compare: one or more selected sessions are unavailable", severity="warning"
        )
    self.push_screen(SessionCompareScreen(session_a, session_b))


AgentsViewApp.action_select_for_compare = _action_select_for_compare


def _action_compact_session(self: AgentsViewApp) -> None:
    if not self._is_table_focused():
        return
    session = self._current_session() or self._selected_session
    if session is None:
        self.notify("No session selected", severity="warning")
        return
    if not session.tmux_pane:
        self.notify("Selected session has no active pane", severity="warning")
        return

    sent_to = actions.broadcast_input(self._tmux, [session], "/compact")
    if sent_to:
        self.notify(f"Sent /compact to {(session.title or session.session_id)[:30]}")
        return
    self.notify("Failed to send /compact", severity="error")


AgentsViewApp.action_compact_session = _action_compact_session


def _check_context_alerts(self: AgentsViewApp, sessions: list[AgentSession]) -> None:
    if not sessions:
        self._context_alerted_80.clear()
        self._context_alerted_95.clear()
        return

    active_ids = {session.session_id for session in sessions}
    self._context_alerted_80.intersection_update(active_ids)
    self._context_alerted_95.intersection_update(active_ids)

    for session in sessions:
        normalized = _normalize_context_usage_pct(session.context_usage_pct)
        if normalized is None:
            continue
        pct = normalized * 100.0
        sid = session.session_id
        title = (session.title or sid)[:30]
        if pct >= 95 and sid not in self._context_alerted_95:
            self._context_alerted_95.add(sid)
            self.notify(
                f"!! CTX FULL: {title} at {pct:.0f}%",
                severity="error",
                timeout=12,
            )
        elif pct >= 80 and sid not in self._context_alerted_80:
            self._context_alerted_80.add(sid)
            self.notify(
                f"CTX WARNING: {title} at {pct:.0f}%",
                severity="warning",
                timeout=8,
            )
        if pct <= 70:
            self._context_alerted_80.discard(sid)
            self._context_alerted_95.discard(sid)


AgentsViewApp._check_context_alerts = _check_context_alerts

_original_apply_refreshed_sessions_for_context_alerts = (
    AgentsViewApp._apply_refreshed_sessions
)


def _apply_refreshed_sessions_with_context_alerts(
    self: AgentsViewApp, sessions: list[AgentSession]
) -> None:
    self._check_context_alerts(sessions)
    _original_apply_refreshed_sessions_for_context_alerts(self, sessions)


AgentsViewApp._apply_refreshed_sessions = _apply_refreshed_sessions_with_context_alerts


if not any(
    getattr(binding, "action", "") == "compact_session"
    for binding in AgentsViewApp.BINDINGS
):
    AgentsViewApp.BINDINGS.append(Binding("Z", "compact_session", "Compact ctx"))

if ("Session", "Z", "Compact context") not in HelpScreen._BINDINGS_TABLE:
    insert_idx = next(
        (
            idx + 1
            for idx, row in enumerate(HelpScreen._BINDINGS_TABLE)
            if row[0] == "Session" and row[1] == "x"
        ),
        None,
    )
    if insert_idx is None:
        HelpScreen._BINDINGS_TABLE.append(("Session", "Z", "Compact context"))
    else:
        HelpScreen._BINDINGS_TABLE.insert(
            insert_idx, ("Session", "Z", "Compact context")
        )

if "    Z            Compact selected session context" not in _HELP_TEXT:
    _HELP_TEXT = _HELP_TEXT.replace(
        "    x            Mark active session done\n",
        "    x            Mark active session done\n    Z            Compact selected session context\n",
    )

# ---------------------------------------------------------------------------
# Load feature extension modules (must be last — after all classes defined)
# ---------------------------------------------------------------------------
try:
    from agents_view import features as _av_features  # noqa: F401  # type: ignore[import]
except Exception as _feat_err:  # pragma: no cover
    import logging as _logging

    _logging.getLogger(__name__).warning("Feature load error: %s", _feat_err)

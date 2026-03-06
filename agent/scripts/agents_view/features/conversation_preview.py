"""conversation_preview.py - Structured conversation view for session preview panel.

Parses JSONL session files and renders them as formatted conversation threads
with role labels, timestamps, tool call summaries, and skill usage indicators.
"""

from __future__ import annotations

import importlib
import json
import math
import re
import textwrap
import time
import types
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Any, Optional, Sequence

from rich.console import Console
from rich.markdown import Markdown
from rich.syntax import Syntax
from rich.text import Text
_JSONL_TAIL_BYTES = 32768
_MAX_PREVIEW_MESSAGES = 20
_MAX_MESSAGE_LINES = 12

_COLLAPSED_ASSISTANT_LINES = _MAX_MESSAGE_LINES
_EXPANDED_MESSAGES: set[str] = set()
_ALL_MESSAGES_EXPANDED = False
_SKILL_URI_RE = re.compile(r"skill://([A-Za-z0-9_.-]+)")
_SKILL_HINT_RE = re.compile(r"(?i)\bskills?[:\s]+([a-z0-9][a-z0-9._/-]+)")
_SKILL_READ_RE = re.compile(r'"path"\s*:\s*"skill://([A-Za-z0-9_.-]+)')
_SKILL_READ2_RE = re.compile(r"'path'\s*:\s*'skill://([A-Za-z0-9_.-]+)")
_OMP_KNOWN_SKILLS = {
    "brainstorming",
    "test-driven-development",
    "tdd",
    "commit-hygiene",
    "systematic-debugging",
    "error-handling-patterns",
    "auth-implementation-patterns",
    "web-design-guidelines",
    "frontend-design",
    "verification-before-completion",
    "writing-plans",
    "security-review",
    "find-skills",
    "skill-creator",
    "simplify",
    "using-git-worktrees",
    "using-tmux-for-interactive-commands",
    "monorepo-management",
    "fastapi-templates",
    "e2e-testing-patterns",
    "qa-test-planner",
    "svg-art",
    "framer-motion-best-practices",
    "vercel-react-best-practices",
    "ui-ux-pro-max",
    "dragonglass-phased-cleanup",
    "agent-browser",
    "oh-my-pi-customization",
}
_SKILL_DESCRIPTIONS: dict[str, str] = {
    "brainstorming": "Collaborative design exploration",
    "test-driven-development": "TDD workflow with red/green/refactor",
    "tdd": "TDD workflow with red/green/refactor",
    "commit-hygiene": "Atomic commits and PR discipline",
    "systematic-debugging": "Structured bug diagnosis workflow",
    "error-handling-patterns": "Result types, exceptions, graceful degradation",
    "verification-before-completion": "Prove correctness before claiming done",
    "writing-plans": "Phased TDD-first implementation plans",
    "security-review": "Auth, secrets, API and input security checklist",
    "auth-implementation-patterns": "JWT, OAuth2, session, RBAC patterns",
    "web-design-guidelines": "UI/UX accessibility and design review",
    "frontend-design": "Production-grade UI with high design quality",
    "simplify": "Refine code for clarity after writing",
    "find-skills": "Discover and install agent skills",
    "skill-creator": "Create new skills for OMP",
    "dragonglass-phased-cleanup": "Dead-code cleanup workflow for Dragonglass",
    "oh-my-pi-customization": "Extend OMP with extensions and rules",
}
_OMP_SKILL_WORD_RE = re.compile(
    r"\b(" + "|".join(sorted((re.escape(skill) for skill in _OMP_KNOWN_SKILLS), key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)
_SKILL_HEADER_RE = re.compile(r"(?:^|\n)#+\s+(?:Skill:\s*)?([a-z][a-z0-9-]{2,})", re.MULTILINE)
_AT_FILE_RE = re.compile(r"(?<!\w)@[A-Za-z0-9_./-]+")
_STATUS_ICON = {
    "completed": "✅",
    "in_progress": "🟡",
    "pending": "⚪",
    "abandoned": "⛔",
}
_MARKDOWN_ORDERED_LIST_RE = re.compile(r"^\d+\.\s")
_MERMAID_RE = re.compile(r"```mermaid\s*\n([\s\S]*?)```", re.IGNORECASE)
_FENCED_CODE_BLOCK_RE = re.compile(r"```([A-Za-z0-9_+-]*)\s*\n([\s\S]*?)```")

_TODO_TOOL_NAMES = frozenset({"todo_write", "proxy_todo_write"})
_TODO_STATUS_MARKERS = {
    "✓": "done",
    "→": "in_progress",
    "○": "pending",
    "✗": "abandoned",
}
_TODO_DISPLAY = {
    "done": ("✓", "bold #57ab5a"),
    "completed": ("✓", "bold #57ab5a"),
    "complete": ("✓", "bold #57ab5a"),
    "success": ("✓", "bold #57ab5a"),
    "in_progress": ("▶", "bold #d29922"),
    "running": ("▶", "bold #d29922"),
    "active": ("▶", "bold #d29922"),
    "pending": ("○", "dim #8b949e"),
    "abandoned": ("✗", "bold #f85149"),
    "failed": ("✗", "bold #f85149"),
    "error": ("✗", "bold #f85149"),
    "cancelled": ("✗", "bold #f85149"),
    "canceled": ("✗", "bold #f85149"),
}


def _normalize_todo_status(value: Any) -> str:
    normalized = str(value or "pending").strip().lower()
    if normalized in {"completed", "complete", "success", "done", "agent_done"}:
        return "done"
    if normalized in {"running", "active"}:
        return "in_progress"
    if normalized in {"failed", "error", "cancelled", "canceled"}:
        return "abandoned"
    return normalized or "pending"
_MAX_TODO_RENDER_TASKS = 20
_SESSION_TELEMETRY_SIDEBAR_MODES = ("telemetry", "tasks")
_RECENT_CHILD_SECONDS = 600
_IDLE_OR_DONE_STATUSES = frozenset(
    {"idle", "done", "agent_done", "offline", "unknown", "completed", "complete", "success"}
    )

def _format_timestamp(value: Any) -> str:
    if value is None:
        return "--:--:--"
    if isinstance(value, (int, float)):
        try:
            ts = float(value)
            if ts > 1e10:
                ts = ts / 1000.0
            return datetime.fromtimestamp(ts).strftime("%H:%M:%S")
        except Exception:
            return "--:--:--"
    text = str(value).strip()
    if not text:
        return "--:--:--"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.strftime("%H:%M:%S")
    except Exception:
        match = re.search(r"(\d{2}:\d{2}:\d{2})", text)
        return match.group(1) if match else "--:--:--"


def _read_jsonl_tail(path: Path, tail_bytes: int = _JSONL_TAIL_BYTES) -> list[str]:
    with path.open("rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        offset = max(0, size - tail_bytes)
        fh.seek(offset)
        payload = fh.read()
    text = payload.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if offset > 0 and lines:
        lines = lines[1:]
    return lines


def _extract_text_parts(content: Any) -> list[str]:
    if isinstance(content, str):
        stripped = content.strip()
        return [stripped] if stripped else []
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str) and text.strip():
            return [text.strip()]
        nested = content.get("content")
        if nested is not None:
            return _extract_text_parts(nested)
        return []
    if not isinstance(content, list):
        return []

    chunks: list[str] = []
    for block in content:
        if isinstance(block, str):
            stripped = block.strip()
            if stripped:
                chunks.append(stripped)
            continue
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "").lower()
        if block_type in {"toolcall", "tool_call", "tool_use", "toolresult", "tool_result"}:
            continue
        text = block.get("text")
        if isinstance(text, str) and text.strip():
            chunks.append(text.strip())
            continue
        nested = block.get("content")
        if nested is not None:
            chunks.extend(_extract_text_parts(nested))
    return chunks


def _iter_tool_calls(content: Any) -> list[dict[str, Any]]:
    blocks = content if isinstance(content, list) else [content]
    results: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "").lower()
        if block_type not in {"toolcall", "tool_call", "tool_use"}:
            continue
        args = block.get("arguments")
        if args is None:
            args = block.get("input")
        results.append(
            {
                "name": str(block.get("name") or block.get("tool") or "tool"),
                "args": args,
                "timestamp": block.get("timestamp"),
            }
        )
    return results


def _iter_tool_results(content: Any) -> list[dict[str, Any]]:
    blocks = content if isinstance(content, list) else [content]
    results: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "").lower()
        if block_type not in {"toolresult", "tool_result"}:
            continue
        payload = block.get("content")
        if payload is None:
            payload = block.get("output")
        text_parts = _extract_text_parts(payload)
        if not text_parts and payload is not None:
            text_parts = [str(payload)]
        results.append(
            {
                "text": "\n".join(text_parts).strip(),
                "timestamp": block.get("timestamp"),
            }
        )
    return results


def _summarize_tool_call(name: str, args: Any) -> str:
    if not isinstance(args, dict):
        return str(args or "")[:240]

    command = args.get("command")
    if command and isinstance(command, str):
        first_line = command.strip().split("\n")[0]
        return first_line[:120] + ("..." if len(command) > 120 else "")

    path = args.get("path")
    if path:
        op_detail = ""
        if "content" in args:
            op_detail = f" ({len(str(args['content']))} chars)"
        elif "pattern" in args:
            op_detail = f" pattern={str(args['pattern'])[:40]}"
        return f"{path}{op_detail}"

    if "edits" in args:
        edits = args["edits"]
        edit_count = len(edits) if isinstance(edits, list) else 1
        return f"{args.get('path', '?')} — {edit_count} edit(s)"

    if name.lower() in ("task", "proxy_task"):
        tasks = args.get("tasks") or []
        task_count = len(tasks) if isinstance(tasks, list) else 0
        agent = args.get("agent") or "task"
        return f"{agent}: {task_count} task(s)"

    if "query" in args:
        return f"query: {str(args['query'])[:80]}"

    pairs = [f"{key}={str(value)[:40]}" for key, value in list(args.items())[:3]]
    return "  ".join(pairs)


def _normalize_skill_name(value: str) -> str:
    skill = value.strip().strip("'\"").lower()
    if skill.startswith("skill://"):
        skill = skill.split("skill://", 1)[-1]
    return skill


def _detect_skills(*chunks: str) -> list[str]:
    found: list[str] = []

    def add(skill_name: str) -> None:
        normalized = _normalize_skill_name(skill_name)
        if normalized and normalized not in found:
            found.append(normalized)

    for chunk in chunks:
        if not chunk:
            continue
        for match in _SKILL_URI_RE.finditer(chunk):
            add(match.group(1))
        for match in _SKILL_HINT_RE.finditer(chunk):
            add(match.group(1))
        for match in _SKILL_READ_RE.finditer(chunk):
            add(match.group(1))
        for match in _SKILL_READ2_RE.finditer(chunk):
            add(match.group(1))
        for match in _OMP_SKILL_WORD_RE.finditer(chunk):
            add(match.group(1))
        for match in _SKILL_HEADER_RE.finditer(chunk):
            header_skill = _normalize_skill_name(match.group(1))
            if header_skill in _OMP_KNOWN_SKILLS:
                add(header_skill)
    return found


def _extract_todo_items(arguments: Any) -> list[tuple[str, str]]:
    if not isinstance(arguments, dict):
        return []
    ops = arguments.get("ops")
    if not isinstance(ops, list):
        return []

    items: list[tuple[str, str]] = []
    for op in ops:
        if not isinstance(op, dict):
            continue

        phases = op.get("phases")
        if isinstance(phases, list):
            for phase in phases:
                if not isinstance(phase, dict):
                    continue
                tasks = phase.get("tasks")
                if not isinstance(tasks, list):
                    continue
                for task in tasks:
                    if not isinstance(task, dict):
                        continue
                    content = str(task.get("content") or "").strip()
                    status = _normalize_todo_status(task.get("status"))
                    if content:
                        items.append((status or "pending", content))
            continue

        content = str(op.get("content") or "").strip()
        status = _normalize_todo_status(op.get("status"))
        if content:
            items.append((status or "pending", content))

    return items


def _is_todo_tool_name(value: Any) -> bool:
    return str(value or "").strip().lower() in _TODO_TOOL_NAMES


def _extract_latest_todo_state(jsonl_path: Path) -> str:
    """Return the text content of the most recent todo_write result, or empty string."""
    try:
        lines = _read_jsonl_tail(jsonl_path, _JSONL_TAIL_BYTES)
    except OSError:
        return ""

    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue

        direct_name = record.get("toolName") or record.get("tool_name") or record.get("name")
        if _is_todo_tool_name(direct_name):
            payload = record.get("content") if record.get("content") is not None else record.get("output")
            text = "\n".join(_extract_text_parts(payload)).strip()
            if not text and payload is not None:
                text = str(payload).strip()
            if text:
                return text

        message = record.get("message")
        if isinstance(message, dict):
            message_role = str(message.get("role") or "").strip().lower()
            message_tool = message.get("toolName") or message.get("name")
            if message_role == "toolresult" and _is_todo_tool_name(message_tool):
                text = "\n".join(_extract_text_parts(message.get("content"))).strip()
                if text:
                    return text

            message_content = message.get("content")
            blocks = message_content if isinstance(message_content, list) else [message_content]
            for block in reversed(blocks):
                if not isinstance(block, dict):
                    continue
                block_type = str(block.get("type") or "").strip().lower()
                if block_type not in {"toolresult", "tool_result"}:
                    continue
                block_tool = block.get("toolName") or block.get("name") or block.get("tool")
                if not _is_todo_tool_name(block_tool):
                    continue
                payload = block.get("content") if block.get("content") is not None else block.get("output")
                text = "\n".join(_extract_text_parts(payload)).strip()
                if not text and payload is not None:
                    text = str(payload).strip()
                if text:
                    return text

    return ""


def _parse_todo_text(todo_text: str) -> list[dict[str, str]]:
    """Parse the rendered todo board text into structured task rows."""
    tasks: list[dict[str, str]] = []
    for raw_line in todo_text.splitlines():
        match = re.match(r"^\s*([✓→○✗])\s+(.+?)\s*$", raw_line)
        if not match:
            continue
        marker, payload = match.groups()
        status = _TODO_STATUS_MARKERS.get(marker)
        if status is None:
            continue
        payload = payload.strip()
        if not payload:
            continue

        parts = payload.split(None, 1)
        task_id = f"task-{len(tasks) + 1}"
        content = payload
        if len(parts) > 1 and (parts[0].lower().startswith("task") or re.match(r"^[a-z]+-\d[\w-]*$", parts[0], re.IGNORECASE)):
            task_id = parts[0]
            content = parts[1].strip() or parts[0]

        tasks.append({"id": task_id, "content": content, "status": status})

    return tasks


def _normalize_context_pct(value: Any) -> Optional[int]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    if numeric <= 1.0:
        numeric *= 100.0
    return max(0, min(100, int(round(numeric))))


def _is_running_child_session(session: Any) -> bool:
    if str(getattr(session, "state", "") or "").strip().lower() != "active":
        return False
    status = str(getattr(session, "status", "") or "").strip().lower()
    if not status:
        return True
    return status not in _IDLE_OR_DONE_STATUSES


def _is_recent_child_session(session: Any, now_ts: float) -> bool:
    raw_ts = getattr(session, "last_activity_ts", None)
    if isinstance(raw_ts, bool):
        last_ts = float(int(raw_ts))
    elif isinstance(raw_ts, (int, float)):
        last_ts = float(raw_ts)
    elif isinstance(raw_ts, str):
        try:
            last_ts = float(raw_ts.strip())
        except ValueError:
            return False
    else:
        return False
    return (now_ts - last_ts) < _RECENT_CHILD_SECONDS


def _collect_recent_child_sessions(app: Any, current_session: Any) -> list[Any]:
    parent_id = str(getattr(current_session, "session_id", "") or "").strip()
    if not parent_id:
        return []

    try:
        sessions = getattr(app, "_agent_sessions")
    except AttributeError:
        sessions = None
    if not isinstance(sessions, list):
        try:
            sessions = getattr(app, "_sessions")
        except AttributeError:
            return []
    if not isinstance(sessions, list):
        return []

    now_ts = time.time()
    children: list[Any] = []
    for session in sessions:
        if str(getattr(session, "parent_session_id", "") or "").strip() != parent_id:
            continue
        if _is_running_child_session(session) or _is_recent_child_session(session, now_ts):
            children.append(session)

    children.sort(key=lambda value: float(getattr(value, "last_activity_ts", 0.0) or 0.0), reverse=True)
    return children


def _child_role_badge(session: Any) -> str:
    role = str(getattr(session, "role", "") or "").strip().lower()
    if role == "orchestrator":
        return "ORCH"
    return "DEF"


def _child_title(session: Any, max_length: int = 35) -> str:
    title = str(
        getattr(session, "display_title", None)
        or getattr(session, "title", None)
        or getattr(session, "session_id", "")
        or "(subagent)"
    ).strip()
    if len(title) <= max_length:
        return title
    return f"{title[: max_length - 1]}…"

def _normalize_token_count(value: Any) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, count)

def _format_token_count(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)

def _normalized_sidebar_mode(mode: Any) -> str:
    normalized = str(mode or "").strip().lower()
    if normalized in _SESSION_TELEMETRY_SIDEBAR_MODES:
        return normalized
    return _SESSION_TELEMETRY_SIDEBAR_MODES[0]


def _render_live_tasks_lines(
    todo_text: str,
    todo_tasks: list[dict[str, str]],
    child_sessions: list[Any],
    *,
    sidebar_mode: str = "telemetry",
) -> list[Text]:
    mode = _normalized_sidebar_mode(sidebar_mode)
    if not todo_tasks:
        raw_lines = [line.rstrip() for line in todo_text.splitlines() if line.strip()]
        if not raw_lines:
            return [Text("(no active task list)", style="dim #636e7b")]
        preview_lines = [Text(line, style="#8b949e") for line in raw_lines[:12]]
        if len(raw_lines) > 12:
            preview_lines.append(Text(f"... {len(raw_lines) - 12} more lines", style="dim #636e7b"))
        return preview_lines

    lines: list[Text] = []
    summary_line = next((line.strip() for line in todo_text.splitlines() if line.strip()), "")
    if summary_line:
        lines.append(Text(summary_line, style="#adbac7"))

    shown_tasks = todo_tasks[:_MAX_TODO_RENDER_TASKS]
    hidden_count = len(todo_tasks) - len(shown_tasks)
    for task in shown_tasks:
        status = _normalize_todo_status(task.get("status"))
        icon, style = _TODO_DISPLAY.get(status, ("•", "dim #636e7b"))
        task_id = str(task.get("id") or "task").strip() or "task"
        content = str(task.get("content") or "").strip()

        row = Text()
        row.append(f"{icon}  ", style=style)
        row.append(task_id, style=style)
        if content:
            row.append(f"  {content}", style=style)
        lines.append(row)

        if status != "in_progress":
            continue

        for child in child_sessions:
            child_row = Text("   └─ ", style="dim #539bf5")
            child_row.append(f"{_child_role_badge(child):<4} ", style="bold #539bf5")
            child_row.append(_child_title(child), style="#adbac7")

            if mode == "telemetry":
                child_status = str(getattr(child, "status", "") or "").strip().lower() or "unknown"
                tokens_in = _normalize_token_count(getattr(child, "total_tokens_in", 0))
                tokens_out = _normalize_token_count(getattr(child, "total_tokens_out", 0))
                pct = _normalize_context_pct(
                    getattr(child, "context_usage_pct", None)
                    if getattr(child, "context_usage_pct", None) is not None
                    else getattr(child, "context_pct", None)
                )
                pct = 0 if pct is None else pct

                filled = max(0, min(10, int(round(pct / 10))))
                bar = f"{'█' * filled}{'░' * (10 - filled)}"
                if pct > 80:
                    ctx_style = "#f85149"
                elif pct > 50:
                    ctx_style = "#d29922"
                else:
                    ctx_style = "#539bf5"

                child_row.append(f"  {child_status}", style="dim #8b949e")
                child_row.append(
                    f"  {_format_token_count(tokens_in)}↑ {_format_token_count(tokens_out)}↓",
                    style="dim #adbac7",
                )
                child_row.append(f"  {pct:>3d}% ", style=f"dim {ctx_style}")
                child_row.append(bar, style=f"bold {ctx_style}")
            else:
                pct = _normalize_context_pct(
                    getattr(child, "context_usage_pct", None)
                    if getattr(child, "context_usage_pct", None) is not None
                    else getattr(child, "context_pct", None)
                )
                if pct is not None:
                    filled = max(0, min(10, int(round(pct / 10))))
                    bar = f"{'█' * filled}{'░' * (10 - filled)}"
                    child_row.append(f"  {pct:>3d}% ", style="dim #539bf5")
                    child_row.append(
                        bar,
                        style="bold #f85149" if pct >= 80 else "bold #d4a72c",
                    )
            lines.append(child_row)

    if hidden_count > 0:
        lines.append(Text(f"... {hidden_count} more", style="dim #636e7b"))

    return lines
def _truncate_lines(value: str, max_lines: int = _MAX_MESSAGE_LINES) -> list[str]:
    lines = (value or "").splitlines()
    if not lines:
        return [""]
    if len(lines) <= max_lines:
        return lines
    omitted = len(lines) - max_lines
    return lines[:max_lines] + [f"… ({omitted} more lines)"]


def _append_user_line(target: Text, line: str, body_style: str, ref_style: str) -> None:
    cursor = 0
    for match in _AT_FILE_RE.finditer(line):
        start, end = match.span()
        if start > cursor:
            target.append(line[cursor:start], style=body_style)
        target.append(match.group(0), style=ref_style)
        cursor = end
    if cursor < len(line):
        target.append(line[cursor:], style=body_style)


def _truncate_rendered_lines(lines: list[Text], max_lines: int = _MAX_MESSAGE_LINES) -> list[Text]:
    if not lines:
        return [Text("")]
    if len(lines) <= max_lines:
        return lines
    omitted = len(lines) - max_lines
    return lines[:max_lines] + [Text(f"… ({omitted} more lines)", style="#636e7b")]


def _contains_markdown_indicators(content: str) -> bool:
    if not content:
        return False
    if "**" in content or "```" in content:
        return True
    for line in content.splitlines():
        stripped = line.lstrip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith("- ") or stripped.startswith("> "):
            return True
        if _MARKDOWN_ORDERED_LIST_RE.match(stripped):
            return True
    return False


def _render_renderable_to_ansi(renderable: Any, width: int) -> str:
    sio = StringIO()
    console = Console(
        file=sio,
        width=max(40, int(width or 80)),
        highlight=False,
        force_terminal=True,
        color_system="truecolor",
    )
    console.print(renderable)
    return sio.getvalue()


def _render_markdown_to_ansi(md_content: str, width: int = 100) -> str:
    """Render markdown to ANSI text via rich.Markdown."""
    try:
        return _render_renderable_to_ansi(Markdown(md_content, code_theme="monokai"), width)
    except Exception:
        return md_content


def _render_code_block_to_ansi(code: str, language: str, width: int) -> str:
    lexer = language or "text"
    try:
        syntax = Syntax(code.rstrip("\n"), lexer, theme="monokai", word_wrap=True, line_numbers=False)
        return _render_renderable_to_ansi(syntax, width)
    except Exception:
        fallback = code.rstrip("\n")
        fence = f"```{language}" if language else "```"
        return f"{fence}\n{fallback}\n```"


def _ansi_to_text_lines(payload: str) -> list[Text]:
    lines = payload.splitlines()
    if not lines:
        return [Text("")]
    converted: list[Text] = []
    for line in lines:
        try:
            converted.append(Text.from_ansi(line))
        except Exception:
            converted.append(Text(line))
    return converted


def _build_mermaid_box(diagram: str, width: int) -> list[Text]:
    total_width = max(36, min(96, int(width or 80)))
    header = " DIAGRAM (mermaid) "
    filler = "─" * max(1, total_width - len(header) - 3)
    body_width = total_width - 4

    lines = ["[mermaid diagram — open in browser]"]
    for raw_line in diagram.strip().splitlines():
        cleaned = raw_line.rstrip()
        if cleaned:
            lines.append(cleaned)

    rendered = [Text(f"┌─{header}{filler}┐")]
    for line in lines:
        wrapped = textwrap.wrap(
            line,
            width=body_width,
            replace_whitespace=False,
            drop_whitespace=False,
        ) or [""]
        for chunk in wrapped:
            rendered.append(Text(f"│ {chunk.ljust(body_width)} │"))
    rendered.append(Text("└" + ("─" * (total_width - 2)) + "┘"))
    return rendered


def _render_message_body_lines(content: str, width: int, *, max_lines: Optional[int] = _MAX_MESSAGE_LINES) -> list[Text]:
    text = str(content or "")
    if not text:
        return [Text("")]

    rendered_lines: list[Text] = []
    cursor = 0
    for match in _FENCED_CODE_BLOCK_RE.finditer(text):
        start, end = match.span()
        if start > cursor:
            prefix = text[cursor:start]
            if _contains_markdown_indicators(prefix):
                rendered_lines.extend(_ansi_to_text_lines(_render_markdown_to_ansi(prefix, width=width)))
            else:
                rendered_lines.extend(Text(line) for line in (prefix.splitlines() or [""]))

        language = str(match.group(1) or "").strip().lower()
        code = str(match.group(2) or "")
        if language == "mermaid":
            mermaid_match = _MERMAID_RE.match(match.group(0))
            mermaid_body = mermaid_match.group(1) if mermaid_match else code
            rendered_lines.extend(_build_mermaid_box(mermaid_body, width=width))
        else:
            rendered_lines.extend(_ansi_to_text_lines(_render_code_block_to_ansi(code, language, width)))
        cursor = end

    tail = text[cursor:]
    if tail:
        if _contains_markdown_indicators(tail):
            rendered_lines.extend(_ansi_to_text_lines(_render_markdown_to_ansi(tail, width=width)))
        else:
            rendered_lines.extend(Text(line) for line in (tail.splitlines() or [""]))

    if not rendered_lines:
        rendered_lines = [Text("")]
    if max_lines is None:
        return rendered_lines
    return _truncate_rendered_lines(rendered_lines, max_lines=max_lines)
def parse_conversation_from_jsonl(
    jsonl_path: str | Path,
    max_messages: int = _MAX_PREVIEW_MESSAGES,
) -> list[dict[str, Any]]:
    """Parse a JSONL file into a list of conversation events."""
    path = Path(jsonl_path).expanduser()
    if not path.exists() or not path.is_file():
        return []

    try:
        lines = _read_jsonl_tail(path)
    except OSError:
        return []

    events: list[dict[str, Any]] = []
    todo_items: list[tuple[str, str]] = []
    session_harness = ""

    def _append_skill_event(skill_name: str, timestamp_value: str, harness_hint: str = "") -> None:
        normalized = _normalize_skill_name(skill_name)
        if not normalized:
            return
        event: dict[str, Any] = {"kind": "skill", "timestamp": timestamp_value, "skill": normalized}
        harness_value = (harness_hint or session_harness).strip().lower()
        if harness_value:
            event["harness"] = harness_value
        events.append(event)

    def _append_detected_skills(timestamp_value: str, *chunks: str, harness_hint: str = "") -> None:
        for skill_name in _detect_skills(*chunks):
            _append_skill_event(skill_name, timestamp_value, harness_hint=harness_hint)
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

        timestamp = _format_timestamp(obj.get("timestamp"))
        record_harness = str(obj.get("harness") or "").strip().lower()
        if record_harness:
            session_harness = record_harness
        role = str(obj.get("role") or "").strip().lower()
        if role in {"user", "assistant", "system"}:
            merged = "\n".join(_extract_text_parts(obj.get("content"))).strip()
            if role in {"user", "assistant"} and merged:
                events.append(
                    {
                        "kind": role,
                        "timestamp": timestamp,
                        "text": merged,
                        "model": str(obj.get("model") or obj.get("model_name") or "").strip(),
                    }
                )
            if merged:
                _append_detected_skills(timestamp, merged, harness_hint=record_harness or session_harness)
        record_type = str(obj.get("type") or "").lower()
        if record_type in {"message", "model_change"} and not session_harness:
            session_harness = "omp"

        if record_type == "message":
            session_title = str(obj.get("title") or "").strip()
            session_cwd = str(obj.get("cwd") or "").strip()
            if session_title or session_cwd:
                events.append(
                    {
                        "kind": "session_start",
                        "timestamp": timestamp,
                        "title": session_title or "(untitled session)",
                        "cwd": session_cwd or "(unknown cwd)",
                    }
                )
            skills = obj.get("skills")
            if isinstance(skills, list):
                for skill_name in skills:
                    if isinstance(skill_name, str):
                        _append_skill_event(skill_name, timestamp, harness_hint=session_harness or "omp")

        if record_type == "model_change":
            events.append(
                {
                    "kind": "model_change",
                    "timestamp": timestamp,
                    "model": str(obj.get("model") or obj.get("model_name") or "unknown").strip() or "unknown",
                    "role": str(obj.get("role") or "default").strip().lower() or "default",
                }
            )

        if record_type in {"tool_use", "toolcall", "tool_call"}:
            tool_name = str(obj.get("name") or "tool")
            args = obj.get("input") if obj.get("input") is not None else obj.get("arguments")
            events.append(
                {
                    "kind": "tool_call",
                    "timestamp": timestamp,
                    "tool": tool_name,
                    "args": args,
                    "summary": _summarize_tool_call(tool_name, args),
                }
            )
            arg_text = json.dumps(args, ensure_ascii=False) if args is not None else ""
            _append_detected_skills(
                timestamp,
                tool_name,
                arg_text,
                str(args),
                harness_hint=record_harness or session_harness,
            )
            if _is_todo_tool_name(tool_name):
                extracted = _extract_todo_items(args)
                if extracted:
                    todo_items = extracted
        if record_type in {"tool_result", "toolresult"}:
            payload = obj.get("content") if obj.get("content") is not None else obj.get("output")
            parts = _extract_text_parts(payload)
            merged = "\n".join(parts).strip() if parts else str(payload or "").strip()
            if merged:
                events.append({"kind": "tool_result", "timestamp": timestamp, "text": merged})

        message = obj.get("message")
        if not isinstance(message, dict):
            continue

        msg_role = str(message.get("role") or "").strip().lower()
        msg_content = message.get("content")
        msg_timestamp = _format_timestamp(message.get("timestamp") or obj.get("timestamp"))
        msg_model = str(message.get("model") or message.get("model_name") or obj.get("model") or "").strip()

        merged_text = "\n".join(_extract_text_parts(msg_content)).strip()
        if msg_role in {"user", "assistant"} and merged_text:
            events.append(
                {
                    "kind": msg_role,
                    "timestamp": msg_timestamp,
                    "text": merged_text,
                    "model": msg_model,
                }
            )
        if msg_role in {"user", "assistant", "system"} and merged_text:
            _append_detected_skills(msg_timestamp, merged_text, harness_hint=session_harness)
        for tool_call in _iter_tool_calls(msg_content):
            tool_name = str(tool_call.get("name") or "tool")
            args = tool_call.get("args")
            call_ts = _format_timestamp(tool_call.get("timestamp") or obj.get("timestamp"))
            events.append(
                {
                    "kind": "tool_call",
                    "timestamp": call_ts,
                    "tool": tool_name,
                    "args": args,
                    "summary": _summarize_tool_call(tool_name, args),
                }
            )
            arg_text = json.dumps(args, ensure_ascii=False) if args is not None else ""
            _append_detected_skills(call_ts, tool_name, arg_text, str(args), harness_hint=session_harness)
            if _is_todo_tool_name(tool_name):
                extracted = _extract_todo_items(args)
                if extracted:
                    todo_items = extracted

        for tool_result in _iter_tool_results(msg_content):
            text = str(tool_result.get("text") or "").strip()
            if not text:
                continue
            events.append(
                {
                    "kind": "tool_result",
                    "timestamp": _format_timestamp(tool_result.get("timestamp") or obj.get("timestamp")),
                    "text": text,
                }
            )

    if max_messages > 0 and len(events) > max_messages:
        events = events[-max_messages:]

    if todo_items:
        seen: set[str] = set()
        normalized: list[tuple[str, str]] = []
        for status, content in reversed(todo_items):
            key = content.strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            normalized.append((status, content))
        normalized.reverse()
        events.append({"kind": "todo_list", "items": normalized[-12:]})

    return events


def render_conversation_preview(
    messages: list[dict[str, Any]],
    width: int = 80,
    theme: str = "github-dark",
    session: Optional[dict[str, Any]] = None,
    todo_text: str = "",
    todo_tasks: Optional[list[dict[str, str]]] = None,
    child_sessions: Optional[list[Any]] = None,
    session_sidebar_mode: str = "telemetry",
    always_show_tasks: bool = False,
) -> Text:
    """Render a list of conversation events into a Rich Text object."""
    result = Text()
    border = "#6e7681"
    dark = "light" not in theme.lower()
    body = "#c9d1d9" if dark else "#24292f"
    ref_style = "bold #d2a8ff" if dark else "bold #8250df"

    role_style = {
        "user": "bold #58a6ff" if dark else "bold #0969da",
        "assistant": "bold #3fb950" if dark else "bold #1a7f37",
        "tool_call": "bold #d29922" if dark else "bold #9a6700",
        "tool_result": "bold #a371f7" if dark else "bold #8250df",
        "skill": "bold #ff7b72" if dark else "bold #cf222e",
        "model_change": "bold #79c0ff" if dark else "bold #0969da",
        "session_start": "bold #ffa657" if dark else "bold #9a6700",
        "todo_list": "bold #56d364" if dark else "bold #1a7f37",
    }

    session_meta: dict[str, str] = {}
    if isinstance(session, dict):
        for key in ("title", "name", "harness", "role", "branch", "cwd"):
            value = str(session.get(key) or "").strip()
            if value:
                session_meta[key] = value

    for event in messages:
        if str(event.get("kind") or "") != "session_start":
            continue
        if "title" not in session_meta:
            inferred_title = str(event.get("title") or "").strip()
            if inferred_title:
                session_meta["title"] = inferred_title
        if "cwd" not in session_meta:
            inferred_cwd = str(event.get("cwd") or "").strip()
            if inferred_cwd:
                session_meta["cwd"] = inferred_cwd
        break

    title = session_meta.get("title") or session_meta.get("name") or "Untitled Session"
    harness = session_meta.get("harness") or "omp"
    role = session_meta.get("role") or ""
    branch = session_meta.get("branch") or "?"
    cwd = session_meta.get("cwd") or "?"

    result.append("\n")
    result.append(f" {title} ", style="bold white on #1e3a5f")
    result.append("\n")
    result.append(f" {harness.upper()} ", style="bold cyan")
    if role:
        result.append(f" {role.upper()} ", style="bold #f0883e")
    result.append(f" {branch} ", style="dim green")
    result.append("\n")
    result.append(f" {cwd} ", style="dim #636e7b")
    result.append("\n")
    result.append("─" * max(40, int(width or 80)))
    result.append("\n\n")

    def _display_width(text: str) -> int:
        """Calculate terminal display width, counting emoji/wide chars as 2 columns."""
        try:
            import unicodedata

            width = 0
            for ch in text:
                eaw = unicodedata.east_asian_width(ch)
                if eaw in ("W", "F"):
                    width += 2
                else:
                    width += 1
            return width
        except Exception:
            return len(text)

    def append_box(title: str, lines: Sequence[str | Text], style: str, *, user_mode: bool = False) -> None:
        box_width = max(48, int(width or 80))
        filler = "─" * max(6, box_width - _display_width(title) - 5)
        result.append("╭─ ", style=border)
        result.append(title, style=style)
        result.append(" ", style=border)
        result.append(filler, style=border)
        result.append("\n", style=border)

        for line in lines or [""]:
            result.append("│ ", style=border)
            if isinstance(line, Text):
                result.append_text(line)
            elif user_mode:
                _append_user_line(result, line, body, ref_style)
            else:
                result.append(line, style=body)
            result.append("\n")

        result.append("╰", style=border)
        result.append("─" * max(10, box_width - 1), style=border)
        result.append("\n\n")

    live_todo_text = todo_text.strip()
    parsed_todo_tasks = todo_tasks or []
    preview_children = child_sessions or []
    sidebar_mode = _normalized_sidebar_mode(session_sidebar_mode)
    if live_todo_text or always_show_tasks:
        append_box(
            "TASKS",
            _render_live_tasks_lines(
                live_todo_text,
                parsed_todo_tasks,
                preview_children,
                sidebar_mode=sidebar_mode,
            ),
            role_style["todo_list"],
        )

    for message in messages:
        kind = str(message.get("kind") or "")
        timestamp = str(message.get("timestamp") or "--:--:--")

        if kind == "user":
            append_box(
                f"👤 USER  [{timestamp}]",
                _truncate_lines(str(message.get("text") or "")),
                role_style["user"],
                user_mode=True,
            )
            continue

        if kind == "assistant":
            model = str(message.get("model") or "").strip()
            model_suffix = f" ── {model}" if model else ""
            assistant_lines = _render_message_body_lines(
                str(message.get("text") or ""),
                width=max(40, int(width or 80) - 6),
                max_lines=None,
            )
            msg_id = str(message.get("id") or message.get("timestamp") or id(message))
            if _ALL_MESSAGES_EXPANDED:
                _EXPANDED_MESSAGES.add(msg_id)
            is_expanded = _ALL_MESSAGES_EXPANDED or msg_id in _EXPANDED_MESSAGES
            shown_lines = assistant_lines
            if len(assistant_lines) > _COLLAPSED_ASSISTANT_LINES and not is_expanded:
                hidden = len(assistant_lines) - _COLLAPSED_ASSISTANT_LINES
                shown_lines = assistant_lines[:_COLLAPSED_ASSISTANT_LINES]
                shown_lines.append(
                    Text(
                        f"  ↕  {hidden} more lines hidden  [ click here or Ctrl+E to expand ]",
                        style="bold #539bf5",
                    )
                )
            append_box(
                f"🤖 ASSISTANT  [{timestamp}]{model_suffix}",
                shown_lines,
                role_style["assistant"],
            )
            continue

        if kind == "tool_call":
            tool_name = str(message.get("tool") or "tool")
            tool_name_lower = tool_name.lower()
            raw_args = message.get("args") or message.get("input") or {}
            summary = str(message.get("summary") or "").strip()

            _SUBAGENT_TOOLS = {"task", "proxy_task", "Task", "spawn_agent"}
            if tool_name in _SUBAGENT_TOOLS or tool_name_lower in _SUBAGENT_TOOLS:
                agent_type = ""
                task_count = 0
                task_descriptions: list[str] = []
                if isinstance(raw_args, dict):
                    agent_type = str(raw_args.get("agent") or raw_args.get("subagent_type") or "")
                    tasks = raw_args.get("tasks") or []
                    if isinstance(tasks, list):
                        task_count = len(tasks)
                        for task in tasks[:5]:
                            if isinstance(task, dict):
                                task_id = str(task.get("id") or "")
                                task_desc = str(task.get("description") or task.get("assignment", ""))[:60]
                                task_descriptions.append(
                                    f"  [{task_id}] {task_desc}" if task_id else f"  {task_desc}"
                                )
                header = f"🤖 SUBAGENT SPAWN: {agent_type or 'task'}  [{timestamp}]"
                if task_count > 0:
                    body_lines = [f"{task_count} task(s) spawned:"] + task_descriptions
                    if task_count > 5:
                        body_lines.append(f"  ... and {task_count - 5} more")
                else:
                    body_lines = [summary or "(spawning subagent)"]
                append_box(header, body_lines, "#f0883e bold")
                continue

            _MCP_PREFIXES = ("mcp_", "proxy_mcp_")
            if any(tool_name_lower.startswith(prefix) for prefix in _MCP_PREFIXES):
                mcp_name = tool_name.replace("proxy_mcp_", "").replace("mcp_", "")
                mcp_summary = summary
                if not mcp_summary and isinstance(raw_args, dict):
                    try:
                        mcp_summary = json.dumps(raw_args, ensure_ascii=False)[:120]
                    except Exception:
                        mcp_summary = str(raw_args)[:120]
                append_box(
                    f"🔌 MCP: {mcp_name}  [{timestamp}]",
                    _truncate_lines(mcp_summary or "(no arguments)", max_lines=3),
                    "#8b949e",
                )
                continue

            append_box(
                f"🔧 TOOL: {tool_name}  [{timestamp}]",
                _truncate_lines(summary or "(no arguments)", max_lines=4),
                role_style["tool_call"],
            )
            continue

        if kind == "tool_result":
            text = str(message.get("text") or "").strip()
            display_text = text
            if display_text[:1] in {"{", "["}:
                try:
                    parsed = json.loads(display_text)
                    pretty = json.dumps(parsed, ensure_ascii=False, indent=2)
                    display_text = pretty[:150] + ("…" if len(pretty) > 150 else "")
                except Exception:
                    pass
            is_error = bool(message.get("is_error")) or "error" in text[:50].lower()
            result_style = "#f85149" if is_error else role_style["tool_result"]
            icon = "❌" if is_error else "📤"
            inline_result = display_text.replace("\n", " ").strip()
            if 0 < len(inline_result) < 80:
                result.append(f"{icon} RESULT  [{timestamp}] ", style=result_style)
                result.append(inline_result, style=body)
                result.append("\n\n")
                continue
            append_box(
                f"{icon} RESULT  [{timestamp}]",
                _truncate_lines(display_text, max_lines=6),
                result_style,
            )
            continue

        if kind == "model_change":
            model = str(message.get("model") or "unknown").strip() or "unknown"
            model_role = str(message.get("role") or "default").strip().lower() or "default"
            append_box(
                f"🔄 MODEL CHANGE: {model} | role: {model_role}",
                [f"Recorded at {timestamp}"],
                role_style["model_change"],
            )
            continue

        if kind == "session_start":
            session_title = str(message.get("title") or "(untitled session)").strip() or "(untitled session)"
            session_cwd = str(message.get("cwd") or "(unknown cwd)").strip() or "(unknown cwd)"
            append_box(
                f"📂 SESSION: {session_title} | cwd: {session_cwd}",
                [f"Started at {timestamp}"],
                role_style["session_start"],
            )
            continue

        if kind == "skill":
            skill_name = str(message.get("skill") or "unknown")
            skill_key = skill_name.strip().lower()
            skill_prefix = "⚡ OMP SKILL" if str(message.get("harness") or "").strip().lower() == "omp" else "⚡ SKILL"
            skill_body_lines = [f"Loaded: {skill_name}"]
            desc = _SKILL_DESCRIPTIONS.get(skill_key)
            if desc:
                skill_body_lines.append(f"  {desc}")
            append_box(
                f"{skill_prefix}: {skill_name}  [{timestamp}]",
                skill_body_lines,
                role_style["skill"],
            )
            continue

        if kind == "todo_list":
            if live_todo_text:
                continue
            lines: list[str] = []
            for status, content in message.get("items") or []:
                key = str(status or "pending").lower()
                icon = _STATUS_ICON.get(key, "•")
                lines.append(f"{icon} {content}")
            append_box(
                "📝 TODO ITEMS",
                lines or ["No todo items found"],
                role_style["todo_list"],
            )

    return result if result.plain.strip() else Text("[no conversation events]", style="#636e7b")


def _extract_resume_session_path(resume_command: str | None) -> Optional[Path]:
    if not resume_command:
        return None
    patterns = [
        r"--session\s+'([^']+)'",
        r'--session\s+"([^"]+)"',
        r"--session\s+([^\s]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, resume_command)
        if not match:
            continue
        candidate = Path(match.group(1)).expanduser()
        if candidate.exists() and candidate.is_file():
            return candidate
        return candidate
    return None


def _get_session_jsonl_path(session: Any) -> Optional[Path]:
    """Find the JSONL file for a given session."""
    explicit_path = getattr(session, "session_file_path", None)
    if isinstance(explicit_path, str) and explicit_path.strip():
        path = Path(explicit_path).expanduser()
        if path.exists() and path.is_file():
            return path

    resume_path = _extract_resume_session_path(getattr(session, "resume_command", None))
    if resume_path is not None and resume_path.exists() and resume_path.is_file():
        return resume_path

    session_id = str(getattr(session, "session_id", "") or "").strip()
    if not session_id:
        return None

    maybe_path = Path(session_id).expanduser()
    if maybe_path.suffix == ".jsonl" and maybe_path.exists() and maybe_path.is_file():
        return maybe_path

    roots = [
        Path("~/.omp/agent/sessions").expanduser(),
        Path("~/.omp/agent/.omp/sessions").expanduser(),
        Path("~/.omp/sessions").expanduser(),
    ]
    for root in roots:
        if not root.exists():
            continue
        exact = root / f"{session_id}.jsonl"
        if exact.exists() and exact.is_file():
            return exact
        try:
            for path in root.glob(f"**/*_{session_id}.jsonl"):
                if path.is_file():
                    return path
            for path in root.glob(f"**/*{session_id}*.jsonl"):
                if path.is_file():
                    return path
        except Exception:
            continue

    return resume_path if resume_path and resume_path.exists() else None


def _render_for_selected_session(app: Any, session: Any) -> Text:
    jsonl_path = _get_session_jsonl_path(session)
    messages: list[dict[str, Any]] = []
    todo_text = ""
    todo_tasks: list[dict[str, str]] = []
    recent_children: list[Any] = []

    if jsonl_path is not None:
        messages = parse_conversation_from_jsonl(jsonl_path)
        todo_text = _extract_latest_todo_state(jsonl_path)
        todo_tasks = _parse_todo_text(todo_text) if todo_text else []
        if any(str(task.get("status") or "") == "in_progress" for task in todo_tasks):
            recent_children = _collect_recent_child_sessions(app, session)

    width = 80
    try:
        preview = app.query_one("#preview-content")
        width = max(48, int(getattr(preview.size, "width", 80)) - 4)
    except Exception:
        pass

    theme = "github-dark"
    try:
        theme_obj = getattr(app, "_theme", None)
        if isinstance(theme_obj, dict):
            theme = str(theme_obj.get("name") or theme)
    except Exception:
        pass

    sidebar_mode = _normalized_sidebar_mode(
        getattr(app, "_session_telemetry_sidebar_mode", _SESSION_TELEMETRY_SIDEBAR_MODES[0])
    )
    session_meta = {
        "title": str(getattr(session, "title", "") or "").strip(),
        "name": str(getattr(session, "name", "") or "").strip(),
        "harness": str(getattr(session, "harness", "omp") or "omp").strip(),
        "role": str(getattr(session, "role", "") or "").strip(),
        "branch": str(getattr(session, "branch", "") or "?").strip() or "?",
        "cwd": str(getattr(session, "cwd", "") or "").strip(),
    }

    return render_conversation_preview(
        messages,
        width=width,
        theme=theme,
        session=session_meta,
        todo_text=todo_text,
        todo_tasks=todo_tasks,
        child_sessions=recent_children,
        session_sidebar_mode=sidebar_mode,
        always_show_tasks=True,
    )

def _patch_app() -> None:
    try:
        from textual.binding import Binding
        from textual.widgets import Static

        app_module = importlib.import_module("agents_view.app")
        AgentsViewApp = getattr(app_module, "AgentsViewApp", None)
        HelpScreen = getattr(app_module, "HelpScreen", None)
        if AgentsViewApp is None or HelpScreen is None:
            return
    except Exception:
        return

    if getattr(AgentsViewApp, "_conversation_preview_feature_patched", False):
        return

    original_init = getattr(AgentsViewApp, "__init__", None)
    original_update_preview = getattr(AgentsViewApp, "_update_preview", None)
    original_apply_worker_preview = getattr(AgentsViewApp, "_apply_worker_preview", None)
    if not callable(original_init) or not callable(original_update_preview):
        return

    def _ensure_preview_mouse_isolation(self: Any) -> None:
        if bool(getattr(self, "_conversation_preview_mouse_isolated", False)):
            return
        try:
            preview_panel = self.query_one("#preview-panel")
        except Exception:
            return

        def _stop_mouse_event(self_widget: Any, event: Any) -> None:
            try:
                event.stop()
            except Exception:
                pass
            try:
                event.prevent_default()
            except Exception:
                pass

        try:
            preview_panel.on_mouse_move = types.MethodType(_stop_mouse_event, preview_panel)


            try:
                preview_content = self.query_one("#preview-content")
                if hasattr(preview_content, "styles"):
                    preview_content.styles.display = "block"
            except Exception:
                pass

            self._conversation_preview_mouse_isolated = True
        except Exception:
            pass

    def _init_with_conversation_preview(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        if not hasattr(self, "_conversation_preview_mode"):
            self._conversation_preview_mode = True
        if not hasattr(self, "_session_telemetry_sidebar_modes"):
            self._session_telemetry_sidebar_modes = _SESSION_TELEMETRY_SIDEBAR_MODES
        current_sidebar_mode = getattr(
            self, "_session_telemetry_sidebar_mode", _SESSION_TELEMETRY_SIDEBAR_MODES[0]
        )
        self._session_telemetry_sidebar_mode = _normalized_sidebar_mode(current_sidebar_mode)
        _ensure_preview_mouse_isolation(self)

    def _action_toggle_conversation_preview(self: Any) -> None:
        current = bool(getattr(self, "_conversation_preview_mode", False))
        self._conversation_preview_mode = not current
        self._preview_last_render_key = None
        try:
            state = "enabled" if self._conversation_preview_mode else "disabled"
            self.notify(f"Conversation preview {state}")
        except Exception:
            pass
        try:
            self._update_preview()
        except Exception:
            pass


    def _action_toggle_session_telemetry_sidebar(self: Any) -> None:
        raw_modes = getattr(
            self,
            "_session_telemetry_sidebar_modes",
            _SESSION_TELEMETRY_SIDEBAR_MODES,
        )
        if isinstance(raw_modes, (list, tuple)) and raw_modes:
            modes = tuple(
                mode
                for mode in (_normalized_sidebar_mode(value) for value in raw_modes)
                if mode in _SESSION_TELEMETRY_SIDEBAR_MODES
            ) or _SESSION_TELEMETRY_SIDEBAR_MODES
        else:
            modes = _SESSION_TELEMETRY_SIDEBAR_MODES

        current = _normalized_sidebar_mode(
            getattr(self, "_session_telemetry_sidebar_mode", modes[0])
        )
        try:
            current_idx = modes.index(current)
        except ValueError:
            current_idx = 0
        next_mode = modes[(current_idx + 1) % len(modes)]
        self._session_telemetry_sidebar_mode = next_mode
        self._preview_last_render_key = None
        try:
            self.notify(f"Session sidebar mode: {next_mode}")
        except Exception:
            pass
        try:
            self._update_preview()
        except Exception:
            pass
    def action_toggle_expand_preview_messages(self: Any) -> None:
        global _ALL_MESSAGES_EXPANDED
        _ALL_MESSAGES_EXPANDED = not _ALL_MESSAGES_EXPANDED
        if not _ALL_MESSAGES_EXPANDED:
            _EXPANDED_MESSAGES.clear()
        self._preview_last_render_key = None
        try:
            state = "expanded" if _ALL_MESSAGES_EXPANDED else "collapsed"
            self.notify(f"Assistant messages {state}")
        except Exception:
            pass
        try:
            self._update_preview()
        except Exception:
            pass

    def _update_preview_with_conversation(self: Any) -> None:
        original_update_preview(self)
        if not bool(getattr(self, "_conversation_preview_mode", False)):
            return

        session = getattr(self, "_selected_session", None)
        if session is None:
            return
        _ensure_preview_mouse_isolation(self)

        try:
            preview = self.query_one("#preview-content", Static)
            preview_status = self.query_one("#preview-status", Static)
        except Exception:
            return

        preview.update(_render_for_selected_session(self, session))
        try:
            scroll_container = self.query_one("#preview-panel")
            scroll_container.scroll_end(animate=False)
        except Exception:
            pass
        status_value = "Conversation view"
        preview_status_fn = getattr(self, "_preview_status_line", None)
        if callable(preview_status_fn):
            try:
                base = str(preview_status_fn(session) or "").strip()
            except Exception:
                base = ""
            if base:
                status_value = f"{base} · conversation"
        preview_status.update(status_value)

    def _apply_worker_preview_with_conversation(
        self: Any,
        session_id: str,
        rendered: Text,
        preview_render_key: tuple[object, ...],
        panel_title: str,
        status_line: str,
    ) -> None:
        _ensure_preview_mouse_isolation(self)
        if bool(getattr(self, "_conversation_preview_mode", False)):
            selected = getattr(self, "_selected_session", None)
            if selected is not None and str(getattr(selected, "session_id", "")) == session_id:
                rendered = _render_for_selected_session(self, selected)
                preview_render_key = preview_render_key + ("conversation",)
                status_line = f"{status_line} · conversation" if status_line else "Conversation view"

        if callable(original_apply_worker_preview):
            original_apply_worker_preview(
                self,
                session_id,
                rendered,
                preview_render_key,
                panel_title,
                status_line,
            )
        try:
            scroll_container = self.query_one("#preview-panel")
            scroll_container.scroll_end(animate=False)
        except Exception:
            pass

    _original_app_on_click = getattr(AgentsViewApp, "on_click", None)

    def _patched_app_on_click(self: Any, event: Any) -> None:
        """Bubble-up click handler: expand/collapse when clicking inside preview."""
        try:
            widget = getattr(event, "widget", None) or getattr(event, "sender", None)
            widget_id = getattr(widget, "id", None) or ""
            preview_ids = {"preview-content", "preview-panel", "preview-scroll"}
            in_preview = widget_id in preview_ids
            if not in_preview and widget is not None:
                try:
                    parent = widget.parent
                    for _ in range(4):
                        if parent is None:
                            break
                        if getattr(parent, "id", None) in preview_ids:
                            in_preview = True
                            break
                        parent = getattr(parent, "parent", None)
                except Exception:
                    pass
            if in_preview:
                try:
                    self.action_toggle_expand_preview_messages()
                    event.stop()
                except Exception:
                    pass
                return
        except Exception:
            pass

        if _original_app_on_click is not None:
            try:
                _original_app_on_click(self, event)
            except Exception:
                pass

    AgentsViewApp.on_click = _patched_app_on_click  # type: ignore[method-assign,attr-defined]
    AgentsViewApp.__init__ = _init_with_conversation_preview  # type: ignore[method-assign]
    AgentsViewApp.action_toggle_conversation_preview = _action_toggle_conversation_preview  # type: ignore[method-assign,attr-defined]
    AgentsViewApp.action_toggle_session_telemetry_sidebar = _action_toggle_session_telemetry_sidebar  # type: ignore[method-assign,attr-defined]
    AgentsViewApp.action_toggle_expand_preview_messages = action_toggle_expand_preview_messages  # type: ignore[method-assign,attr-defined]
    AgentsViewApp._update_preview = _update_preview_with_conversation  # type: ignore[method-assign]
    if callable(original_apply_worker_preview):
        AgentsViewApp._apply_worker_preview = _apply_worker_preview_with_conversation  # type: ignore[method-assign]

    help_row = ("Preview", "ctrl+p", "Toggle conversation view")
    expand_help_row = ("Preview", "ctrl+e", "Expand/collapse messages")
    bindings_table = getattr(HelpScreen, "_BINDINGS_TABLE", None)
    if isinstance(bindings_table, list):
        for idx, row in enumerate(bindings_table):
            if len(row) < 3:
                continue
            section, key = str(row[0]).lower(), str(row[1]).lower()
            if section == "preview" and key == "ctrl+p" and row != help_row:
                bindings_table[idx] = help_row
            if section == "preview" and key in {"e", "ctrl+e"} and row != expand_help_row:
                bindings_table[idx] = expand_help_row

    key_taken = any(
        str(getattr(binding, "key", "")).lower() == "ctrl+p"
        for binding in getattr(AgentsViewApp, "BINDINGS", [])
    )
    palette_taken = str(getattr(AgentsViewApp, "COMMAND_PALETTE_BINDING", "")).lower() == "ctrl+p"

    if not key_taken and not palette_taken:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding("ctrl+p", "toggle_conversation_preview", "Toggle conversation"),
        ]
        if isinstance(bindings_table, list) and help_row not in bindings_table:
            bindings_table.append(help_row)

    expand_key_taken = any(
        str(getattr(binding, "key", "")).lower() in ("e", "ctrl+e")
        for binding in getattr(AgentsViewApp, "BINDINGS", [])
    )
    if not expand_key_taken:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding("ctrl+e", "toggle_expand_preview_messages", "Expand/collapse messages"),
        ]
        if isinstance(bindings_table, list) and expand_help_row not in bindings_table:
            bindings_table.append(expand_help_row)

    AgentsViewApp._conversation_preview_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

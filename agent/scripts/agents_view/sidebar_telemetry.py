from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable, Optional

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents_view.adapters.active_tmux_adapter import (
    ActiveTmuxAdapter,
    _detect_omp_status,
    _read_jsonl_head_lines,
    _read_jsonl_tail_lines,
)
from agents_view.features.conversation_preview import (
    _extract_latest_todo_state,
    _parse_todo_text,
)
from agents_view.tmux_client import TmuxClient
from agents_view.utils import (
    extract_last_mc_model,
    extract_last_mc_role,
    parse_token_usage_from_jsonl,
)

_SESSION_ID_RE = re.compile(r"_([0-9a-f]+)\.jsonl$", re.IGNORECASE)
_TELEMETRY_ALIASES = {"telemetry", "tasks", "task", "status"}
_EXPLORER_ALIASES = {"explorer", "tree", "files", "file", "filetree", "yazi"}
_ACTIVE_CHILD_STATUSES = {
    "running",
    "delegating",
    "asking",
    "review",
    "wait",
    "waiting",
    "stalled",
}
_ACTIVE_STATUSES = {"in_progress", "running", "active", "delegating", "asking"}
_DONE_STATUSES = {"completed", "complete", "done", "agent_done", "success"}
_ABANDONED_STATUSES = {"abandoned", "cancelled", "canceled", "failed", "error", "stalled"}
_SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
_TASK_REF_RE = re.compile(r"\b(task-\d+|[a-z]+-\d[\w-]*)\b", re.IGNORECASE)

_ANSI_RESET = "\033[0m"
_ANSI_ACTIVE = "\033[1;38;5;226m"   # bold bright-yellow
_ANSI_PENDING = "\033[38;5;240m"   # dark gray (clearly muted vs default)
_ANSI_DONE = "\033[38;5;71m"      # muted green
_ANSI_ABANDONED = "\033[38;5;203m" # orange-red
_ANSI_DIM = "\033[38;5;238m"      # very dim for decorative text


@dataclass
class SidebarSession:
    session_id: str
    title: str
    status: str
    role: str
    context_usage_pct: Optional[float]
    total_tokens_in: int
    total_tokens_out: int
    parent_session_id: Optional[str]
    tmux_window: str
    tmux_pane: str
    last_activity_ts: Optional[float]
    model: str
    session_file: Optional[Path]


def normalize_sidebar_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in _TELEMETRY_ALIASES:
        return "telemetry"
    if normalized in _EXPLORER_ALIASES:
        return "explorer"
    return ""


def normalize_sidebar_role(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "explorer", "left"}:
        return "explorer"
    if normalized in {"2", "telemetry", "right"}:
        return "telemetry"
    return ""


def resolve_sidebar_mode(env_mode: Any, tmux_mode: Any, pane_role: Any = None) -> str:
    env_resolved = normalize_sidebar_mode(env_mode)
    if env_resolved:
        return env_resolved
    tmux_resolved = normalize_sidebar_mode(tmux_mode)
    if tmux_resolved:
        return tmux_resolved
    role_resolved = normalize_sidebar_role(pane_role)
    if role_resolved == "explorer":
        return "explorer"
    if role_resolved == "telemetry":
        return "telemetry"
    return "telemetry"

def _extract_parent_session_id(session_file: Path) -> Optional[str]:
    try:
        with session_file.open("r", encoding="utf-8", errors="replace") as fh:
            first_line = fh.readline().strip()
    except OSError:
        return None
    if not first_line:
        return None

    try:
        first = json.loads(first_line)
    except json.JSONDecodeError:
        return None
    if not isinstance(first, dict):
        return None

    raw_parent = str(first.get("parentSessionId") or "").strip()
    if not raw_parent:
        return None

    match = _SESSION_ID_RE.search(raw_parent)
    if match:
        return match.group(1)
    return raw_parent


def _extract_session_file(resume_command: str) -> Optional[Path]:
    command = str(resume_command or "")
    if not command:
        return None

    quoted = re.search(r"omp\s+--session\s+['\"]([^'\"]+)['\"]", command)
    if quoted:
        candidate = Path(quoted.group(1))
        return candidate if candidate.exists() else None

    unquoted = re.search(r"omp\s+--session\s+([^\s]+)", command)
    if unquoted:
        candidate = Path(unquoted.group(1))
        return candidate if candidate.exists() else None

    return None


def _normalize_tokens(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _as_sidebar_session(raw: Any) -> SidebarSession:
    session_file = _extract_session_file(str(getattr(raw, "resume_command", "") or ""))
    usage = parse_token_usage_from_jsonl(str(session_file)) if session_file else {}
    return SidebarSession(
        session_id=str(getattr(raw, "session_id", "") or ""),
        title=str(getattr(raw, "title", "") or "").strip(),
        status=str(getattr(raw, "status", "") or "").strip().lower() or "unknown",
        role=str(getattr(raw, "role", "") or "").strip().lower(),
        context_usage_pct=getattr(raw, "context_usage_pct", None),
        total_tokens_in=_normalize_tokens(usage.get("total_tokens_in", 0)),
        total_tokens_out=_normalize_tokens(usage.get("total_tokens_out", 0)),
        parent_session_id=_extract_parent_session_id(session_file) if session_file else None,
        tmux_window=str(getattr(raw, "tmux_window", "") or ""),
        tmux_pane=str(getattr(raw, "tmux_pane", "") or ""),
        last_activity_ts=getattr(raw, "last_activity_ts", None),
        model=str(getattr(raw, "model", "") or "").strip(),
        session_file=session_file,
    )


def _spinner_frame(frame_index: int) -> str:
    return _SPINNER_FRAMES[int(frame_index) % len(_SPINNER_FRAMES)]


def _colorize(text: str, color: str) -> str:
    return f"{color}{text}{_ANSI_RESET}"


def _normalize_task_status(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in _ACTIVE_STATUSES:
        return "in_progress"
    if normalized in _DONE_STATUSES:
        return "done"
    if normalized in _ABANDONED_STATUSES:
        return "abandoned"
    if normalized in {"pending", "todo", "queued"}:
        return "pending"
    return normalized or "pending"


def _status_marker(status: str, frame_index: int) -> str:
    if status == "in_progress":
        return _colorize(_spinner_frame(frame_index), _ANSI_ACTIVE)
    if status == "pending":
        return _colorize("○", _ANSI_PENDING)
    if status == "done":
        return _colorize("✓", _ANSI_DONE)
    if status == "abandoned":
        return _colorize("✗", _ANSI_ABANDONED)
    return _colorize("•", _ANSI_DIM)


def _normalize_context_pct(value: Any) -> Optional[int]:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not numeric >= 0:
        return None
    if numeric <= 1.0:
        numeric *= 100.0
    return max(0, min(100, int(round(numeric))))


def _normalize_optional_tokens(value: Any) -> Optional[int]:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _format_tokens(value: Optional[int]) -> str:
    if value is None:
        return "—"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)


def _task_text_color(status: str) -> str:
    if status == "in_progress":
        return _ANSI_ACTIVE
    if status == "pending":
        return _ANSI_PENDING
    if status == "done":
        return _ANSI_DONE
    if status == "abandoned":
        return _ANSI_ABANDONED
    return _ANSI_DIM


def _sidebar_wrap_width(default: int = 80) -> int:
    columns = max(40, int(default))
    try:
        columns = max(40, int(shutil.get_terminal_size((columns, 20)).columns))
    except Exception:
        pass
    return max(20, columns - 4)


def _wrap_task_content(content: str, *, width: int) -> list[str]:
    raw = str(content or "").strip()
    if not raw:
        return []
    wrapped = textwrap.wrap(
        raw,
        width=max(20, int(width)),
        break_long_words=False,
        break_on_hyphens=False,
    )
    return wrapped or [raw]

def _extract_task_reference(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = _TASK_REF_RE.search(text)
    if not match:
        return ""
    return match.group(1).lower()


def _child_task_association(child: Any) -> str:
    for attr in ("task_id", "task", "task_ref", "assignment_id", "parent_task_id"):
        task_value = _extract_task_reference(getattr(child, attr, ""))
        if task_value:
            return task_value
    for attr in ("title", "session_id"):
        task_value = _extract_task_reference(getattr(child, attr, ""))
        if task_value:
            return task_value
    return ""


def render_live_sidebar_lines(
    todo_text: str,
    todo_tasks: list[dict[str, str]],
    child_sessions: list[Any],
    *,
    frame_index: int = 0,
) -> list[str]:
    if not todo_tasks:
        raw_lines = [line.rstrip() for line in todo_text.splitlines() if line.strip()]
        if not raw_lines:
            return ["(no active task list)"]
        preview_lines = raw_lines[:12]
        if len(raw_lines) > 12:
            preview_lines.append(f"... {len(raw_lines) - 12} more lines")
        return preview_lines

    lines: list[str] = []
    summary_line = next((line.strip() for line in todo_text.splitlines() if line.strip()), "")
    if summary_line:
        lines.append(summary_line)

    active_task_ids: list[str] = []
    task_children: dict[str, list[Any]] = {}
    for task in todo_tasks:
        task_id = str(task.get("id") or "task").strip().lower() or "task"
        if _normalize_task_status(task.get("status")) == "in_progress":
            active_task_ids.append(task_id)
            task_children[task_id] = []

    unlinked_children: list[Any] = []
    for child in child_sessions:
        association = _child_task_association(child)
        if association and association in task_children:
            task_children[association].append(child)
        else:
            unlinked_children.append(child)

    if active_task_ids and unlinked_children:
        task_children[active_task_ids[0]].extend(unlinked_children)

    wrap_width = _sidebar_wrap_width()
    for task in todo_tasks:
        status = _normalize_task_status(task.get("status"))
        task_id = str(task.get("id") or "task").strip() or "task"
        content = str(task.get("content") or "").strip()
        marker = _status_marker(status, frame_index)
        text_color = _task_text_color(status)

        # Combine ID and content on one line; wrap as a unit so the
        # entire label (not just the symbol) carries the status color.
        label = f"{task_id}  {content}".strip() if content else task_id
        segments = _wrap_task_content(label, width=max(20, wrap_width - 2))
        for i, segment in enumerate(segments):
            if i == 0:
                lines.append(f"{marker} {_colorize(segment, text_color)}")
            else:
                lines.append(f"  {_colorize(segment, text_color)}")

        if status != "in_progress":
            continue

        children = task_children.get(task_id.lower(), [])
        if not children:
            lines.append("   └─ (no active subagents)")
            continue

        for child in children:
            child_title = str(getattr(child, "title", "") or getattr(child, "session_id", "") or "(subagent)").strip()
            if not child_title:
                child_title = "(subagent)"
            child_status_raw = str(getattr(child, "status", "") or "unknown").strip().lower() or "unknown"
            child_status = _normalize_task_status(child_status_raw)
            child_marker = _status_marker(child_status, frame_index)
            tokens_in = _normalize_optional_tokens(getattr(child, "total_tokens_in", None))
            tokens_out = _normalize_optional_tokens(getattr(child, "total_tokens_out", None))
            role = str(getattr(child, "role", "") or "").strip().lower() or "(unknown)"
            model = str(getattr(child, "model", "") or "").strip() or "(unknown)"
            pct = _normalize_context_pct(
                getattr(child, "context_usage_pct", None)
                if getattr(child, "context_usage_pct", None) is not None
                else getattr(child, "context_pct", None)
            )
            context_label = f"{pct}%" if pct is not None else "—"
            child_task = _child_task_association(child) or "(unlinked)"

            lines.append(
                "   └─ "
                f"{child_marker} "
                f"task:{child_task} "
                f"{child_title} "
                f"status:{child_status_raw} "
                f"tok:{_format_tokens(tokens_in)}/{_format_tokens(tokens_out)} "
                f"role:{role} "
                f"model:{model} "
                f"ctx:{context_label}"
            )

    return lines


def _resolve_window_id(explicit_window_id: Optional[str]) -> Optional[str]:
    if explicit_window_id:
        return explicit_window_id

    pane_id = os.environ.get("TMUX_PANE", "").strip()
    target_args = ["-t", pane_id] if pane_id else []
    try:
        output = subprocess.run(
            ["tmux", "display-message", "-p", *target_args, "#{window_id}"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None

    value = output.stdout.strip()
    return value or None

def _choose_window_session(
    sessions: Iterable[SidebarSession],
    panes: Iterable[dict[str, Any]],
    *,
    window_id: str,
    sidebar_pane_id: str,
) -> Optional[SidebarSession]:
    pane_active = {
        str(pane.get("pane") or ""): bool(pane.get("active"))
        for pane in panes
        if str(pane.get("window") or "") == window_id
    }

    window_sessions = [
        session
        for session in sessions
        if session.tmux_window == window_id and session.tmux_pane and session.tmux_pane != sidebar_pane_id
    ]
    if not window_sessions:
        return None

    for session in window_sessions:
        if pane_active.get(session.tmux_pane, False):
            return session

    window_sessions.sort(key=lambda value: float(value.last_activity_ts or 0.0), reverse=True)
    return window_sessions[0]


def _child_rows_for_parent(
    sessions: Iterable[SidebarSession],
    *,
    parent_session_id: str,
) -> list[SimpleNamespace]:
    children: list[SimpleNamespace] = []
    for session in sessions:
        if session.session_id == parent_session_id:
            continue
        if str(session.parent_session_id or "").strip() != parent_session_id:
            continue
        if session.status not in _ACTIVE_CHILD_STATUSES:
            continue
        children.append(
            SimpleNamespace(
                role=session.role,
                title=session.title or session.session_id or "(subagent)",
                session_id=session.session_id,
                status=session.status,
                total_tokens_in=session.total_tokens_in,
                total_tokens_out=session.total_tokens_out,
                context_usage_pct=session.context_usage_pct,
                model=session.model,
                task_id=_extract_task_reference(session.title) or _extract_task_reference(session.session_id),
                last_activity_ts=session.last_activity_ts,
            )
        )

    children.sort(key=lambda value: float(getattr(value, "last_activity_ts", 0.0) or 0.0), reverse=True)
    return children


_CHILD_ACTIVE_STATUSES = {"running", "asking"}
_CHILD_RECENT_WINDOW_S = 300  # show subagents active within last 5 min


def _load_child_sessions_from_file(parent_session_file: Path) -> list[SimpleNamespace]:
    """Load child subagent sessions by scanning the parent session's subdirectory.

    OMP stores child session JSONL files in a directory whose name matches the
    parent session file stem, e.g.::

        sessions/scope/2026-03-03T16-30_14846f9.jsonl          ← parent
        sessions/scope/2026-03-03T16-30_14846f9/10-Task.jsonl  ← child
    """
    child_dir = parent_session_file.with_suffix("")
    if not child_dir.is_dir():
        return []

    cutoff = time.time() - _CHILD_RECENT_WINDOW_S
    children: list[SimpleNamespace] = []

    for child_file in sorted(child_dir.glob("*.jsonl")):
        try:
            mtime = child_file.stat().st_mtime
        except OSError:
            continue

        try:
            tail_lines = _read_jsonl_tail_lines(child_file)
        except OSError:
            continue
        if not tail_lines:
            continue

        status, _ = _detect_omp_status(tail_lines)

        # Skip sessions that finished long ago and aren't "active".
        is_active = status in _CHILD_ACTIVE_STATUSES
        is_recent = mtime >= cutoff
        if not (is_active or is_recent):
            continue

        # Title from file stem: '10-CreateMcpFilterExtension' → keep as-is for task linkage.
        stem = child_file.stem
        # OMP names child files as '{N}-{TaskName}' → map to 'task-{N}'.
        num_match = re.match(r"^(\d+)-", stem)
        task_ref = f"task-{num_match.group(1)}" if num_match else _extract_task_reference(stem)

        # Parse head lines for model/role and session id.
        try:
            head_lines = _read_jsonl_head_lines(child_file)
        except OSError:
            head_lines = []
        all_lines = head_lines + tail_lines

        child_session_id = ""
        if head_lines:
            try:
                first = json.loads(head_lines[0])
                child_session_id = str(first.get("id", "") or "")
            except (json.JSONDecodeError, IndexError):
                pass

        role = extract_last_mc_role(all_lines) or ""
        model = extract_last_mc_model(all_lines) or ""

        usage = parse_token_usage_from_jsonl(str(child_file))

        children.append(
            SimpleNamespace(
                role=role,
                title=stem,
                session_id=child_session_id or stem,
                status=status,
                total_tokens_in=_normalize_tokens(usage.get("total_tokens_in", 0)),
                total_tokens_out=_normalize_tokens(usage.get("total_tokens_out", 0)),
                context_usage_pct=None,
                model=model,
                task_id=task_ref,
                last_activity_ts=mtime,
            )
        )

    # Most-recently-active first.
    children.sort(key=lambda c: float(c.last_activity_ts or 0.0), reverse=True)
    return children

def render_window_snapshot(window_id: Optional[str], *, frame_index: int = 0) -> str:
    header = ["OMP SIDEBAR TELEMETRY", ""]
    if not window_id:
        return "\n".join(
            header
            + [
                "(tmux window unavailable)",
                "Open this sidebar from a tmux window with an active OMP session.",
            ]
        )

    client = TmuxClient()
    panes = client.list_panes_all()
    adapter = ActiveTmuxAdapter(client)
    active_sessions = [_as_sidebar_session(session) for session in adapter.list_active("/")]

    current = _choose_window_session(
        active_sessions,
        panes,
        window_id=window_id,
        sidebar_pane_id=os.environ.get("TMUX_PANE", "").strip(),
    )
    if current is None:
        return "\n".join(
            header
            + [
                f"window: {window_id}",
                "(no active OMP session in this window)",
                "Switch to an OMP pane to stream todo + subagent telemetry.",
            ]
        )

    todo_text = _extract_latest_todo_state(current.session_file) if current.session_file else ""
    todo_tasks = _parse_todo_text(todo_text) if todo_text else []
    child_rows = _load_child_sessions_from_file(current.session_file) if current.session_file else []

    session_title = current.title or current.session_id or "(untitled session)"
    lines = header + [
        f"window: {window_id}",
        "",
        "SESSION",
        f"title: {session_title}",
        f"status: {current.status}",
        "",
        "TASKS",
    ]
    lines.extend(render_live_sidebar_lines(todo_text, todo_tasks, child_rows, frame_index=frame_index))
    return "\n".join(lines)


def run_loop(window_id: Optional[str], interval_s: float, *, once: bool = False) -> int:
    safe_interval = max(0.5, float(interval_s))
    frame_index = 0
    while True:
        try:
            output = render_window_snapshot(window_id, frame_index=frame_index)
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            output = "\n".join(
                [
                    "OMP SIDEBAR TELEMETRY",
                    "",
                    "(telemetry renderer error)",
                    str(exc),
                    "Falling back to explorer mode is recommended.",
                ]
            )

        sys.stdout.write("\033[2J\033[H")
        sys.stdout.write(output.rstrip() + "\n")
        sys.stdout.flush()

        if once:
            return 0
        frame_index = (frame_index + 1) % len(_SPINNER_FRAMES)
        time.sleep(safe_interval)

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Render live OMP sidebar telemetry")
    parser.add_argument("--window-id", default="", help="tmux window id to inspect")
    parser.add_argument("--interval", type=float, default=1.0, help="refresh interval seconds")
    parser.add_argument("--once", action="store_true", help="render one frame and exit")
    parser.add_argument("--resolve-mode", action="store_true", help="resolve sidebar mode and exit")
    parser.add_argument("--env-mode", default="", help="mode from env override")
    parser.add_argument("--tmux-mode", default="", help="mode from tmux option")
    parser.add_argument("--pane-role", default="", help="sidebar pane role (1=explorer,2=telemetry)")
    args = parser.parse_args(argv)

    if args.resolve_mode:
        sys.stdout.write(resolve_sidebar_mode(args.env_mode, args.tmux_mode, args.pane_role) + "\n")
        return 0

    window_id = _resolve_window_id(args.window_id or None)
    return run_loop(window_id, args.interval, once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())

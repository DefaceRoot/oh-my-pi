from __future__ import annotations

import json
import logging
import os
import re
from collections import deque
from pathlib import Path
from typing import Callable, Optional

from agents_view.adapters.base import BaseAdapter, scope_matches
from agents_view.model import AgentSession
from agents_view.tmux_client import TmuxClient
from agents_view.utils import (
    extract_last_mc_model,
    extract_last_mc_role,
    get_git_branch_cached,
    get_git_repo_name_cached,
    parse_context_usage_from_jsonl_lines,
)

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
#  /proc helpers (Linux only)                                                  #
# --------------------------------------------------------------------------- #

def _read_cmdline(pid: str) -> str:
    """Read /proc/{pid}/cmdline, returning space-separated tokens or '' on error."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            data = fh.read()
        return data.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _children(pid: str) -> list[str]:
    """Return direct child PIDs from /proc/{pid}/task/{pid}/children."""
    try:
        with open(f"/proc/{pid}/task/{pid}/children", "r") as fh:
            content = fh.read().strip()
        return content.split() if content else []
    except OSError:
        return []


def _find_matching_pid(
    root_pid: str, matcher: Callable[[str], bool]
) -> Optional[str]:
    """BFS through process tree (depth ≤ 5); return first pid where matcher is True."""
    queue: deque[tuple[str, int]] = deque([(root_pid, 0)])
    visited: set[str] = set()
    while queue:
        pid, depth = queue.popleft()
        if pid in visited:
            continue
        visited.add(pid)
        if matcher(pid):
            return pid
        if depth < 5:
            for child in _children(pid):
                queue.append((child, depth + 1))
    return None


# --------------------------------------------------------------------------- #
#  Harness matchers                                                             #
# --------------------------------------------------------------------------- #

def _matches_omp(pid: str) -> bool:
    cmdline = _read_cmdline(pid)
    return (
        "/.bun/bin/omp" in cmdline
        or "/bin/omp" in cmdline
        or " oh-my-pi " in cmdline
        or " pi-coding-agent " in cmdline
    )


_CLAUDE_RE = re.compile(r"(^|[\s/])claude([\s]|$)")


def _matches_claude(pid: str) -> bool:
    cmdline = _read_cmdline(pid)
    return (
        "@anthropic-ai/claude-code" in cmdline
        or "/claude-code" in cmdline
        or bool(_CLAUDE_RE.search(cmdline))
    )


def _matches_codex(pid: str) -> bool:
    cmdline = _read_cmdline(pid)
    tokens = cmdline.split()
    binary = tokens[0] if tokens else ""
    return (
        "openai/codex" in cmdline
        or "codex-cli" in cmdline
        or binary.endswith("/codex")
    )


def _matches_opencode(pid: str) -> bool:
    return "opencode" in _read_cmdline(pid).lower()


# --------------------------------------------------------------------------- #
#  OMP status detection                                                        #
# --------------------------------------------------------------------------- #


_JSONL_TAIL_BYTES = 65_536


def _read_jsonl_tail_lines(file_path: Path, tail_bytes: int = _JSONL_TAIL_BYTES) -> list[str]:
    with open(file_path, "r", errors="replace") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        if size > tail_bytes:
            fh.seek(size - tail_bytes)
            fh.readline()
        else:
            fh.seek(0)
        return fh.readlines()

def _read_jsonl_head_lines(file_path: Path, line_limit: int = 120) -> list[str]:
    lines: list[str] = []
    with open(file_path, "r", errors="replace") as fh:
        for idx, line in enumerate(fh):
            if idx >= line_limit:
                break
            lines.append(line)
    return lines


def _detect_omp_status(lines: list[str] | Path) -> tuple[str, Optional[float]]:
    """Scan last 50 JSONL lines; return (status, ask_ts).

    status: "running" | "review" | "asking" | "idle"
    ask_ts: epoch float when ask tool was called, only set if status=="asking" and within 30 s.
    """
    import time as _time
    from datetime import datetime as _dt

    def _parse_ts(raw_ts: str) -> Optional[float]:
        try:
            return _dt.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None

    if isinstance(lines, Path):
        try:
            lines = _read_jsonl_tail_lines(lines)
        except OSError:
            return ("idle", None)
    tail = lines[-50:]
    status = "idle"
    last_ask_id: Optional[str] = None
    last_ask_ts: Optional[float] = None

    for raw in tail:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue

        ct = obj.get("customType", "")
        if ct in ("tool-start", "tool-call"):
            status = "running"
            last_ask_id = None
            last_ask_ts = None
            continue

        msg = obj.get("message")
        if isinstance(msg, dict):
            role = msg.get("role", "")
            content = msg.get("content", [])
        else:
            role = obj.get("role", "")
            content = []

        if role == "assistant":
            # OMP JSONL records assistant tool calls as {"type": "toolCall"};
            # the Anthropic API wire format uses {"type": "tool_use"}.
            # Accept both so detection works across OMP versions.
            tool_blocks = [
                b
                for b in (content if isinstance(content, list) else [])
                if isinstance(b, dict) and b.get("type") in ("tool_use", "toolCall")
            ]
            ask_block = next(
                (b for b in tool_blocks if b.get("name") == "ask"),
                None,
            )
            if ask_block:
                ts = _parse_ts(obj.get("timestamp", ""))
                last_ask_id = ask_block.get("id")
                last_ask_ts = ts or _time.time()
                status = "asking"
            elif tool_blocks:
                # Assistant invoked tools (including task/proxy_task delegation).
                # Awaiting tool results — session is actively running.
                last_ask_id = None
                last_ask_ts = None
                status = "running"
            else:
                # Pure text response — output ready for user review.
                last_ask_id = None
                last_ask_ts = None
                status = "review"
        elif role in ("user", "toolResult"):
            if isinstance(content, list) and last_ask_id:
                answered = any(
                    isinstance(b, dict)
                    and b.get("type") == "tool_result"
                    and b.get("tool_use_id") == last_ask_id
                    for b in content
                )
                if answered:
                    last_ask_id = None
                    last_ask_ts = None
                    status = "running"
                    continue
            status = "running"
            last_ask_id = None
            last_ask_ts = None

    if status == "asking" and last_ask_ts is not None:
        if _time.time() - last_ask_ts >= 30:
            return ("review", None)
        return ("asking", last_ask_ts)
    return (status, None)




# --------------------------------------------------------------------------- #
#  OMP session-file detection                                                  #
# --------------------------------------------------------------------------- #

_SESSION_FILE_RE = re.compile(r"/agent/sessions/[^/]+/\d{4}-[^/]+_[^/]+\.jsonl$")
_SESSION_ID_RE = re.compile(r"_([0-9a-f]+)\.jsonl$")


def _find_omp_session_file(omp_pid: str) -> Optional[Path]:
    """Scan /proc/{omp_pid}/fd for a symlink pointing at an OMP session JSONL."""
    fd_dir = Path(f"/proc/{omp_pid}/fd")
    candidates: list[Path] = []
    try:
        for fd_entry in fd_dir.iterdir():
            try:
                target = Path(os.readlink(fd_entry))
                if _SESSION_FILE_RE.search(str(target)) and target.exists():
                    candidates.append(target)
            except OSError:
                continue
    except OSError:
        return None
    if not candidates:
        return None
    try:
        return max(candidates, key=lambda p: p.stat().st_mtime)
    except OSError:
        return candidates[0]



def _parse_omp_session_file(file_path: Path, lines: list[str]) -> tuple[str, str, str, str]:
    """Return (session_id, title, role, model) from a JSONL session file.

    Title resolution order:
    1. ``title`` field on first line (session record).
    2. ``session-title`` customType event.
    3. Plan name extracted from ``implementation-engine/plan-new-metadata``.
    4. First user message text (first 60 chars).

    Role: last model_change event; null/undefined coalesces to "default" (mirrors
    """
    import re as _re
    session_id = ""
    title = ""
    plan_name = ""
    first_user_msg = ""
    role = ""
    model = ""

    m = _SESSION_ID_RE.search(file_path.name)
    if m:
        session_id = m.group(1)

    try:
        head = lines[:100]
        tail_list = lines[-50:]

        if head:
            try:
                first = json.loads(head[0])
                title = first.get("title", "")
            except json.JSONDecodeError:
                pass

            if not title:
                for line in head[1:]:
                    try:
                        obj = json.loads(line)
                        ct = obj.get("customType", "")
                        if ct == "session-title":
                            title = obj.get("data", {}).get("title", "")
                            if title:
                                break
                        if ct == "implementation-engine/plan-new-metadata" and not plan_name:
                            plan_path = obj.get("data", {}).get("planFilePath", "")
                            if plan_path:
                                stem = Path(plan_path).stem
                                # Strip leading date prefix (2026-02-24-)
                                stem = _re.sub(r'^\d{4}-\d{2}-\d{2}-', '', stem)
                                plan_name = _re.sub(r'[\-_.]', ' ', stem)
                                plan_name = _re.sub(r' +', ' ', plan_name).strip().title()
                        if not first_user_msg:
                            msg = obj.get("message")
                            if isinstance(msg, dict) and msg.get("role") == "user":
                                content = msg.get("content", "")
                                if isinstance(content, list) and content:
                                    text = content[0].get("text", "") if isinstance(content[0], dict) else ""
                                    # Skip OMP system-context injections: they are long
                                    # and contain ═ section dividers.
                                    if text and len(text) < 500 and "\u2550" not in text:
                                        first_user_msg = text[:60].split("\n")[0].strip()
                    except json.JSONDecodeError:
                        continue

            # Role: last model_change wins; check tail first (catches mid-session
            # mode switches that appear beyond line 100), then fall back to head.
            r = extract_last_mc_role(tail_list)
            if r is None:
                r = extract_last_mc_role(head)
            role = r if r is not None else ""
            model = extract_last_mc_model(tail_list)
            if not model:
                model = extract_last_mc_model(head)
        if not title:
            title = plan_name or first_user_msg

    except OSError:
        pass

    return session_id, title, role, model

# --------------------------------------------------------------------------- #
#  ActiveTmuxAdapter                                                           #
# --------------------------------------------------------------------------- #

_HARNESS_MATCHERS: list[tuple[str, Callable[[str], bool]]] = [
    ("omp", _matches_omp),
    ("claude", _matches_claude),
    ("codex", _matches_codex),
    ("opencode", _matches_opencode),
]


class ActiveTmuxAdapter(BaseAdapter):
    def __init__(self, client: TmuxClient) -> None:
        self._client = client

    def list_active(self, scope_root: str) -> list[AgentSession]:
        try:
            panes = self._client.list_panes_all()
        except Exception as e:
            log.error("list_active: failed to list panes: %s", e)
            return []

        sessions: list[AgentSession] = []
        seen_panes: set[str] = set()

        for pane in panes:
            pane_id = pane["pane"]
            cwd = pane["cwd"]

            if pane_id in seen_panes:
                continue

            if not scope_matches(cwd, scope_root):
                continue

            root_pid = pane["pid"]
            harness: Optional[str] = None
            matched_pid: Optional[str] = None

            for hname, matcher in _HARNESS_MATCHERS:
                pid = _find_matching_pid(root_pid, matcher)
                if pid is not None:
                    harness = hname
                    matched_pid = pid
                    break

            if harness is None:
                continue

            session_id = f"{harness}-pane-{pane_id}"
            title = ""
            role = ""
            model = ""
            ask_ts: Optional[float] = None
            last_ts: Optional[float] = None

            session_file: Optional[Path] = None
            session_tail_lines: list[str] = []
            if harness == "omp" and matched_pid:
                session_file = _find_omp_session_file(matched_pid)
                if session_file:
                    session_tail_lines = _read_jsonl_tail_lines(session_file)
                    session_head_lines = _read_jsonl_head_lines(session_file)
                    parsed_id, parsed_title, parsed_role, parsed_model = _parse_omp_session_file(
                        session_file, session_head_lines + session_tail_lines
                    )
                    if parsed_id:
                        session_id = parsed_id
                    title = parsed_title
                    role = parsed_role
                    model = parsed_model
                    try:
                        last_ts = session_file.stat().st_mtime
                    except OSError:
                        pass

            branch = get_git_branch_cached(cwd)
            if harness == "omp":
                context_usage_pct: Optional[float] = None
                if session_file:
                    status, ask_ts = _detect_omp_status(session_tail_lines)
                    context_usage_pct = parse_context_usage_from_jsonl_lines(
                        session_tail_lines, fallback_model=model
                    )
                else:
                    status = "idle"
                    ask_ts = None
            else:
                status = "running"
                context_usage_pct = None
            # For OMP sessions where we found a session file, set resume_command
            # so that _update_preview can locate the file without /proc scanning.
            resume_cmd: Optional[str] = None
            if harness == "omp" and session_file:
                resume_cmd = f"omp --session '{session_file}'"
            sessions.append(
                AgentSession(
                    harness=harness,
                    session_id=session_id,
                    title=title,
                    cwd=cwd,
                    state="active",
                    tmux_session=pane["session"],
                    tmux_window=pane["window"],
                    tmux_pane=pane_id,
                    last_activity_ts=last_ts,
                    scope_match=True,
                    branch=branch,
                    repo=get_git_repo_name_cached(cwd),
                    status=status,
                    ask_ts=ask_ts,
                    context_usage_pct=context_usage_pct,
                    role=role,
                    model=model,
                    resume_command=resume_cmd,
                )
            )
            seen_panes.add(pane_id)

        return sessions

    def list_inactive(self, scope_root: str, limit: int = 5) -> list[AgentSession]:
        return []

    def build_resume_command(self, session: AgentSession) -> None:
        return None

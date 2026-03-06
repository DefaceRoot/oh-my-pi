from __future__ import annotations

import json
import logging
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Optional

from agents_view.adapters.base import BaseAdapter, scope_matches
from agents_view.model import AgentSession
from agents_view.utils import get_git_branch

log = logging.getLogger(__name__)


def _parse_iso_timestamp(ts: str) -> Optional[float]:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return None


def _decode_claude_project_dir(dir_name: str) -> str:
    """Best-effort decode of Claude's project directory name to an absolute path.

    Claude Code encodes the project root path as a directory name where '/' is
    replaced with '-', with a leading '-' representing the root '/'.
    Example: '-home-colin-myproject'  →  '/home/colin/myproject'
    """
    # Try URL-decode first (handles percent-encoded chars).
    decoded = urllib.parse.unquote(dir_name)
    # If it looks like a dash-encoded absolute path (starts with '-'), convert.
    if decoded.startswith("-"):
        return decoded.replace("-", "/")
    return decoded


class ClaudeAdapter(BaseAdapter):
    def list_active(self, scope_root: str) -> list[AgentSession]:
        return []

    def list_inactive(self, scope_root: str, limit: int = 5) -> list[AgentSession]:
        projects_dir = Path("~/.claude/projects").expanduser()
        try:
            files = list(projects_dir.glob("**/*.jsonl"))
        except OSError as e:
            log.debug("ClaudeAdapter: cannot glob session files: %s", e)
            return []

        results: list[AgentSession] = []

        for file_path in files:
            try:
                with open(file_path, "r", errors="replace") as fh:
                    raw_lines = []
                    for i, line in enumerate(fh):
                        if i >= 100:
                            break
                        raw_lines.append(line)
            except OSError as e:
                log.debug("ClaudeAdapter: cannot read %s: %s", file_path, e)
                continue

            raw_lines = [l for l in raw_lines if l.strip()]
            if not raw_lines:
                continue

            try:
                first = json.loads(raw_lines[0])
            except json.JSONDecodeError:
                continue

            cwd = first.get("cwd", "")
            if not cwd:
                # Fall back to decoding the parent directory name.
                cwd = _decode_claude_project_dir(file_path.parent.name)

            branch = get_git_branch(cwd)
            if not scope_matches(cwd, scope_root):
                continue

            # ── title: check first line, then scan for session-title / first user msg ──
            title = first.get("title", "")
            first_user_msg = ""

            if not title:
                for raw in raw_lines:
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    t = obj.get("type", "")
                    ct = obj.get("customType", "")
                    if t == "session-title" or ct == "session-title":
                        data = obj.get("data", {})
                        if isinstance(data, dict):
                            title = data.get("title", "")
                        else:
                            title = obj.get("title", "")
                        if title:
                            break
                    if not first_user_msg:
                        msg = obj.get("message")
                        if isinstance(msg, dict) and msg.get("role") == "user":
                            content = msg.get("content", "")
                            if isinstance(content, list) and content:
                                text = content[0].get("text", "") if isinstance(content[0], dict) else ""
                                if text and len(text) < 500 and "\u2550" not in text:
                                    first_user_msg = text[:60].split("\n")[0].strip()
            if not title:
                title = first_user_msg

            last_ts: Optional[float] = None
            ts_raw = first.get("timestamp", "")
            if ts_raw:
                last_ts = _parse_iso_timestamp(ts_raw)
            if last_ts is None:
                try:
                    last_ts = file_path.stat().st_mtime
                except OSError:
                    pass

            session_id = file_path.stem
            resume_command = "claude"

            results.append(
                AgentSession(
                    harness="claude",
                    session_id=session_id,
                    title=title,
                    cwd=cwd,
                    state="inactive",
                    last_activity_ts=last_ts,
                    resume_command=resume_command,
                    scope_match=True,
                    branch=branch,
                    status="offline",
                )
            )

        def _sort_key(s: AgentSession) -> float:
            return s.last_activity_ts or 0.0

        results.sort(key=_sort_key, reverse=True)
        return results[:limit]

    def build_resume_command(self, session: AgentSession) -> Optional[str]:
        return session.resume_command

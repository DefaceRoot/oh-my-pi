from __future__ import annotations

import json
import logging
import re
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Optional

from agents_view.adapters.base import BaseAdapter, scope_matches
from agents_view.model import AgentSession
from agents_view.utils import (
    extract_last_mc_model,
    extract_last_mc_role,
    get_git_branch_cached,
    get_git_repo_name_cached,
    parse_context_usage_from_jsonl_lines,
)

log = logging.getLogger(__name__)

_SESSION_ID_RE = re.compile(r"_([0-9a-f]+)\.jsonl$")


_ARCHIVE_FILE = Path("~/.omp/agent/session_archive.json").expanduser()
_MAX_INACTIVE_AGE_SECONDS = 12 * 60 * 60


def _parse_iso_timestamp(ts: str) -> Optional[float]:
    """Convert an ISO-8601 timestamp string to a POSIX float. Returns None on error."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return None


def _write_to_archive(
    session_id: str,
    title: str,
    branch: str,
    harness: str,
    role: str,
    final_status: str,
    ended_ts: Optional[float],
    cwd: str,
) -> None:
    """Append session metadata to the archive file atomically."""
    try:
        if _ARCHIVE_FILE.exists():
            with open(_ARCHIVE_FILE, "r", encoding="utf-8") as f:
                archive = json.load(f)
        else:
            archive = []

        if not isinstance(archive, list):
            archive = []

        existing_ids = {entry.get("session_id") for entry in archive}
        if session_id not in existing_ids:
            archive.append(
                {
                    "session_id": session_id,
                    "title": title,
                    "branch": branch,
                    "harness": harness,
                    "role": role,
                    "cost": None,
                    "final_status": final_status,
                    "ended_ts": ended_ts,
                    "cwd": cwd,
                }
            )
            _ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = _ARCHIVE_FILE.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(archive, f, indent=2)
            tmp.replace(_ARCHIVE_FILE)
    except Exception as e:
        log.debug("archive write failed: %s", e)


class OmpAdapter(BaseAdapter):
    def list_active(self, scope_root: str) -> list[AgentSession]:
        return []

    def list_inactive(self, scope_root: str, limit: int = 5) -> list[AgentSession]:
        sessions_dir = Path("~/.omp/agent/sessions").expanduser()
        try:
            # Sort by mtime descending so we read the most-recently-used files first.
            files = sorted(
                sessions_dir.glob("**/*.jsonl"),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )
        except OSError as e:
            log.debug("OmpAdapter: cannot glob session files: %s", e)
            return []

        results: list[AgentSession] = []
        files_examined = 0
        MAX_FILES = 500  # cap to bound startup cost

        for file_path in files:
            if files_examined >= MAX_FILES:
                break
            files_examined += 1
            try:
                with open(file_path, "r", errors="replace") as fh:
                    raw_lines: list[str] = []
                    tail: deque[str] = deque(maxlen=50)
                    for i, line in enumerate(fh):
                        if i < 100:
                            raw_lines.append(line)
                        tail.append(line)
                tail_list = list(tail)
            except OSError as e:
                log.debug("OmpAdapter: cannot read %s: %s", file_path, e)
                continue

            raw_lines = [line for line in raw_lines if line.strip()]
            if not raw_lines:
                continue

            try:
                first = json.loads(raw_lines[0])
            except json.JSONDecodeError:
                continue

            cwd = first.get("cwd", "")
            if not scope_matches(cwd, scope_root):
                continue

            # ── title: multi-priority extraction ─────────────────────────────────
            title = first.get("title", "")
            plan_name = ""
            first_user_msg = ""

            if not title:
                for raw in raw_lines[1:]:
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    ct = obj.get("customType", "")
                    if ct == "session-title":
                        title = obj.get("data", {}).get("title", "")
                        if title:
                            break
                    if ct == "plan-worktree/plan-new-metadata" and not plan_name:
                        plan_path = obj.get("data", {}).get("planFilePath", "")
                        if plan_path:
                            stem = Path(plan_path).stem
                            stem = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", stem)
                            plan_name = re.sub(r"[\-_.]+", " ", stem).strip().title()
                    if not first_user_msg:
                        msg = obj.get("message")
                        if isinstance(msg, dict) and msg.get("role") == "user":
                            content = msg.get("content", "")
                            if isinstance(content, list) and content:
                                text = content[0].get("text", "") if isinstance(content[0], dict) else ""
                                if text and len(text) < 500 and "\u2550" not in text:
                                    first_user_msg = text[:60].split("\n")[0].strip()
                if not title:
                    title = plan_name or first_user_msg

            # ── parent session ID (for subagent-aware stall detection) ──
            parent_sid: Optional[str] = None
            if len(raw_lines) > 0:
                try:
                    first_obj = json.loads(raw_lines[0])
                    raw_parent = first_obj.get("parentSessionId", "") or ""
                    if raw_parent:
                        # Extract hex ID from full session path or use raw value
                        match = _SESSION_ID_RE.search(str(raw_parent))
                        parent_sid = match.group(1) if match else raw_parent[:32]
                except (json.JSONDecodeError, AttributeError):
                    pass

            # ── branch ────────────────────────────────────────────────
            branch = ""
            for raw in raw_lines[1:]:
                try:
                    obj = json.loads(raw)
                    if obj.get("customType") == "plan-worktree/state":
                        data = obj.get("data")
                        if isinstance(data, dict):
                            branch = data.get("branchName", "") or ""
                        if branch:
                            break
                except json.JSONDecodeError:
                    continue
            if not branch:
                branch = get_git_branch_cached(cwd)

            # ── role ────────────────────────────────────────────────────────
            # Tail-first: catches mode switches that happen beyond line 100.
            r = extract_last_mc_role(tail_list)
            if r is None:
                r = extract_last_mc_role(raw_lines)
            role = r if r is not None else ""
            model = extract_last_mc_model(tail_list)
            if not model:
                model = extract_last_mc_model(raw_lines)

            # ── context usage ───────────────────────────────────────────────────
            context_usage_pct = parse_context_usage_from_jsonl_lines(
                tail_list, fallback_model=model
            )
            # ── timestamps: prefer file mtime (last write) over creation ts ──
            try:
                last_ts: Optional[float] = file_path.stat().st_mtime
            except OSError:
                last_ts = _parse_iso_timestamp(first.get("timestamp", ""))

            m = _SESSION_ID_RE.search(file_path.name)
            session_id = m.group(1) if m else file_path.stem
            resume_command = f"omp --session '{file_path}'"

            results.append(
                AgentSession(
                    harness="omp",
                    session_id=session_id,
                    title=title,
                    cwd=cwd,
                    state="inactive",
                    last_activity_ts=last_ts,
                    resume_command=resume_command,
                    scope_match=True,
                    branch=branch,
                    repo=get_git_repo_name_cached(cwd),
                    status="offline",
                    context_usage_pct=context_usage_pct,
                    parent_session_id=parent_sid,
                    role=role,
                    model=model,
                )
            )

        # Apply limit to TITLED sessions only so worker/subagent sessions (which
        # have no title) never consume slots in the visible window.
        titled = [s for s in results if s.title]
        untitled = [s for s in results if not s.title]
        import time as _time

        now = _time.time()
        for s in results:
            ts = s.last_activity_ts
            if ts is not None and (now - ts) > _MAX_INACTIVE_AGE_SECONDS and s.title:
                _write_to_archive(
                    session_id=s.session_id,
                    title=s.title,
                    branch=s.branch,
                    harness=s.harness,
                    role=s.role,
                    final_status=s.status,
                    ended_ts=ts,
                    cwd=s.cwd,
                )

        return (titled + untitled)[:limit]

    def build_resume_command(self, session: AgentSession) -> Optional[str]:
        return session.resume_command

#!/usr/bin/env bash
set -euo pipefail

session_file="${1:-}"

if [[ -z "$session_file" || ! -f "$session_file" || ! -r "$session_file" ]]; then
	echo "[Unable to preview session]"
	exit 0
fi

python3 - "$session_file" <<'PY'
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_iso(ts: str) -> tuple[str, int]:
    if not ts:
        return ("unknown", 0)
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return (ts, 0)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local_dt = dt.astimezone()
    return (local_dt.strftime("%Y-%m-%d %H:%M"), int(dt.timestamp()))


def relative_time(epoch: int) -> str:
    if epoch <= 0:
        return "unknown"
    diff = int(datetime.now(tz=timezone.utc).timestamp()) - epoch
    if diff < 0:
        diff = 0
    if diff < 60:
        return f"{diff}s ago"
    if diff < 3600:
        return f"{diff // 60}m ago"
    if diff < 86400:
        return f"{diff // 3600}h ago"
    return f"{diff // 86400}d ago"


def content_to_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = content_to_text(item)
            if text:
                parts.append(text)
        return "\n".join(parts)
    if isinstance(value, dict):
        # Prefer explicit text payloads.
        text = value.get("text")
        if isinstance(text, str):
            return text

        item_type = value.get("type")
        if item_type == "text" and isinstance(value.get("text"), str):
            return value["text"]

        for key in ("content", "message"):
            nested = value.get(key)
            nested_text = content_to_text(nested)
            if nested_text:
                return nested_text
    return ""


def get_role(entry: dict) -> str | None:
    role = entry.get("role")
    if isinstance(role, str):
        return role

    entry_type = entry.get("type")
    if entry_type in {"user", "assistant"}:
        return str(entry_type)

    msg = entry.get("message")
    if isinstance(msg, dict):
        msg_role = msg.get("role")
        if isinstance(msg_role, str):
            return msg_role
        msg_type = msg.get("type")
        if msg_type in {"user", "assistant"}:
            return str(msg_type)

    return None


def get_message_text(entry: dict) -> str:
    text = content_to_text(entry.get("content"))
    if text:
        return text.strip()

    msg = entry.get("message")
    if isinstance(msg, dict):
        text = content_to_text(msg.get("content"))
        if text:
            return text.strip()

    return ""


def truncate_lines(text: str, limit: int) -> tuple[list[str], bool]:
    lines = text.splitlines() if text else []
    if not lines:
        return ([""], False)
    if len(lines) <= limit:
        return (lines, False)
    return (lines[:limit], True)


try:
    session_path = Path(sys.argv[1])
    raw_lines = session_path.read_text(encoding="utf-8", errors="replace").splitlines()
except Exception:
    print("[Unable to preview session]")
    raise SystemExit(0)

if not raw_lines:
    print("[Unable to preview session]")
    raise SystemExit(0)

cwd = "(unknown)"
repo = "(unknown)"
started_iso = ""
branch = "-"
last_user = ""
last_assistant = ""
session_title = ""

try:
    first_entry = json.loads(raw_lines[0])
except Exception:
    print("[Unable to preview session]")
    raise SystemExit(0)

if not isinstance(first_entry, dict):
    print("[Unable to preview session]")
    raise SystemExit(0)

for index, line in enumerate(raw_lines):
    if not line.strip():
        continue
    try:
        entry = json.loads(line)
    except Exception:
        if index == 0:
            print("[Unable to preview session]")
            raise SystemExit(0)
        continue
    if not isinstance(entry, dict):
        if index == 0:
            print("[Unable to preview session]")
            raise SystemExit(0)
        continue

    if index == 0:
        entry_cwd = entry.get("cwd")
        entry_ts = entry.get("timestamp")
        if isinstance(entry_cwd, str) and entry_cwd:
            cwd = entry_cwd
        if isinstance(entry_ts, str) and entry_ts:
            started_iso = entry_ts

    if entry.get("customType") == "implementation-engine/state":
        data = entry.get("data")
        if isinstance(data, dict):
            candidate_branch = data.get("branchName")
            if isinstance(candidate_branch, str) and candidate_branch.strip():
                branch = candidate_branch.strip()

    if entry.get("customType") == "session-title" and not session_title:
        data = entry.get("data")
        if isinstance(data, dict):
            candidate_title = data.get("title")
            if isinstance(candidate_title, str) and candidate_title.strip():
                session_title = candidate_title.strip()
    role = get_role(entry)
    if role == "user":
        text = get_message_text(entry)
        if text:
            last_user = text
    elif role == "assistant":
        text = get_message_text(entry)
        if text:
            last_assistant = text

repo = cwd.split("/.worktrees/")[0] if "/.worktrees/" in cwd else cwd
started_fmt, started_epoch = parse_iso(started_iso)
started_rel = relative_time(started_epoch)

print("=== SESSION INFO ===")
print(f"Repo:      {repo}")
print(f"Branch:    {branch}")
print(f"Started:   {started_fmt} ({started_rel})")
if session_title:
    print(f"Title:     {session_title}")
print(f"Messages:  {len(raw_lines)} total")
print()
print("=== LAST EXCHANGE ===")

user_text = last_user or "[No user message found]"
user_lines, user_truncated = truncate_lines(user_text, 3)
for i, line in enumerate(user_lines):
    prefix = "> " if i == 0 else "  "
    print(f"{prefix}{line}")
if user_truncated:
    print("  ...")

print()
assistant_text = last_assistant or "[No assistant message found]"
assistant_lines, assistant_truncated = truncate_lines(assistant_text, 8)
for line in assistant_lines:
    print(line)
if assistant_truncated:
    print("...")
PY

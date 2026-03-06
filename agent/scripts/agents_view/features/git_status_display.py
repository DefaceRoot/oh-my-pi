"""git_status_display.py - Enhanced git status display for agent sessions.

Adds ahead/behind counts, uncommitted change indicators,
and last commit info to the session display.
"""

from __future__ import annotations

import subprocess
import time
from typing import Any

from rich.text import Text

_git_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_TTL = 15.0  # seconds
_TIMEOUT_SECONDS = 3.0
_MAX_COMMIT_MESSAGE_LEN = 50


def _run_git(cwd: str, args: list[str]) -> subprocess.CompletedProcess[str] | None:
    """Run a git command for cwd with consistent options."""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception:
        return None


def get_git_status(cwd: str) -> dict[str, Any]:
    """Get git status for a working directory (cached)."""
    if not cwd:
        return {}

    cached_ts, cached_data = _git_cache.get(cwd, (0.0, {}))
    if time.time() - cached_ts < _CACHE_TTL:
        return cached_data

    result: dict[str, Any] = {
        "is_repo": False,
        "ahead": 0,
        "behind": 0,
        "changed": 0,
        "has_stash": False,
        "last_commit_hash": "",
        "last_commit_msg": "",
    }

    status_result = _run_git(cwd, ["status", "--porcelain"])
    if status_result is not None and status_result.returncode == 0:
        result["is_repo"] = True
        lines = [line for line in status_result.stdout.splitlines() if line.strip()]
        result["changed"] = len(lines)

    ahead_behind_result = _run_git(
        cwd,
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    if ahead_behind_result is not None and ahead_behind_result.returncode == 0:
        parts = ahead_behind_result.stdout.strip().split()
        if len(parts) == 2:
            try:
                result["ahead"] = int(parts[0])
                result["behind"] = int(parts[1])
            except ValueError:
                pass

    commit_result = _run_git(cwd, ["log", "-1", "--format=%h|%s"])
    if commit_result is not None and commit_result.returncode == 0:
        result["is_repo"] = True
        parts = commit_result.stdout.strip().split("|", 1)
        if len(parts) == 2:
            result["last_commit_hash"] = parts[0].strip()
            result["last_commit_msg"] = parts[1].strip()[:_MAX_COMMIT_MESSAGE_LEN]

    stash_result = _run_git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"])
    if stash_result is not None and stash_result.returncode == 0:
        result["is_repo"] = True
        result["has_stash"] = True

    _git_cache[cwd] = (time.time(), result)
    return result


def format_ahead_behind(ahead: int, behind: int) -> str:
    """Format ahead/behind as compact string."""
    parts: list[str] = []
    if ahead:
        parts.append(f"↑{ahead}")
    if behind:
        parts.append(f"↓{behind}")
    return " ".join(parts) if parts else "✔"


def format_branch_with_status(branch: str, git_data: dict[str, Any]) -> str:
    """Format branch name with uncommitted-change indicator."""
    branch_name = (branch or "").strip()
    if not branch_name:
        return ""
    changed = int(git_data.get("changed", 0) or 0)
    return f"{branch_name}*" if changed else branch_name


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    if getattr(AgentsViewApp, "_git_status_display_feature_patched", False):
        return

    original_branch_cell = getattr(AgentsViewApp, "_branch_cell", None)
    original_preview_status_line = getattr(AgentsViewApp, "_preview_status_line", None)
    if not callable(original_branch_cell) or not callable(original_preview_status_line):
        return

    def _branch_cell_with_git_status(self: Any, session: Any) -> Text:
        cwd = str(getattr(session, "cwd", "") or "")
        git_data = get_git_status(cwd) if cwd else {}

        if not git_data.get("is_repo"):
            return original_branch_cell(self, session)

        branch_text = format_branch_with_status(str(getattr(session, "branch", "") or ""), git_data)
        if len(branch_text) > 26:
            branch_text = branch_text[:25] + "…"

        rendered = Text(branch_text or "—", style="italic #daaa3f" if branch_text else "#444c56")

        diff_shortstat = str(getattr(session, "diff_shortstat", "") or "").strip()
        if diff_shortstat:
            rendered.append(f" {diff_shortstat}", style="#636e7b")

        ahead = int(git_data.get("ahead", 0) or 0)
        behind = int(git_data.get("behind", 0) or 0)
        ahead_behind_text = format_ahead_behind(ahead, behind)
        if ahead and behind:
            ahead_behind_style = "bold #f0883e"
        elif behind:
            ahead_behind_style = "#d4a72c"
        else:
            ahead_behind_style = "#3fb950"
        rendered.append(f" {ahead_behind_text}", style=ahead_behind_style)

        changed = int(git_data.get("changed", 0) or 0)
        changed_style = "#d4a72c" if changed else "#3fb950"
        rendered.append(f" ±{changed}", style=changed_style)

        if git_data.get("has_stash"):
            rendered.append(" S", style="bold #b083f0")

        cached_paths: set[str] = set(getattr(self, "_cached_worktree_paths", set()) or set())
        if cwd and cwd.rstrip("/") in cached_paths:
            rendered.append(" [W]", style="dim #636e7b")

        return rendered

    def _preview_status_line_with_commit(self: Any, session: Any) -> Text:
        line = original_preview_status_line(self, session)

        cwd = str(getattr(session, "cwd", "") or "")
        if not cwd:
            return line

        git_data = get_git_status(cwd)
        if not git_data.get("is_repo"):
            return line

        commit_hash = str(git_data.get("last_commit_hash", "") or "").strip()
        if not commit_hash:
            return line

        commit_msg = str(git_data.get("last_commit_msg", "") or "").strip()
        if len(commit_msg) > _MAX_COMMIT_MESSAGE_LEN:
            commit_msg = commit_msg[:_MAX_COMMIT_MESSAGE_LEN]

        if line.plain:
            line.append("   ", style="#444c56")
        line.append("Commit:", style="bold #636e7b")
        line.append(" ", style="#636e7b")
        line.append(f"⎇ {commit_hash}", style="dim #8b949e")
        if commit_msg:
            line.append(f" - {commit_msg}", style="#adbac7")
        return line

    AgentsViewApp._get_git_status = staticmethod(get_git_status)  # type: ignore[attr-defined]
    AgentsViewApp._format_ahead_behind = staticmethod(format_ahead_behind)  # type: ignore[attr-defined]
    AgentsViewApp._format_branch_with_status = staticmethod(format_branch_with_status)  # type: ignore[attr-defined]
    AgentsViewApp._branch_cell = _branch_cell_with_git_status  # type: ignore[assignment,method-assign]
    AgentsViewApp._preview_status_line = _preview_status_line_with_commit  # type: ignore[assignment,method-assign]
    AgentsViewApp._git_status_display_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

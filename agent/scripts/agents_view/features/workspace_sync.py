"""workspace_sync.py - Workspace sync status for git worktrees.

Detects merge conflicts, rebase state, ahead/behind vs main,
and protected-branch warnings.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

_PROTECTED_BRANCHES: frozenset[str] = frozenset(
    {"main", "master", "develop", "staging", "production", "prod"}
)
_sync_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_TTL = 30.0


def get_workspace_status(cwd: str) -> dict[str, Any]:
    """Return git workspace status for cwd (cached 30 s)."""
    if not cwd:
        return {}

    cached_ts, cached_data = _sync_cache.get(cwd, (0.0, {}))
    if time.time() - cached_ts < _CACHE_TTL:
        return cached_data

    result: dict[str, Any] = {}

    def _run(*args: str) -> str:
        try:
            out = subprocess.run(
                list(args),
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            return out.stdout.strip() if out.returncode == 0 else ""
        except Exception:
            return ""

    branch = _run("git", "rev-parse", "--abbrev-ref", "HEAD")
    if branch:
        result["branch"] = branch
        result["is_protected"] = branch in _PROTECTED_BRANCHES

    for base in ("main", "master", "origin/main", "origin/master"):
        raw = _run("git", "rev-list", "--left-right", "--count", f"HEAD...{base}")
        parts = raw.split()
        if len(parts) == 2:
            try:
                result["ahead_main"] = int(parts[0])
                result["behind_main"] = int(parts[1])
                result["base_branch"] = base
            except ValueError:
                pass
            else:
                break

    git_dir_raw = _run("git", "rev-parse", "--git-dir")
    if git_dir_raw:
        git_dir_path = Path(git_dir_raw)
        git_dir = git_dir_path if git_dir_path.is_absolute() else Path(cwd) / git_dir_path
        result["has_merge_conflict"] = (git_dir / "MERGE_HEAD").exists()
        result["has_rebase"] = (git_dir / "rebase-merge").exists() or (
            git_dir / "rebase-apply"
        ).exists()

    _sync_cache[cwd] = (time.time(), result)
    return result


def render_workspace_status(cwd: str, branch: str = "") -> str:
    """Human-readable workspace status block."""
    data = get_workspace_status(cwd)
    if not data:
        return "  No git workspace"

    lines: list[str] = []
    actual_branch = str(data.get("branch", branch) or "")
    prefix = "🔒 Protected" if data.get("is_protected") else "Branch"
    lines.append(f"  {prefix}: {actual_branch}")

    ahead = int(data.get("ahead_main", 0) or 0)
    behind = int(data.get("behind_main", 0) or 0)
    base = str(data.get("base_branch", "main") or "main")
    if ahead or behind:
        lines.append(f"  vs {base}: ↑{ahead} ↓{behind}")

    if data.get("has_merge_conflict"):
        lines.append("  ⚠ MERGE CONFLICT in progress")
    if data.get("has_rebase"):
        lines.append("  ⚠ REBASE in progress")

    return "\n".join(lines)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp

        AgentsViewApp._get_workspace_status = staticmethod(get_workspace_status)  # type: ignore[attr-defined]
        AgentsViewApp._render_workspace_status = staticmethod(  # type: ignore[attr-defined]
            render_workspace_status
        )
    except Exception:
        pass


_patch_app()

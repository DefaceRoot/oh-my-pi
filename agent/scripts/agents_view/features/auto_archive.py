"""auto_archive.py - Auto-archive old completed sessions.
Provides configurable rules for archiving done/inactive sessions.
Binding: ctrl+shift+a to trigger a manual archive sweep.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

_ARCHIVE_FILE = Path.home() / ".omp" / "agents-view-archive.json"
_archive_data: dict[str, dict] = {}
_LAST_AUTO_ARCHIVE = 0.0
_AUTO_ARCHIVE_INTERVAL = 3600.0  # seconds between automatic checks


def load_archive() -> None:
    global _archive_data
    try:
        if _ARCHIVE_FILE.exists():
            _archive_data = json.loads(_ARCHIVE_FILE.read_text())
    except Exception:
        _archive_data = {}


def save_archive() -> None:
    try:
        _ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _ARCHIVE_FILE.write_text(json.dumps(_archive_data, indent=2))
    except Exception:
        pass


def auto_archive_sessions(
    sessions: list,
    done_days: int = 7,
    inactive_days: int = 30,
) -> list[str]:
    """Archive sessions meeting age criteria. Returns list of archived IDs."""
    global _LAST_AUTO_ARCHIVE
    now = time.time()
    archived: list[str] = []

    for s in sessions:
        sid: str = s.session_id
        if sid in _archive_data:
            continue
        status = getattr(s, "status", "unknown")
        state = getattr(s, "state", "active")
        # Never archive actively-running sessions
        if state == "active" and status not in ("done", "idle"):
            continue
        ts = getattr(s, "session_start_ts", None) or getattr(s, "last_activity_ts", None)
        if not ts:
            continue
        age_days = (now - ts) / 86400
        if (status == "done" and age_days > done_days) or (
            state == "inactive" and age_days > inactive_days
        ):
            _archive_data[sid] = {
                "session_id": sid,
                "title": getattr(s, "title", ""),
                "archived_at": now,
                "reason": f"Auto: {status} for {age_days:.0f} days",
            }
            archived.append(sid)

    if archived:
        save_archive()
    _LAST_AUTO_ARCHIVE = now
    return archived


def should_run_auto_archive() -> bool:
    return time.time() - _LAST_AUTO_ARCHIVE > _AUTO_ARCHIVE_INTERVAL


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen
        from textual.binding import Binding

        load_archive()
        AgentsViewApp._auto_archive_sessions = staticmethod(auto_archive_sessions)
        AgentsViewApp._should_run_auto_archive = staticmethod(should_run_auto_archive)
        AgentsViewApp._archive_store = _archive_data

        def _action_archive_sweep(self: object) -> None:
            sessions = getattr(self, "_sessions", [])
            archived = auto_archive_sessions(sessions)
            if archived:
                self.notify(f"Archived {len(archived)} session(s)")  # type: ignore[attr-defined]
            else:
                self.notify("No sessions to archive")  # type: ignore[attr-defined]

        AgentsViewApp.action_archive_sweep = _action_archive_sweep  # type: ignore[attr-defined]

        existing_keys = {b.key for b in AgentsViewApp.BINDINGS}
        if "ctrl+shift+a" not in existing_keys:
            AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
                Binding("ctrl+shift+a", "archive_sweep", "Archive sweep"),
            ]

        entry = ("Session", "ctrl+shift+a", "Archive old sessions")
        if entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(entry)
    except Exception:
        pass


_patch_app()

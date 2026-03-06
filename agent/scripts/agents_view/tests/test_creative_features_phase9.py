"""Focused tests for phase 9 creative Agents View features."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, cast

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import agents_view.app as app_module
from agents_view.app import AgentsViewApp
from agents_view.model import (
    ASKING_COUNTDOWN_SECONDS,
    STALL_THRESHOLD_SECONDS,
    AgentSession,
)


def _session(**overrides: Any) -> AgentSession:
    payload: dict[str, Any] = {
        "harness": "omp",
        "session_id": "session-1",
        "title": "Session One",
        "cwd": "/tmp/project",
        "state": "active",
    }
    payload.update(overrides)
    return AgentSession(**cast(dict[str, Any], payload))


def test_status_rich_maps_waiting_to_review_display() -> None:
    s = _session(
        status="waiting", last_activity_ts=time.time() - STALL_THRESHOLD_SECONDS - 5
    )

    label, style = s.status_rich

    assert label == "◍ REVIEW"
    assert style == "bold #79c0ff"


def test_status_rich_marks_asking_as_stuck_after_threshold() -> None:
    s = _session(status="asking", ask_ts=time.time() - STALL_THRESHOLD_SECONDS - 5)

    label, style = s.status_rich

    assert label == "! INPUT"
    assert style == "bold #f85149"


def test_status_rich_stuck_alert_applies_only_to_waiting_and_asking() -> None:
    s = _session(
        status="running",
        ask_ts=time.time() - STALL_THRESHOLD_SECONDS - 5,
        last_activity_ts=time.time() - STALL_THRESHOLD_SECONDS - 5,
    )

    label, style = s.status_rich

    assert label == "⚡ RUN "
    assert style == "bold #57c4f8"


def test_status_rich_keeps_asking_countdown_before_stuck_threshold() -> None:
    s = _session(status="asking", ask_ts=time.time() - 3)

    label, style = s.status_rich

    assert label.startswith("INPUT ")
    assert label.endswith("s")
    assert style == "bold #e8b84b"
    remaining = int(label.split()[1].removesuffix("s"))
    assert 0 <= remaining <= ASKING_COUNTDOWN_SECONDS


def test_display_title_appends_quick_note_suffix() -> None:
    s = _session(quick_note=" follow-up ")

    assert s.display_title == "Session One [follow-up]"


def test_quick_notes_load_handles_missing_and_corrupt_files(
    monkeypatch, tmp_path
) -> None:
    notes_path = tmp_path / "notes.json"
    monkeypatch.setenv("OMP_AGENTS_VIEW_NOTES_FILE", str(notes_path))

    app_missing = AgentsViewApp(scope_root="/")
    assert app_missing._quick_notes == {}

    notes_path.write_text("{not-json", encoding="utf-8")
    app_corrupt = AgentsViewApp(scope_root="/")
    assert app_corrupt._quick_notes == {}


def test_quick_notes_persist_and_apply_to_sessions(monkeypatch, tmp_path) -> None:
    notes_path = tmp_path / "notes.json"
    monkeypatch.setenv("OMP_AGENTS_VIEW_NOTES_FILE", str(notes_path))

    app = AgentsViewApp(scope_root="/")
    session = _session(session_id="persist-me", title="Persist Me")

    app._set_quick_note(session, "ship-check")
    app._save_quick_notes()

    reloaded = AgentsViewApp(scope_root="/")
    shadow = _session(session_id="persist-me", title="Persist Me")
    reloaded._apply_quick_notes([shadow])

    assert shadow.quick_note == "ship-check"
    assert shadow.display_title == "Persist Me [ship-check]"


def test_session_tags_string_and_lookup_are_case_insensitive() -> None:
    s = _session(tags=["important", "needs-review"])

    assert s.tags_str == "important, needs-review"
    assert s.has_tag("IMPORTANT")
    assert not s.has_tag("wip")


def test_session_tags_persist_via_json_helpers(monkeypatch, tmp_path) -> None:
    tags_path = tmp_path / "session_tags.json"
    monkeypatch.setattr(app_module, "_TAGS_FILE", tags_path)

    app_module._save_session_tags(
        {
            "session-1": ["blocking", "needs-review"],
            "session-2": ["WIP", "WIP", ""],
        }
    )

    loaded = app_module._load_session_tags()

    assert loaded["session-1"] == ["blocking", "needs-review"]
    assert loaded["session-2"] == ["wip"]


def test_matches_filter_supports_case_insensitive_tag_queries() -> None:
    app = AgentsViewApp(scope_root="/")
    tagged = _session(tags=["blocking", "important"])
    untagged = _session(session_id="session-2", tags=[])

    assert app._matches_filter(tagged, "#blocking")
    assert app._matches_filter(tagged, "#BLOCKING")
    assert not app._matches_filter(untagged, "#blocking")


def test_add_session_tag_enforces_count_and_length_limits(
    monkeypatch, tmp_path
) -> None:
    tags_path = tmp_path / "session_tags.json"
    monkeypatch.setattr(app_module, "_TAGS_FILE", tags_path)
    app = AgentsViewApp(scope_root="/")
    s = _session(session_id="tag-limits")

    assert app._add_session_tag(s, "#important")
    assert app._add_session_tag(s, "#blocking")
    assert app._add_session_tag(s, "#wip")
    assert app._add_session_tag(s, "#needs-review")
    assert app._add_session_tag(s, "#done")
    assert not app._add_session_tag(s, "#paused")

    assert len(s.tags) == 5
    assert all(len(tag) <= 20 for tag in s.tags)
    assert s.tags[0] == "important"

"""Tests for OmpAdapter.list_inactive() parsing and scope filtering."""
from __future__ import annotations

import inspect
import json
import sys
import time
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest

import agents_view.adapters.omp_adapter as omp_mod
from agents_view.adapters.omp_adapter import OmpAdapter, _parse_iso_timestamp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_session_file(
    directory: Path,
    *,
    cwd: str,
    title: str = "",
    timestamp: str = "2025-01-01T12:00:00Z",
    extra_lines: list[str] | None = None,
    stem: str = "2025-01-01T12:00:00_abc123",
) -> Path:
    """Create a minimal OMP JSONL session file in *directory*."""
    directory.mkdir(parents=True, exist_ok=True)
    file_path = directory / f"{stem}.jsonl"
    first = {"cwd": cwd, "timestamp": timestamp}
    if title:
        first["title"] = title
    lines = [json.dumps(first)]
    if extra_lines:
        lines.extend(extra_lines)
    file_path.write_text("\n".join(lines) + "\n")
    return file_path


def _sessions_dir_patcher(tmp_sessions: Path, monkeypatch):
    """Patch omp_mod.Path so ~/.omp/agent/sessions points to *tmp_sessions*."""
    real_path = Path  # pathlib.Path

    def fake_path(s):
        if isinstance(s, str) and ".omp/agent/sessions" in s:
            # Return a real (absolute) Path; .expanduser() is a no-op on absolute paths.
            return real_path(tmp_sessions)
        return real_path(s)

    monkeypatch.setattr(omp_mod, "Path", fake_path)


# ---------------------------------------------------------------------------
# _parse_iso_timestamp unit tests
# ---------------------------------------------------------------------------


class TestParseIsoTimestamp:
    def test_utc_z_suffix(self):
        ts = _parse_iso_timestamp("2025-01-01T12:00:00Z")
        assert ts is not None
        assert isinstance(ts, float)
        # 2025-01-01 12:00:00 UTC → known epoch
        assert abs(ts - 1735732800.0) < 2

    def test_offset_plus_00(self):
        ts = _parse_iso_timestamp("2025-06-15T08:30:00+00:00")
        assert ts is not None

    def test_malformed_string_returns_none(self):
        assert _parse_iso_timestamp("not-a-date") is None

    def test_empty_string_returns_none(self):
        assert _parse_iso_timestamp("") is None


# ---------------------------------------------------------------------------
# OmpAdapter.list_inactive() tests
# ---------------------------------------------------------------------------


class TestOmpAdapterListInactive:
    def test_default_limit_is_five(self):
        default_limit = inspect.signature(OmpAdapter.list_inactive).parameters["limit"].default
        assert default_limit == 5


    def test_in_scope_session_returned(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(sessions_dir / "proj", cwd="/home/colin/project")
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1
        assert results[0].cwd == "/home/colin/project"
        assert results[0].harness == "omp"
        assert results[0].state == "inactive"

    def test_out_of_scope_session_excluded(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(sessions_dir / "other", cwd="/home/colin/other-project")
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results == []

    def test_descendant_cwd_included(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(
            sessions_dir / "nested",
            cwd="/home/colin/project/src/utils",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1

    def test_prefix_collision_excluded(self, tmp_path, monkeypatch):
        # /home/colin/proj must NOT match scope /home/colin/project
        sessions_dir = tmp_path / "sessions"
        _make_session_file(sessions_dir / "collision", cwd="/home/colin/proj")
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results == []

    def test_title_from_first_line(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            title="Refactor auth module",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results[0].title == "Refactor auth module"

    def test_title_from_session_title_event(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        event_line = json.dumps({
            "customType": "session-title",
            "data": {"title": "From event line"},
        })
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            title="",  # no inline title
            extra_lines=[event_line],
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results[0].title == "From event line"

    def test_inline_title_takes_precedence_over_event(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        event_line = json.dumps({
            "customType": "session-title",
            "data": {"title": "Event title"},
        })
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            title="Inline title",
            extra_lines=[event_line],
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results[0].title == "Inline title"

    def test_malformed_first_line_skipped(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        bad_file = sessions_dir / "bad.jsonl"
        bad_file.write_text("this is not json\n")
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        # Should not crash; returns empty
        results = OmpAdapter().list_inactive("/")
        assert results == []

    def test_empty_file_skipped(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        empty_file = sessions_dir / "empty.jsonl"
        empty_file.write_text("")
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/")
        assert results == []

    def test_limit_respected(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        for i in range(10):
            _make_session_file(
                sessions_dir / f"s{i}",
                cwd="/home/colin/project",
                timestamp=f"2025-01-0{1 + (i % 9)}T12:00:00Z",
                stem=f"session_{i:02d}_abc{i:03x}",
            )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project", limit=3)
        assert len(results) == 3

    def test_session_id_extracted_from_hex_suffix(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            stem="2025-01-01T12:00:00_deadbeef",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results[0].session_id == "deadbeef"

    def test_resume_command_set(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        session_file = _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert results[0].resume_command is not None
        assert "omp --session" in results[0].resume_command

    def test_root_scope_includes_everything(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(sessions_dir / "a", cwd="/home/colin/project")
        _make_session_file(
            sessions_dir / "b",
            cwd="/var/lib/data",
            stem="2025-01-02T12:00:00_cafe0001",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/")
        assert len(results) == 2

    def test_malformed_intermediate_lines_do_not_crash(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        bad_event = "{{this is not json}}"
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            extra_lines=[bad_event, json.dumps({"customType": "other"})],
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        # Must not raise; returns the session (skips malformed lines)
        results = OmpAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1

    def test_sorted_by_timestamp_descending(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        _make_session_file(
            sessions_dir / "old",
            cwd="/home/colin/project",
            timestamp="2024-01-01T00:00:00Z",
            title="Old session",
            stem="old_abc001",
        )
        _make_session_file(
            sessions_dir / "new",
            cwd="/home/colin/project",
            timestamp="2025-06-01T00:00:00Z",
            title="New session",
            stem="new_abc002",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project", limit=5)
        assert results[0].title == "New session"
        assert results[1].title == "Old session"


    def test_context_usage_uses_assistant_usage_and_includes_output_tokens(self, tmp_path, monkeypatch):
        sessions_dir = tmp_path / "sessions"
        extra_lines = [
            json.dumps({
                "type": "model_change",
                "model": "anthropic/claude-sonnet-4-6-20260205",
                "role": "default",
            }),
            json.dumps({
                "type": "message",
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 1000,
                        "output": 500,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    },
                },
            }),
        ]
        _make_session_file(
            sessions_dir / "proj",
            cwd="/home/colin/project",
            extra_lines=extra_lines,
            stem="2025-01-01T12:00:00_deadbeef",
        )
        _sessions_dir_patcher(sessions_dir, monkeypatch)

        results = OmpAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1
        assert results[0].context_usage_pct == pytest.approx(0.0015)
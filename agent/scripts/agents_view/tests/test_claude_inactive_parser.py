"""Tests for ClaudeAdapter.list_inactive() parsing and scope filtering."""
from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest

import agents_view.adapters.claude_adapter as claude_mod
from agents_view.adapters.claude_adapter import ClaudeAdapter, _decode_claude_project_dir


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_claude_session(
    projects_dir: Path,
    *,
    project_dir_name: str,
    session_stem: str = "session-abc123",
    cwd: str = "",
    timestamp: str = "2025-01-01T12:00:00Z",
    extra_lines: list[str] | None = None,
) -> Path:
    """Create a minimal Claude Code JSONL session file."""
    proj_dir = projects_dir / project_dir_name
    proj_dir.mkdir(parents=True, exist_ok=True)
    file_path = proj_dir / f"{session_stem}.jsonl"
    first: dict = {"timestamp": timestamp}
    if cwd:
        first["cwd"] = cwd
    lines = [json.dumps(first)]
    if extra_lines:
        lines.extend(extra_lines)
    file_path.write_text("\n".join(lines) + "\n")
    return file_path


def _projects_dir_patcher(tmp_projects: Path, monkeypatch):
    """Patch claude_mod.Path so ~/.claude/projects → *tmp_projects*."""
    real_path = Path

    def fake_path(s):
        if isinstance(s, str) and ".claude/projects" in s:
            return real_path(tmp_projects)
        return real_path(s)

    monkeypatch.setattr(claude_mod, "Path", fake_path)


# ---------------------------------------------------------------------------
# _decode_claude_project_dir unit tests
# ---------------------------------------------------------------------------


class TestDecodeClaudeProjectDir:
    def test_dash_encoded_path(self):
        # Claude encodes /home/colin/project as -home-colin-project
        result = _decode_claude_project_dir("-home-colin-project")
        assert result == "/home/colin/project"

    def test_already_absolute_path(self):
        # If the dir name is something not starting with '-', return as-is
        result = _decode_claude_project_dir("somehash")
        assert result == "somehash"

    def test_url_encoded_chars(self):
        # URL-encoded characters should be decoded
        result = _decode_claude_project_dir("-home-colin-my%20project")
        # After unquote: -home-colin-my project → /home/colin/my project
        assert "home" in result
        assert "colin" in result


# ---------------------------------------------------------------------------
# ClaudeAdapter.list_inactive() tests
# ---------------------------------------------------------------------------


class TestClaudeAdapterListInactive:
    def test_default_limit_is_five(self):
        default_limit = inspect.signature(ClaudeAdapter.list_inactive).parameters["limit"].default
        assert default_limit == 5


    def test_in_scope_session_returned(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="proj1",
            cwd="/home/colin/project",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1
        assert results[0].harness == "claude"
        assert results[0].state == "inactive"
        assert results[0].cwd == "/home/colin/project"

    def test_out_of_scope_session_excluded(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="other",
            cwd="/home/colin/other-project",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results == []

    def test_descendant_cwd_included(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="nested",
            cwd="/home/colin/project/frontend/src",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1

    def test_cwd_fallback_from_dir_name(self, tmp_path, monkeypatch):
        """When first-line JSON has no 'cwd', decode from parent directory name."""
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="-home-colin-project",
            cwd="",  # empty → triggers fallback
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert len(results) == 1
        assert results[0].cwd == "/home/colin/project"

    def test_title_from_customtype_session_title(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        event = json.dumps({
            "customType": "session-title",
            "data": {"title": "Fix login flow"},
        })
        _make_claude_session(
            projects_dir,
            project_dir_name="proj1",
            cwd="/home/colin/project",
            extra_lines=[event],
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results[0].title == "Fix login flow"

    def test_title_from_type_session_title(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        event = json.dumps({
            "type": "session-title",
            "data": {"title": "Auth refactor"},
        })
        _make_claude_session(
            projects_dir,
            project_dir_name="proj1",
            cwd="/home/colin/project",
            extra_lines=[event],
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results[0].title == "Auth refactor"

    def test_malformed_first_line_skipped(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        projects_dir.mkdir(parents=True, exist_ok=True)
        (projects_dir / "bad").mkdir()
        (projects_dir / "bad" / "session.jsonl").write_text("{{not json}}\n")
        _projects_dir_patcher(projects_dir, monkeypatch)

        # Must not crash; malformed file skipped
        results = ClaudeAdapter().list_inactive("/")
        assert results == []

    def test_empty_file_skipped(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        projects_dir.mkdir(parents=True, exist_ok=True)
        (projects_dir / "empty_proj").mkdir()
        (projects_dir / "empty_proj" / "session.jsonl").write_text("")
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/")
        assert results == []

    def test_limit_respected(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        for i in range(8):
            _make_claude_session(
                projects_dir,
                project_dir_name=f"proj{i}",
                cwd="/home/colin/project",
                session_stem=f"sess{i}",
                timestamp=f"2025-0{1 + (i % 9)}-01T12:00:00Z",
            )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project", limit=3)
        assert len(results) == 3

    def test_resume_command_is_claude(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="proj1",
            cwd="/home/colin/project",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results[0].resume_command == "claude"

    def test_root_scope_includes_all_sessions(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="proj_a",
            cwd="/home/colin/project",
        )
        _make_claude_session(
            projects_dir,
            project_dir_name="proj_b",
            cwd="/var/code",
            session_stem="sess_b",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/")
        assert len(results) == 2

    def test_sorted_by_timestamp_descending(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="old_proj",
            cwd="/home/colin/project",
            session_stem="old_sess",
            timestamp="2024-01-01T00:00:00Z",
        )
        _make_claude_session(
            projects_dir,
            project_dir_name="new_proj",
            cwd="/home/colin/project",
            session_stem="new_sess",
            timestamp="2025-06-01T00:00:00Z",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project", limit=5)
        # Newer session should be first
        assert results[0].last_activity_ts is not None
        assert results[1].last_activity_ts is not None
        assert results[0].last_activity_ts > results[1].last_activity_ts

    def test_session_id_is_file_stem(self, tmp_path, monkeypatch):
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="proj1",
            cwd="/home/colin/project",
            session_stem="my-unique-session-id",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results[0].session_id == "my-unique-session-id"

    def test_prefix_collision_excluded(self, tmp_path, monkeypatch):
        # /home/colin/proj must not match scope /home/colin/project
        projects_dir = tmp_path / "projects"
        _make_claude_session(
            projects_dir,
            project_dir_name="proj_collision",
            cwd="/home/colin/proj",
        )
        _projects_dir_patcher(projects_dir, monkeypatch)

        results = ClaudeAdapter().list_inactive("/home/colin/project")
        assert results == []

"""Phase 2 tests for Agents View v2 session organization behavior (§4.1-4.4)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.app import ProjectTabBar, _parse_worktrees, _project_root_for
from agents_view.model import AgentSession


def _make_session(cwd: str = "/home/user/proj", state: str = "active", **kwargs) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=kwargs.pop("session_id", "s1"),
        title=kwargs.pop("title", "t"),
        cwd=cwd,
        state=state,
        **kwargs,
    )


def test_project_root_for_finds_git_dir(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    subdir = tmp_path / "src" / "module"
    subdir.mkdir(parents=True)

    result = _project_root_for(str(subdir), str(tmp_path))

    assert result == str(tmp_path)


def test_project_root_for_returns_none_outside_scope(tmp_path: Path) -> None:
    result = _project_root_for("/tmp/outside", str(tmp_path))
    assert result is None


def test_project_root_for_empty_cwd() -> None:
    assert _project_root_for("", "/home") is None


def test_parse_worktrees_returns_list_for_git_repo(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@t.com"], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "T"], cwd=tmp_path, check=True, capture_output=True)
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, check=True, capture_output=True)

    worktrees = _parse_worktrees(str(tmp_path))

    assert isinstance(worktrees, list)
    assert len(worktrees) >= 1
    assert all("path" in entry for entry in worktrees)


def test_parse_worktrees_returns_empty_for_non_git(tmp_path: Path) -> None:
    result = _parse_worktrees(str(tmp_path))
    assert result == []


def test_write_to_archive_creates_file(tmp_path: Path) -> None:
    from agents_view.adapters.omp_adapter import _write_to_archive

    archive_path = tmp_path / "session_archive.json"
    with patch("agents_view.adapters.omp_adapter._ARCHIVE_FILE", archive_path):
        _write_to_archive(
            session_id="abc123",
            title="Test session",
            branch="feature/test",
            harness="omp",
            role="default",
            final_status="offline",
            ended_ts=1700000000.0,
            cwd="/home/user/proj",
        )

    assert archive_path.exists()
    data = json.loads(archive_path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert data[0]["session_id"] == "abc123"
    assert data[0]["title"] == "Test session"


def test_write_to_archive_no_duplicates(tmp_path: Path) -> None:
    from agents_view.adapters.omp_adapter import _write_to_archive

    archive_path = tmp_path / "session_archive.json"
    with patch("agents_view.adapters.omp_adapter._ARCHIVE_FILE", archive_path):
        for _ in range(3):
            _write_to_archive("dup1", "T", "", "omp", "", "offline", None, "")

    data = json.loads(archive_path.read_text(encoding="utf-8"))
    assert len([entry for entry in data if entry["session_id"] == "dup1"]) == 1


def test_tab_bar_starts_with_all_tab() -> None:
    bar = ProjectTabBar()
    bar.update_tabs([], scope_root="/home/user")

    assert len(bar._tabs) >= 1
    assert bar._tabs[0] == ("ALL", None)


def test_tab_bar_no_tabs_when_no_git_roots(tmp_path: Path) -> None:
    bar = ProjectTabBar()
    sessions = [_make_session(cwd=str(tmp_path))]
    bar.update_tabs(sessions, scope_root=str(tmp_path))

    assert bar._tabs[0][0] == "ALL"

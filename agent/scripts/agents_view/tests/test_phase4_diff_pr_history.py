"""Phase 4 tests for Agents View v2 diff, PR, and history behavior (§6.1-6.4)."""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.adapters.github_adapter import GitHubAdapter, PRInfo
from agents_view.app import (
    _INPUT_HISTORY_CAP,
    AgentsViewApp,
    _parse_diff_colored,
    _parse_diff_stats,
    _render_diff_header,
    )


# ---------------------------------------------------------------------------
# §6.2 _parse_diff_colored
# ---------------------------------------------------------------------------


def test_diff_green_for_added_lines() -> None:
    t = _parse_diff_colored("+added line")
    assert t._spans and "3fb950" in str(t._spans[0].style)


def test_diff_red_for_removed_lines() -> None:
    t = _parse_diff_colored("-removed line")
    assert t._spans and "f85149" in str(t._spans[0].style)


def test_diff_blue_for_hunk_header() -> None:
    t = _parse_diff_colored("@@ -1,4 +1,6 @@ function")
    assert t._spans and "6cb6ff" in str(t._spans[0].style)


def test_diff_dim_for_file_header() -> None:
    t = _parse_diff_colored("--- a/file.py")
    assert t._spans and "636e7b" in str(t._spans[0].style)


def test_diff_dim_for_diff_git_line() -> None:
    t = _parse_diff_colored("diff --git a/file.py b/file.py")
    assert t._spans and "636e7b" in str(t._spans[0].style)


def test_diff_neutral_for_context_line() -> None:
    t = _parse_diff_colored(" context line")
    assert t._spans and "adbac7" in str(t._spans[0].style)


def test_diff_multiline() -> None:
    raw = "+add\n-remove\n context"
    t = _parse_diff_colored(raw)
    assert len(t._spans) == 3
    plain = t.plain
    assert "+add" in plain
    assert "-remove" in plain


def test_parse_diff_stats_counts_totals_and_files() -> None:
    raw = """diff --git a/src/main.py b/src/main.py
index 1111111..2222222 100644
--- a/src/main.py
+++ b/src/main.py
@@ -1,2 +1,3 @@
 line1
-line2
+line2_changed
+line3

diff --git a/tests/test_main.py b/tests/test_main.py
index 3333333..4444444 100644
--- a/tests/test_main.py
+++ b/tests/test_main.py
@@ -5,3 +5,2 @@
-old1
-old2
+new1
 keep
"""
    added, removed, files = _parse_diff_stats(raw)
    assert added == 3
    assert removed == 3
    assert ("src/main.py", 2, 1) in files
    assert ("tests/test_main.py", 1, 2) in files


def test_parse_diff_stats_skips_binary_and_non_hunk_lines() -> None:
    raw = """diff --git a/assets/logo.png b/assets/logo.png
index aaabbbb..ccccddd 100644
Binary files a/assets/logo.png and b/assets/logo.png differ

diff --git a/README.md b/README.md
+outside_hunk
-outside_hunk
"""
    added, removed, files = _parse_diff_stats(raw)
    assert added == 0
    assert removed == 0
    assert files == []


def test_render_diff_header_caps_file_rows_to_eight_and_shows_totals() -> None:
    chunks = []
    for i in range(12):
        chunks.append(
            "\n".join(
                [
                    f"diff --git a/file{i}.txt b/file{i}.txt",
                    "index 0000000..1111111 100644",
                    f"--- a/file{i}.txt",
                    f"+++ b/file{i}.txt",
                    "@@ -1 +1 @@",
                    "+added",
                ]
            )
        )
    raw = "\n\n".join(chunks)
    summary = _render_diff_header(raw).plain
    assert "Changes  +12 -0  (12 files)" in summary
    assert "file0.txt" in summary
    assert "file5.txt" in summary
    assert "file7.txt" not in summary
    assert "█" in summary


def test_render_diff_header_empty_diff_returns_empty_text() -> None:
    assert _render_diff_header("").plain == ""


def test_next_prev_hunk_actions_scroll_to_hunk_positions(monkeypatch: pytest.MonkeyPatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._panel_tab = 1
    app._diff_hunk_positions = [4, 18, 42]
    app._diff_hunk_idx = -1

    class _DummyContainer:
        def __init__(self) -> None:
            self.calls: list[tuple[int | None, bool]] = []

        def scroll_to(self, *, y: int | None = None, animate: bool = True) -> None:
            self.calls.append((y, animate))

    container = _DummyContainer()

    def _fake_query_one(selector: str, _widget_type: object) -> _DummyContainer:
        assert selector == "#diff-panel"
        return container

    monkeypatch.setattr(app, "query_one", _fake_query_one)
    app.action_next_hunk()
    app.action_next_hunk()
    app.action_prev_hunk()

    assert app._diff_hunk_idx == 0
    assert container.calls == [(4, False), (18, False), (4, False)]

# ---------------------------------------------------------------------------
# §6.3 PRInfo glyphs
# ---------------------------------------------------------------------------


def test_pr_info_ci_success_glyph() -> None:
    pr = PRInfo(1, "Test PR", "OPEN", False, "https://github.com/a/b/pull/1", ci_status="success")
    assert pr.ci_glyph == "✔"


def test_pr_info_ci_failure_glyph() -> None:
    pr = PRInfo(2, "Test PR", "OPEN", False, "https://", ci_status="failure")
    assert pr.ci_glyph == "✘"


def test_pr_info_ci_pending_glyph() -> None:
    pr = PRInfo(3, "T", "OPEN", False, "", ci_status="pending")
    assert pr.ci_glyph == "●"


def test_pr_info_ci_unknown_glyph() -> None:
    pr = PRInfo(4, "T", "OPEN", False, "", ci_status="")
    assert pr.ci_glyph == "━"


def test_pr_info_review_approved_glyph() -> None:
    pr = PRInfo(5, "T", "OPEN", False, "", reviews="approved")
    assert pr.review_glyph == "✔"


def test_pr_info_review_changes_requested() -> None:
    pr = PRInfo(6, "T", "OPEN", False, "", reviews="changes_requested")
    assert pr.review_glyph == "!"


def test_pr_info_review_empty() -> None:
    pr = PRInfo(7, "T", "OPEN", False, "")
    assert pr.review_glyph == "—"


# ---------------------------------------------------------------------------
# §6.3 GitHubAdapter owner/repo + cache
# ---------------------------------------------------------------------------


def test_derive_owner_repo_https() -> None:
    adapter = GitHubAdapter()
    with patch("agents_view.adapters.github_adapter.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="https://github.com/owner/repo.git\n",
        )
        result = adapter._derive_owner_repo("/tmp")
    assert result == "owner/repo"


def test_derive_owner_repo_ssh() -> None:
    adapter = GitHubAdapter()
    with patch("agents_view.adapters.github_adapter.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="git@github.com:owner/repo.git\n",
        )
        result = adapter._derive_owner_repo("/tmp")
    assert result == "owner/repo"


def test_derive_owner_repo_non_github() -> None:
    adapter = GitHubAdapter()
    with patch("agents_view.adapters.github_adapter.subprocess.run") as mock_run:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="https://gitlab.com/owner/repo.git\n",
        )
        result = adapter._derive_owner_repo("/tmp")
    assert result is None


def test_github_adapter_cache_ttl() -> None:
    adapter = GitHubAdapter()
    fake_pr = PRInfo(1, "Cached", "OPEN", False, "https://")
    adapter._cache["/myrepo"] = (time.time(), [fake_pr])

    with patch.object(adapter, "_derive_owner_repo") as derive_mock:
        result = adapter.list_prs("/myrepo")

    derive_mock.assert_not_called()
    assert len(result) == 1
    assert result[0].title == "Cached"


def test_github_adapter_returns_empty_for_no_remote(tmp_path: Path) -> None:
    adapter = GitHubAdapter()
    result = adapter.list_prs(str(tmp_path))
    assert result == []


# ---------------------------------------------------------------------------
# §6.4 Input history behavior
# ---------------------------------------------------------------------------


def _new_history_state() -> tuple[dict[str, list[str]], callable]:
    """Replicate _push_input_history logic for focused unit testing."""
    hist: dict[str, list[str]] = {}

    def push(session_id: str, text: str) -> None:
        if not text.strip():
            return
        h = hist.setdefault(session_id, [])
        if text in h:
            h.remove(text)
        h.append(text)
        if len(h) > _INPUT_HISTORY_CAP:
            h[:] = h[-_INPUT_HISTORY_CAP:]

    return hist, push


def test_history_cap() -> None:
    hist, push = _new_history_state()
    for i in range(_INPUT_HISTORY_CAP + 5):
        push("sid", f"msg {i}")
    assert len(hist["sid"]) == _INPUT_HISTORY_CAP


def test_history_dedup() -> None:
    hist, push = _new_history_state()
    push("sid", "hello")
    push("sid", "world")
    push("sid", "hello")  # duplicate: should move to end
    assert hist["sid"] == ["world", "hello"]


def test_history_blank_not_added() -> None:
    hist, push = _new_history_state()
    push("sid", "   ")
    assert hist.get("sid", []) == []


def test_history_per_session_isolation() -> None:
    hist, push = _new_history_state()
    push("s1", "msg1")
    push("s2", "msg2")
    assert "msg1" not in hist.get("s2", [])
    assert "msg2" not in hist.get("s1", [])

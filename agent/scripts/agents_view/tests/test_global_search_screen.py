from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.app import AgentsViewApp, GlobalSearchScreen
from agents_view.model import AgentSession


def _make_session(session_id: str, state: str = "active", **kwargs) -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title=session_id,
        cwd="/tmp",
        state=state,
        **kwargs,
    )


def test_action_global_search_pushes_screen() -> None:
    app = AgentsViewApp(scope_root="/")
    app._sessions = [_make_session("s1")]
    pushed: list[object] = []

    def capture(screen) -> None:
        pushed.append(screen)

    app.push_screen = capture  # type: ignore[assignment,method-assign]
    app.action_global_search()

    assert len(pushed) == 1
    assert isinstance(pushed[0], GlobalSearchScreen)


def test_global_search_short_query_guidance() -> None:
    screen = GlobalSearchScreen(sessions=[])
    results, status = screen._search_sessions("ab")

    assert results == []
    assert status == "Type at least 3 characters"


def test_global_search_resolves_files_and_caps_results(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    sessions_root = tmp_path / ".omp" / "agent" / "sessions" / "demo"
    sessions_root.mkdir(parents=True, exist_ok=True)

    sessions: list[AgentSession] = []
    for idx in range(55):
        sid = f"sess-{idx:02d}"
        file_path = sessions_root / f"log_{sid}.jsonl"
        file_path.write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "message": {
                                "role": "user",
                                "content": f"hello needle from {sid}",
                            }
                        }
                    ),
                    json.dumps(
                        {
                            "message": {
                                "role": "assistant",
                                "content": f"assistant needle reply {sid}",
                            }
                        }
                    ),
                ]
            ),
            encoding="utf-8",
        )
        sessions.append(_make_session(sid, state="active", resume_command=None))

    screen = GlobalSearchScreen(sessions=sessions)
    results, status = screen._search_sessions("needle")

    assert len(results) == 50
    assert status.startswith("50 results")
    assert all(match for _, match in results)
    assert "needle" in results[0][1].lower()
    assert len(screen._session_file_paths) == 55

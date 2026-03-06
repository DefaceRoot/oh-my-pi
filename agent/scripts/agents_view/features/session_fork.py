"""session_fork.py - Fork a session to explore alternative approaches.

Provides F key to fork selected session.
"""

from __future__ import annotations

import json
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Input, Static

_FORKS_FILE = Path.home() / ".omp" / "agents-view-forks.json"
_fork_relationships: dict[str, list[str]] = {}


def load_forks() -> None:
    global _fork_relationships
    try:
        if _FORKS_FILE.exists():
            _fork_relationships = json.loads(_FORKS_FILE.read_text())
    except Exception:
        _fork_relationships = {}


def save_forks() -> None:
    try:
        _FORKS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _FORKS_FILE.write_text(json.dumps(_fork_relationships))
    except Exception:
        pass


def record_fork(parent_id: str, child_id: str) -> None:
    if parent_id not in _fork_relationships:
        _fork_relationships[parent_id] = []
    _fork_relationships[parent_id].append(child_id)
    save_forks()


def is_forked_session(session_id: str) -> bool:
    return any(session_id in children for children in _fork_relationships.values())


class ForkSessionScreen(Screen):
    """Dialog for forking an agent session."""

    BINDINGS = [
        Binding("escape", "dismiss_fork", "Cancel"),
    ]

    CSS = """
    ForkSessionScreen { align: center middle; }
    #fork-dialog {
        width: 60;
        height: auto;
        border: double #444c56;
        background: #22272e;
        padding: 1 2;
    }
    #fork-title { color: #6cb6ff; margin-bottom: 1; }
    #fork-cwd { color: #636e7b; margin-bottom: 1; }
    #fork-help { color: #444c56; margin-top: 1; }
    """

    def __init__(self, session: object) -> None:
        super().__init__()
        self._session = session

    def compose(self) -> ComposeResult:
        title = getattr(self._session, "title", "Session")
        cwd = getattr(self._session, "cwd", "")
        with Vertical(id="fork-dialog"):
            yield Static(f"⏡ Fork: {title[:40]}", id="fork-title")
            yield Static(f"CWD: {cwd}", id="fork-cwd")
            yield Input(
                value=f"{title} (fork)",
                placeholder="New session title...",
                id="fork-name",
            )
            yield Static("Enter: fork  Esc: cancel", id="fork-help")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss({"title": event.value, "session": self._session})

    def action_dismiss_fork(self) -> None:
        self.dismiss(None)


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp, HelpScreen

        load_forks()

        def _action_fork_session(self: object) -> None:
            sessions = getattr(self, "_sessions", [])
            try:
                table = self.query_one("#session-table")  # type: ignore[attr-defined]
                cursor_row = table.cursor_row
                visible = getattr(self, "_visible_sessions", sessions)
                if 0 <= cursor_row < len(visible):
                    s = visible[cursor_row]

                    def _on_fork(result: dict | None) -> None:
                        if not result:
                            return
                        new_title = result.get(
                            "title",
                            getattr(s, "title", "fork") + " (fork)",
                        )
                        cwd = getattr(result.get("session", s), "cwd", ".")
                        import subprocess

                        try:
                            subprocess.Popen(
                                [
                                    "tmux",
                                    "new-window",
                                    "-n",
                                    new_title[:20],
                                    f'cd "{cwd}" && echo "Fork: {new_title}" && bash',
                                ],
                            )
                            self.notify(f"⏡ Forked: {new_title}")  # type: ignore[attr-defined]
                        except Exception as exc:
                            self.notify(  # type: ignore[attr-defined]
                                f"Fork failed: {exc}",
                                severity="warning",
                            )

                    self.push_screen(ForkSessionScreen(s), _on_fork)  # type: ignore[attr-defined]
            except Exception:
                pass

        AgentsViewApp.action_fork_session = _action_fork_session  # type: ignore[attr-defined]

        existing_keys = {b.key for b in AgentsViewApp.BINDINGS}
        if "F" not in existing_keys:
            AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
                Binding("F", "fork_session", "Fork session"),
            ]

        entry = ("Session", "F", "Fork session")
        if entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(entry)
    except Exception:
        pass


_patch_app()

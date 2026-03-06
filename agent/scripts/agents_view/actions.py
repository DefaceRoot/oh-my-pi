from __future__ import annotations

import logging

from collections.abc import Iterable
from agents_view.model import AgentSession
from agents_view.tmux_client import TmuxClient, TmuxError

log = logging.getLogger(__name__)


def teleport(client: TmuxClient, session: AgentSession) -> None:
    """Switch tmux client focus to the pane of an active session."""
    if not session.tmux_pane:
        log.warning("teleport: session %s has no tmux_pane", session.session_id)
        return
    if not client.pane_exists(session.tmux_pane):
        log.warning("teleport: pane %s no longer exists", session.tmux_pane)
        return
    try:
        client.switch_to_pane(
            session.tmux_session or "",
            session.tmux_window or "",
            session.tmux_pane,
        )
    except TmuxError as e:
        log.error("teleport failed: %s", e)


def resume(client: TmuxClient, session: AgentSession, current_tmux_session: str) -> None:
    """Open a new tmux window and run the resume command for an inactive session."""
    cmd = session.resume_command
    if not cmd:
        log.warning("resume: no resume_command for session %s", session.session_id)
        return
    try:
        window_id = client.new_window(
            cmd, session=current_tmux_session, name=f"resume-{session.harness}"
        )
        if window_id:
            try:
                client.run(["select-window", "-t", window_id])
            except Exception:
                log.debug("resume: could not focus window %s", window_id)
    except TmuxError as e:
        log.error("resume failed: %s", e)


def create_session(client: TmuxClient, tmux_session: str, harness: str = "omp") -> None:
    """Open a new tmux window running the selected harness command."""
    command = (harness or "omp").strip() or "omp"
    try:
        client.new_window(command, session=tmux_session, name=command)
    except TmuxError as e:
        log.error("create_session failed: %s", e)


def kill_session(client: TmuxClient, session: AgentSession) -> None:
    """Kill an active session's tmux pane when pane metadata exists."""
    if not session.tmux_pane:
        log.warning("kill_session: session %s has no tmux_pane", session.session_id)
        return
    try:
        client.kill_pane(session.tmux_pane)
    except TmuxError as e:
        log.error("kill_session failed: %s", e)


def send_input(client: TmuxClient, pane_id: str, text: str) -> None:
    """Send text followed by Enter to the given pane."""
    try:
        client.send_keys(pane_id, text, enter=True)
    except TmuxError as e:
        log.error("send_input failed: %s", e)


def broadcast_input(client: TmuxClient, sessions: Iterable[AgentSession], text: str) -> list[str]:
    """Send text to multiple sessions, skipping entries without pane ids."""
    sent_to: list[str] = []
    for session in sessions:
        pane_id = (session.tmux_pane or "").strip()
        if not pane_id:
            log.debug("broadcast_input: skipping session %s without tmux_pane", session.session_id)
            continue
        try:
            client.send_keys(pane_id, text, enter=True)
            sent_to.append(pane_id)
        except TmuxError as e:
            log.error("broadcast_input failed for pane %s: %s", pane_id, e)
    return sent_to

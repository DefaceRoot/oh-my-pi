"""Tests for the unseen-review pulse feature.

Covers:
- _update_unseen_review(): transition tracking into/out of _unseen_review_ids
- _status_cell(): pulse alternates between bright/dim when session is unseen-review
- Hover (on_data_table_row_highlighted logic): discards from _unseen_review_ids
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

pytest.importorskip("textual")

from agents_view.app import AgentsViewApp
from agents_view.model import AgentSession


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _app() -> AgentsViewApp:
    """Return a bare AgentsViewApp without a running event loop."""
    return AgentsViewApp(scope_root="/")


def _session(sid: str, status: str, state: str = "active") -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=sid,
        title=sid,
        cwd="/tmp",
        state=state,
        status=status,
    )


# ---------------------------------------------------------------------------
# _update_unseen_review — transition tracking
# ---------------------------------------------------------------------------


def test_fresh_review_transition_adds_to_unseen():
    """Non-review → review adds the session to _unseen_review_ids."""
    app = _app()
    app._sessions = [_session("s1", "running")]
    app._update_unseen_review([_session("s1", "review")])
    assert "s1" in app._unseen_review_ids


def test_stable_review_does_not_re_add():
    """review → review (no change) must NOT reset the unseen marker (hover must be sticky)."""
    app = _app()
    app._sessions = [_session("s1", "review")]
    app._unseen_review_ids.add("s1")  # already unseen
    app._update_unseen_review([_session("s1", "review")])
    # Still in the set — good; but also: if it had been seen (discarded), re-adding
    # would be wrong.  Test the "was seen" path:
    app._unseen_review_ids.discard("s1")  # simulate hover
    app._update_unseen_review([_session("s1", "review")])
    assert "s1" not in app._unseen_review_ids, (
        "Hovering should suppress the pulse for the current review round; "
        "re-adding on the same review status is wrong."
    )


def test_leaving_review_removes_from_unseen():
    """Any non-review status removes the session from _unseen_review_ids."""
    app = _app()
    app._sessions = [_session("s1", "review")]
    app._unseen_review_ids.add("s1")
    for status in ("running", "idle", "offline", "stalled", "wait"):
        app._unseen_review_ids.add("s1")
        app._update_unseen_review([_session("s1", status)])
        assert "s1" not in app._unseen_review_ids, (
            f"status={status!r} should clear the unseen marker"
        )


def test_first_load_review_sessions_are_unseen():
    """Sessions that are in 'review' at first load (prev=empty) are added."""
    app = _app()
    # _sessions starts empty — prev dict will be empty
    assert app._sessions == []
    app._update_unseen_review([_session("s1", "review"), _session("s2", "running")])
    assert "s1" in app._unseen_review_ids
    assert "s2" not in app._unseen_review_ids


def test_new_review_after_hover_re_adds():
    """If a session re-enters review after the user already hovered, pulse restarts."""
    app = _app()
    # Round 1: enter review, user hovers, pulse cleared
    app._sessions = [_session("s1", "running")]
    app._update_unseen_review([_session("s1", "review")])
    assert "s1" in app._unseen_review_ids
    app._unseen_review_ids.discard("s1")  # user hovers

    # Session leaves review
    app._sessions = [_session("s1", "review")]
    app._update_unseen_review([_session("s1", "running")])
    assert "s1" not in app._unseen_review_ids

    # Round 2: enter review again — should be unseen again
    app._sessions = [_session("s1", "running")]
    app._update_unseen_review([_session("s1", "review")])
    assert "s1" in app._unseen_review_ids, (
        "After leaving and re-entering review, the pulse must restart."
    )


def test_multiple_sessions_tracked_independently():
    """Multiple sessions with different statuses are tracked independently."""
    app = _app()
    app._sessions = [
        _session("s1", "running"),
        _session("s2", "idle"),
        _session("s3", "review"),  # already in review
    ]
    new = [
        _session("s1", "review"),   # freshly entered
        _session("s2", "running"),  # still not review
        _session("s3", "review"),   # already was review (no change)
    ]
    app._update_unseen_review(new)
    assert "s1" in app._unseen_review_ids   # new
    assert "s2" not in app._unseen_review_ids  # not review
    assert "s3" not in app._unseen_review_ids  # was already review (prev == new)


# ---------------------------------------------------------------------------
# _status_cell — pulse color output
# ---------------------------------------------------------------------------


def _bright_phase_time() -> float:
    """Return a time value where sin(t * pi / 0.7) >= 0 (bright phase)."""
    # sin is >= 0 for t in [0, 0.7], [1.4, 2.1], ... within each 1.4s cycle.
    # t=0.35 is firmly in the bright phase: sin(0.35 * pi / 0.7) = sin(pi/2) = 1.0
    import time
    # Find the nearest bright phase from current time
    t = time.time()
    cycle = 1.4
    phase_in_cycle = (t % cycle)
    # bright when phase_in_cycle in [0, 0.7)
    if phase_in_cycle < 0.7:
        return t  # already bright
    return t + (cycle - phase_in_cycle)  # advance to next bright start + small offset


def _dim_phase_time() -> float:
    """Return a time value where sin(t * pi / 0.7) < 0 (dim phase)."""
    import time
    t = time.time()
    cycle = 1.4
    phase_in_cycle = (t % cycle)
    if 0.7 <= phase_in_cycle < 1.4:
        return t  # already dim
    return t + (0.7 - phase_in_cycle)  # advance to dim start + small offset


def test_unseen_review_bright_phase_uses_normal_style():
    """In bright phase, status cell uses the standard bold review color."""
    app = _app()
    s = _session("s1", "review")
    app._unseen_review_ids.add("s1")

    with patch("time.time", return_value=0.35):  # sin(0.35 * pi/0.7) = sin(pi/2) = 1.0
        cell = app._status_cell(s)

    assert "#79c0ff" in cell.style, (
        f"Bright phase should use the standard review color, got style={cell.style!r}"
    )


def test_unseen_review_dim_phase_uses_muted_style():
    """In dim phase, status cell uses the muted dark-blue color."""
    app = _app()
    s = _session("s1", "review")
    app._unseen_review_ids.add("s1")

    # t=1.05: sin(1.05 * pi/0.7) = sin(1.5 * pi) = -1.0 → dim
    with patch("time.time", return_value=1.05):
        cell = app._status_cell(s)

    assert "#2a5580" in cell.style, (
        f"Dim phase should use the muted color, got style={cell.style!r}"
    )


def test_seen_review_no_pulse():
    """Session in review that the user has already hovered renders normally (no dim)."""
    app = _app()
    s = _session("s1", "review")
    # Do NOT add to _unseen_review_ids (simulates hover already happened)

    with patch("time.time", return_value=1.05):  # dim phase
        cell = app._status_cell(s)

    assert "#2a5580" not in cell.style, (
        "Seen review session must never dim — pulse is for unseen only."
    )
    assert "#79c0ff" in cell.style


def test_non_review_status_never_pulses():
    """Even if somehow in _unseen_review_ids, non-review status cells are never dimmed."""
    app = _app()
    for status in ("running", "idle", "offline", "stalled", "asking"):
        s = _session("s1", status)
        app._unseen_review_ids.add("s1")
        with patch("time.time", return_value=1.05):  # dim phase
            cell = app._status_cell(s)
        assert "#2a5580" not in cell.style, (
            f"status={status!r} should not be dimmed by the review pulse guard"
        )



def test_low_confidence_status_appends_question_mark() -> None:
    app = _app()
    session = _session("s1", "running")
    session.status_confidence = 0.4

    cell = app._status_cell(session)

    assert cell.plain.endswith("?")
    assert "RUN?" in cell.plain
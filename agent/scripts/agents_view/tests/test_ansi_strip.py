"""Tests for ANSI stripping behavior in the preview pane."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.app import _ANSI_STRIP_RE


def test_ansi_strip_preserves_sgr_color_codes() -> None:
    text = "\x1b[32mGreen\x1b[0m and \x1b[1;32mBoldGreen\x1b[0m"
    assert _ANSI_STRIP_RE.sub("", text) == text


def test_ansi_strip_removes_non_color_control_sequences() -> None:
    text = "\x1b[?25h\x1b[?2004h\x1b[H\x1b[2JVisible"
    assert _ANSI_STRIP_RE.sub("", text) == "Visible"

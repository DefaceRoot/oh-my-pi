from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents_view.sidebar_telemetry import resolve_sidebar_mode


def test_resolve_sidebar_mode_defaults_to_explorer_for_role_one() -> None:
    assert resolve_sidebar_mode(None, None, "1") == "explorer"


def test_resolve_sidebar_mode_defaults_to_telemetry_for_role_two() -> None:
    assert resolve_sidebar_mode(None, None, "2") == "telemetry"


def test_resolve_sidebar_mode_prefers_env_override_over_role_default() -> None:
    assert resolve_sidebar_mode("telemetry", "explorer", "1") == "telemetry"


def test_resolve_sidebar_mode_uses_tmux_override_when_env_missing() -> None:
    assert resolve_sidebar_mode("", "yazi", "2") == "explorer"


def test_resolve_sidebar_mode_falls_back_to_telemetry_for_unknown_role() -> None:
    assert resolve_sidebar_mode(None, None, "") == "telemetry"


def test_resolve_sidebar_mode_split_uses_role_one_for_explorer() -> None:
    assert resolve_sidebar_mode(None, "split", "1") == "explorer"


def test_resolve_sidebar_mode_split_uses_role_two_for_telemetry() -> None:
    assert resolve_sidebar_mode(None, "split", "2") == "telemetry"
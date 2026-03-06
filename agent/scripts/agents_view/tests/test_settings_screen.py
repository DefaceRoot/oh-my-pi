from __future__ import annotations

import asyncio
import json
from pathlib import Path

from textual.widgets import DataTable

from agents_view import app as app_mod


def test_main_bindings_and_help_include_config_shortcut() -> None:
    assert any(
        getattr(binding, "action", "") == "show_settings" and binding.key == "C"
        for binding in app_mod.AgentsViewApp.BINDINGS
    )
    assert ("Screens", "C", "Config") in set(app_mod.HelpScreen._BINDINGS_TABLE)
    assert "    C            Config" in app_mod._HELP_TEXT


def test_startup_load_applies_agents_view_settings(monkeypatch, tmp_path: Path) -> None:
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "agents_view": {
                    "refresh_interval_seconds": 5,
                    "stall_threshold_seconds": 120,
                    "auto_kill_stalled_minutes": 30,
                    "stale_worktree_days": 14,
                    "max_inactive": 20,
                    "preview_tail_bytes": 12345,
                }
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(app_mod, "_SETTINGS_FILE", settings_path)

    old_tail = app_mod._JSONL_TAIL_BYTES
    old_max_inactive = app_mod._MAX_VISIBLE_INACTIVE
    old_stall_threshold = app_mod.model.STALL_THRESHOLD_SECONDS
    try:
        app = app_mod.AgentsViewApp(scope_root="/")
        app._adapters = []

        assert app_mod._JSONL_TAIL_BYTES == app_mod._DEFAULT_AGENTS_VIEW_SETTINGS["preview_tail_bytes"]
        assert app_mod._MAX_VISIBLE_INACTIVE == 20
        assert app_mod.model.STALL_THRESHOLD_SECONDS == 120
        assert app._auto_kill_stalled_minutes == 30
    finally:
        app_mod._JSONL_TAIL_BYTES = old_tail
        app_mod._MAX_VISIBLE_INACTIVE = old_max_inactive
        app_mod.model.STALL_THRESHOLD_SECONDS = old_stall_threshold


def test_settings_screen_bindings_include_required_keys() -> None:
    required = {
        ("escape", "dismiss"),
        ("s", "save_settings"),
        ("enter", "save_settings"),
        ("up", "move_up"),
        ("down", "move_down"),
        ("left", "decrement"),
        ("right", "increment"),
    }
    existing = {
        (binding.key, getattr(binding, "action", ""))
        for binding in app_mod.SettingsScreen.BINDINGS
    }
    assert required.issubset(existing)


def test_config_screen_adjusts_with_arrows_and_s_saves(monkeypatch, tmp_path: Path) -> None:
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(app_mod, "_SETTINGS_FILE", settings_path)

    app = app_mod.AgentsViewApp(scope_root="/")
    app._adapters = []

    notifications: list[str] = []
    app.notify = lambda message, *args, **kwargs: notifications.append(str(message))  # type: ignore[method-assign]

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("C")
            await asyncio.sleep(0)

            assert isinstance(app.screen, app_mod.SettingsScreen)
            screen = app.screen

            table = screen.query_one("#settings-table", DataTable)
            assert table.row_count > 0
            table.move_cursor(row=0)
            original_refresh = screen._values["refresh_interval_seconds"]

            screen.action_increment()
            bumped_refresh = screen._values["refresh_interval_seconds"]
            assert bumped_refresh != original_refresh

            screen.action_decrement()
            assert screen._values["refresh_interval_seconds"] == original_refresh

            screen.action_increment()
            await asyncio.sleep(0)
            await pilot.press("s")
            await asyncio.sleep(0)

            assert not isinstance(app.screen, app_mod.SettingsScreen)

    asyncio.run(run())

    payload = json.loads(settings_path.read_text(encoding="utf-8"))
    agents_view = payload.get("agents_view", {})
    assert agents_view["refresh_interval_seconds"] in {1, 2, 3, 5, 10}
    assert notifications and notifications[-1] == "Settings saved"
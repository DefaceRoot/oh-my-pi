"""command_palette_enhancements.py - Extra commands for the Textual command palette.
Monkey-patches AgentsViewCommandProvider to surface new feature actions.
"""

from __future__ import annotations

_EXTRA_COMMANDS: list[tuple[str, str, str]] = [
    ("Activity heatmap", "action_activity_heatmap", "Show 24-hour activity heatmap"),
    ("Cost breakdown", "action_cost_breakdown", "Show per-session cost breakdown"),
    (
        "Toggle conversation view",
        "action_toggle_conversation_preview",
        "Toggle parsed conversation preview",
    ),
    ("Select all sessions", "action_select_all_sessions", "Select all sessions for batch ops"),
    ("Clear multi-select", "action_clear_selection", "Clear multi-select"),
    ("Session notes", "action_session_notes", "Open notes for selected session"),
    ("Set label", "action_set_label", "Set label/emoji for selected session"),
    ("Pin session", "action_toggle_pin", "Toggle pin for selected session"),
    ("Fork session", "action_fork_session", "Fork selected session"),
    ("Theme picker", "action_theme_picker", "Open theme picker"),
    ("Quick actions", "action_quick_actions", "Open quick actions menu"),
    ("Export session", "action_export_session", "Export selected session to Markdown"),
    ("Clear preview cache", "action_clear_preview_cache", "Clear cached preview content"),
    ("Archive sweep", "action_archive_sweep", "Auto-archive old completed sessions"),
]

_PATCHED = False


def _patch_app() -> None:
    global _PATCHED
    if _PATCHED:
        return

    try:
        from agents_view.app import AgentsViewCommandProvider

        if not hasattr(AgentsViewCommandProvider, "_extra_feature_commands"):
            AgentsViewCommandProvider._extra_feature_commands = []

        existing_names = {c[0] for c in AgentsViewCommandProvider._extra_feature_commands}
        for cmd in _EXTRA_COMMANDS:
            if cmd[0] not in existing_names:
                AgentsViewCommandProvider._extra_feature_commands.append(cmd)

        _orig_search = getattr(AgentsViewCommandProvider, "search", None)

        async def _enhanced_search(self, query: str):  # type: ignore[override]
            if _orig_search is not None:
                async for hit in _orig_search(self, query):
                    yield hit

            from textual.command import Hit as _Hit

            q = query.lower()
            for name, action_name, help_text in getattr(self.__class__, "_extra_feature_commands", []):
                if q in name.lower() or q in help_text.lower():
                    method = getattr(self.app, action_name, None)
                    if method is not None:
                        try:
                            yield _Hit(
                                score=0.4,
                                match_display=name,
                                command=method,
                                help=help_text,
                            )
                        except Exception:
                            pass

        AgentsViewCommandProvider.search = _enhanced_search  # type: ignore[method-assign]
        _PATCHED = True
    except Exception:
        pass


_patch_app()

"""Focused tests for preview sanitization and rendering behavior."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import agents_view.app as app_mod
from agents_view.app import (
    AgentsViewApp,
    SessionLogScreen,
    _build_sparkline,
    _extract_last_user_messages,
    _extract_session_file_path,
    _extract_status_timeline,
    _read_jsonl_tail_lines,
    _render_active_preview,
    _sanitize_preview_ansi,
 )
from agents_view.model import AgentSession


def _active_session(session_id: str = "active-1", pane: str = "%1") -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title="Active Session",
        cwd="/tmp/project",
        state="active",
        tmux_pane=pane,
        last_activity_ts=1_000,
    )


def _inactive_session(session_id: str = "inactive-1") -> AgentSession:
    return AgentSession(
        harness="omp",
        session_id=session_id,
        title="Inactive Session",
        cwd="/tmp/project",
        state="inactive",
        last_activity_ts=1_000,
    )


def _preview_text(app: AgentsViewApp) -> str:
    return str(app.query_one("#preview-content").content)


def test_sanitize_preview_ansi_preserves_foreground_and_strips_highlight_effects() -> None:
    mixed = "\x1b[32mGreen\x1b[0m and \x1b[7;41;97mWarn\x1b[0m"
    cleaned = _sanitize_preview_ansi(mixed)

    assert "\x1b[32mGreen" in cleaned
    assert "\x1b[97mWarn" in cleaned
    assert "[7;" not in cleaned
    assert "[41" not in cleaned


def test_sanitize_preview_ansi_removes_private_and_osc_sequences() -> None:
    noisy = "\x1b]0;set-title\x07\x1b[?25l\x1b[?2004hVisible"
    assert _sanitize_preview_ansi(noisy) == "Visible"


def test_update_preview_empty_pane_renders_placeholder(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session()

    monkeypatch.setattr(app._tmux, "capture_pane", lambda pane_id, lines=200: "")

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            app._update_preview()
            await asyncio.sleep(0)
            assert _preview_text(app) == "[empty pane]"

            # Cached empty content should not clear the explicit placeholder.
            app._update_preview()
            await asyncio.sleep(0)
            assert _preview_text(app) == "[empty pane]"

    asyncio.run(run())


def test_update_preview_handles_mixed_ansi_without_control_leaks(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="active-ansi", pane="%2")

    raw = "\x1b[?25l\x1b[32mGreen\x1b[0m \x1b[7;45;97mWarn\x1b[0m\x1b]0;title\x07"
    monkeypatch.setattr(app._tmux, "capture_pane", lambda pane_id, lines=200: raw)

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            app._update_preview()
            await asyncio.sleep(0)

            rendered = _preview_text(app)
            assert "Green Warn" in rendered
            assert "\x1b" not in rendered
            assert "title" not in rendered

    asyncio.run(run())


def test_preview_cache_resets_when_switching_to_metadata_view(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    active = _active_session(session_id="active-empty", pane="%3")
    inactive = _inactive_session()

    monkeypatch.setattr(app._tmux, "capture_pane", lambda pane_id, lines=200: "")

    async def run() -> None:
        async with app.run_test():
            app._selected_session = active
            app._update_preview()
            await asyncio.sleep(0)
            assert _preview_text(app) == "[empty pane]"

            app._selected_session = inactive
            app._update_preview()
            await asyncio.sleep(0)
            assert "Status:" in _preview_text(app)

            app._selected_session = active
            app._update_preview()
            await asyncio.sleep(0)
            assert _preview_text(app) == "[empty pane]"

    asyncio.run(run())


def test_sanitize_preview_ansi_normalizes_c1_sgr_and_drops_c1_controls() -> None:
    noisy = "\x9b32mGreen\x9b0m \x9b7;45;97mWarn\x9b0m\x9d0;title\x07"
    cleaned = _sanitize_preview_ansi(noisy)

    assert "\x1b[32mGreen\x1b[0m" in cleaned
    assert "\x1b[97mWarn\x1b[0m" in cleaned
    assert "\x9b" not in cleaned
    assert "\x9d" not in cleaned
    assert "[45" not in cleaned
    assert "[7;" not in cleaned


def test_sanitize_preview_ansi_removes_dec_single_escapes_without_artifacts() -> None:
    noisy = "A\x1b7B\x1b8C\x1bcD"
    assert _sanitize_preview_ansi(noisy) == "ABCD"


def test_update_preview_skips_rerender_when_sanitized_text_unchanged(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="active-stable", pane="%4")

    raw = "\x1b[?25l\x1b[32mGreen\x1b[0m"
    monkeypatch.setattr(app._tmux, "capture_pane", lambda pane_id, lines=200: raw)

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            preview = app.query_one("#preview-content")
            call_count = 0
            original_update = preview.update

            def counted_update(content):
                nonlocal call_count
                call_count += 1
                return original_update(content)

            monkeypatch.setattr(preview, "update", counted_update)

            app._update_preview()
            await asyncio.sleep(0)
            first_call_count = call_count
            assert first_call_count > 0

            app._update_preview()
            await asyncio.sleep(0)
            assert call_count == first_call_count

    asyncio.run(run())


def test_render_active_preview_reuses_cached_mtime_result(monkeypatch, tmp_path) -> None:
    app_mod._PREVIEW_CACHE.clear()
    session_file = tmp_path / "cached-preview.jsonl"
    session_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                json.dumps(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": "hello from cache"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    read_count = 0
    original_reader = app_mod._read_jsonl_tail_lines

    def counting_reader(path: str, tail_bytes: int = app_mod._JSONL_TAIL_BYTES):
        nonlocal read_count
        read_count += 1
        return original_reader(path, tail_bytes)

    monkeypatch.setattr(app_mod, "_read_jsonl_tail_lines", counting_reader)

    first = str(_render_active_preview(str(session_file)))
    second = str(_render_active_preview(str(session_file)))

    assert "hello from cache" in first
    assert "hello from cache" in second
    assert read_count == 1

    session_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                json.dumps(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": "updated output"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    os.utime(session_file, None)

    third = str(_render_active_preview(str(session_file)))
    assert "updated output" in third
    assert read_count == 2


def test_update_table_reschedules_preview_for_selected_active_session(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="stable-preview", pane="%12")

    async def run() -> None:
        async with app.run_test():
            app._sessions = [session]
            app._selected_session = session
            app._update_table()

            timer_calls: list[float] = []
            monkeypatch.setattr(
                app,
                "set_timer",
                lambda interval, callback, *args, **kwargs: timer_calls.append(float(interval)) or object(),
            )

            session.status = "running"
            app._sessions = [session]
            app._update_table()

            assert timer_calls == [0.05]

    asyncio.run(run())


def test_row_highlighted_uses_50ms_preview_debounce(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="debounce-preview", pane="%13")

    async def run() -> None:
        async with app.run_test():
            app._sessions = [session]
            app._update_table()
            table = app.query_one("#session-table")

            timer_calls: list[float] = []
            monkeypatch.setattr(
                app,
                "set_timer",
                lambda interval, callback, *args, **kwargs: timer_calls.append(float(interval)) or object(),
            )

            app.on_data_table_row_highlighted(SimpleNamespace(cursor_row=0, data_table=table))

            assert timer_calls
            assert timer_calls[-1] <= 0.05

    asyncio.run(run())

def test_render_active_preview_from_jsonl_includes_structured_sections(tmp_path) -> None:
    session_file = tmp_path / "session.jsonl"
    # Real OMP JSONL: type='message' records; tool calls inside message.content[].type='toolCall'
    entries = [
        # Session record (first line) — has cwd for Session section
        {"type": "message", "cwd": "/tmp/project", "title": "Test session"},
        # Assistant message with a todo_write toolCall (args carry the task list)
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "name": "todo_write",
                        "arguments": {
                            "ops": [
                                {
                                    "op": "replace",
                                    "phases": [
                                        {
                                            "name": "Phase 1",
                                            "tasks": [
                                                {"status": "in_progress", "content": "Implement preview parser"},
                                                {"status": "pending", "content": "Polish spacing"},
                                                {"status": "completed", "content": "Add tests"},
                                            ],
                                        }
                                    ],
                                }
                            ]
                        },
                    },
                    {"type": "text", "text": "Preview parser is running successfully."},
                ],
            },
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file)))
    assert "todo_write" in rendered         # tool name shown as current activity
    assert "Last output" in rendered
    assert "Tasks" in rendered
    assert "Session" in rendered
    assert "Implement preview parser" in rendered


def test_render_active_preview_supports_claude_tool_use_schema(tmp_path) -> None:
    session_file = tmp_path / "tool-use.jsonl"
    entries = [
        {"type": "message", "cwd": "/tmp/project"},
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Read",
                        "input": {"path": "/foo"},
                        "id": "toolu_1",
                    }
                ],
            },
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file)))
    assert "Read" in rendered
    assert "toolu_1" not in rendered
    assert "{'path': '/foo'}" not in rendered
    assert '"path": "/foo"' not in rendered


def test_render_active_preview_suppresses_system_output_and_meta_noise(tmp_path) -> None:
    session_file = tmp_path / "noise.jsonl"
    entries = [
        {"type": "message", "cwd": "/tmp/project"},
        {
            "type": "message",
            "message": {
                "role": "user",
                "content": "<local-command-stdout>some noisy output</local-command-stdout>",
            },
        },
        {
            "type": "message",
            "customType": "meta",
            "message": {
                "role": "user",
                "content": "this meta record should be suppressed",
            },
        },
        {"type": "message", "message": {"role": "user", "content": "what is 2+2"}},
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file)))
    assert "what is 2+2" in rendered
    assert "local-command-stdout" not in rendered
    assert "noisy output" not in rendered


def test_render_active_preview_includes_task_call_summary(tmp_path) -> None:
    session_file = tmp_path / "task-call.jsonl"
    entries = [
        {"type": "message", "cwd": "/tmp/project"},
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "name": "Task",
                        "arguments": {
                            "subagent_type": "explore",
                            "description": "Find auth module",
                            "name": "AuthExplorer",
                        },
                    }
                ],
            },
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file)))
    assert "Find auth module" in rendered
    assert ("explore" in rendered) or ("Task" in rendered)


def test_extract_status_timeline_renders_time_based_bar(tmp_path) -> None:
    session_file = tmp_path / "timeline.jsonl"
    entries = [
        {"type": "session", "timestamp": "2026-02-27T04:00:00Z"},
        {
            "type": "message",
            "timestamp": "2026-02-27T04:00:00Z",
            "message": {"role": "user", "content": "Start build"},
        },
        {
            "type": "message",
            "timestamp": "2026-02-27T04:01:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "name": "Read", "arguments": {"path": "/tmp"}}],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-02-27T04:02:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Reasoning through next step"}],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-02-27T04:20:00Z",
            "message": {"role": "user", "content": "Any updates?"},
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_extract_status_timeline(str(session_file), width=20))

    assert rendered.startswith("[")
    assert "total" in rendered
    assert any(glyph in rendered for glyph in ("█", "▓", "░", "·"))


def test_extract_status_timeline_falls_back_to_activity_mix_without_timestamps(tmp_path) -> None:
    session_file = tmp_path / "timeline-fallback.jsonl"
    entries = [
        {"type": "message", "message": {"role": "user", "content": "Check status"}},
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "echo ok"}}],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Finished command"}],
            },
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_extract_status_timeline(str(session_file), width=20))

    assert "Activity mix:" in rendered
    assert "Working" in rendered
    assert "Thinking" in rendered
    assert "Waiting" in rendered


def test_extract_status_timeline_marks_new_sessions(tmp_path) -> None:
    session_file = tmp_path / "timeline-new-session.jsonl"
    entries = [
        {"type": "message", "message": {"role": "user", "content": "Hi"}},
        {"type": "message", "message": {"role": "assistant", "content": "Hello"}},
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    assert str(_extract_status_timeline(str(session_file), width=20)) == "[new session]"


def test_build_sparkline_handles_empty_list() -> None:
    assert _build_sparkline([], width=8) == "········"


def test_render_active_preview_includes_timeline_and_activity_sparkline(tmp_path) -> None:
    session_file = tmp_path / "preview-timeline.jsonl"
    entries = [
        {"type": "message", "cwd": "/tmp/project", "timestamp": "2026-02-27T04:00:00Z"},
        {
            "type": "message",
            "timestamp": "2026-02-27T04:00:00Z",
            "message": {"role": "user", "content": "Start"},
        },
        {
            "type": "message",
            "timestamp": "2026-02-27T04:01:00Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "toolCall", "name": "todo_write", "arguments": {"ops": []}},
                    {"type": "text", "text": "Working"},
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-02-27T04:02:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Thinking"}],
            },
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file)))

    assert "Timeline" in rendered
    assert "Activity:" in rendered
    assert "Session Info" in rendered
    assert "Tools" in rendered
    assert "Subagents" in rendered
def test_update_preview_active_omp_uses_jsonl_not_tmux(monkeypatch, tmp_path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="active-jsonl", pane="%5")
    session_file = tmp_path / "active.jsonl"
    session_file.write_text(
        "\n".join(
            [
                # Session metadata record
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                # Assistant message with toolCall then text
                json.dumps({
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "toolCall", "name": "todo_write", "arguments": {"ops": []}},
                            {"type": "text", "text": "Streaming response from JSONL"},
                        ],
                    },
                }),
            ]
        ),
        encoding="utf-8",
    )
    session.resume_command = f"omp --session '{session_file}'"

    def fail_capture(_pane_id, lines=200):
        raise AssertionError("tmux capture should not be used for OMP JSONL previews")

    monkeypatch.setattr(app._tmux, "capture_pane", fail_capture)

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            app._update_preview()
            await asyncio.sleep(0)

            rendered = _preview_text(app)
            assert "todo_write" in rendered  # tool name shown in header
            assert "Streaming response from JSONL" in rendered
            assert "[preview unavailable]" not in rendered

    asyncio.run(run())



def test_render_active_preview_shows_omitted_line_hint_when_trimmed(tmp_path) -> None:
    app_mod._PREVIEW_CACHE.clear()
    session_file = tmp_path / "trimmed-preview.jsonl"
    long_output = "\n".join(f"line {idx}" for idx in range(1, 7))
    entries = [
        {"type": "message", "cwd": "/tmp/project"},
        {"type": "message", "message": {"role": "assistant", "content": long_output}},
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(_render_active_preview(str(session_file), preview_max_lines=3))

    assert "line 6" in rendered
    assert "line 1" not in rendered
    assert "(3 lines above, scroll to see more)" in rendered


def test_render_active_preview_omitted_hint_hidden_for_selected_subagent(tmp_path) -> None:
    app_mod._PREVIEW_CACHE.clear()
    session_file = tmp_path / "selected-subagent-preview.jsonl"
    long_output = "\n".join(f"line {idx}" for idx in range(1, 7))
    entries = [
        {"type": "message", "cwd": "/tmp/project"},
        {"type": "message", "message": {"role": "assistant", "content": long_output}},
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    rendered = str(
        _render_active_preview(
            str(session_file),
            subagent_rows=[{"id": "agent-a", "status": "done", "output": "subagent output"}],
            selected_subagent_index=0,
            selected_subagent_label="agent-a",
            selected_subagent_output="subagent output",
            preview_max_lines=3,
        )
    )

    assert "[Subagent 1/1: agent-a]" in rendered
    assert "subagent output" in rendered
    assert "(3 lines above, scroll to see more)" not in rendered

def test_update_preview_uses_preview_max_lines_setting(monkeypatch, tmp_path) -> None:
    app_mod._PREVIEW_CACHE.clear()
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    app._agents_view_settings["preview_max_lines"] = 3

    session = _active_session(session_id="active-preview-max", pane="%6")
    session_file = tmp_path / "active-preview-max.jsonl"
    long_output = "\n".join(f"line {idx}" for idx in range(1, 7))
    session_file.write_text(
        "\n".join(
            [
                json.dumps({"type": "message", "cwd": "/tmp/project"}),
                json.dumps(
                    {
                        "type": "message",
                        "message": {"role": "assistant", "content": long_output},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    session.resume_command = f"omp --session '{session_file}'"

    def fail_capture(_pane_id, lines=200):
        raise AssertionError("tmux capture should not be used for OMP JSONL previews")

    monkeypatch.setattr(app._tmux, "capture_pane", fail_capture)

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            app._update_preview()
            await asyncio.sleep(0)

            rendered = _preview_text(app)
            assert "line 6" in rendered
            assert "line 1" not in rendered
            assert "(3 lines above, scroll to see more)" in rendered

    asyncio.run(run())
def test_extract_last_user_messages_reads_tail_text_blocks(tmp_path) -> None:
    session_file = tmp_path / "inactive.jsonl"
    entries = [
        {"message": {"role": "assistant", "content": "ignore me"}},
        {
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "first user prompt"}],
            }
        },
        {"message": {"role": "user", "content": "second user prompt"}},
        {
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "third user prompt"}],
            }
        },
    ]
    session_file.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")

    last_two = _extract_last_user_messages(str(session_file), n=2)
    assert last_two == ["second user prompt", "third user prompt"]


def test_update_preview_inactive_shows_recent_user_messages(tmp_path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _inactive_session(session_id="inactive-with-history")
    session_file = tmp_path / "inactive-session.jsonl"
    session_file.write_text(
        "\n".join(
            [
                json.dumps({"message": {"role": "user", "content": "Need details on deployment"}}),
                json.dumps({"message": {"role": "assistant", "content": "Sure"}}),
                json.dumps({"message": {"role": "user", "content": "Also check rollback path"}}),
            ]
        ),
        encoding="utf-8",
    )
    session.resume_command = f"omp --session '{session_file}'"

    async def run() -> None:
        async with app.run_test():
            app._selected_session = session
            app._update_preview()
            await asyncio.sleep(0)

            rendered = _preview_text(app)
            assert "Status:" in rendered
            assert "[msg-1]" in rendered
            assert "Need details on deployment" in rendered
            assert "[msg-2]" in rendered
            assert "Also check rollback path" in rendered

    asyncio.run(run())


def test_session_log_screen_renders_types_and_search_highlights(tmp_path) -> None:
    session = _active_session(session_id="log-screen", pane="%9")
    session_file = tmp_path / "session-log.jsonl"
    session_file.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "user",
                            "content": [{"type": "text", "text": "User asks for session logs"}],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Assistant confirms log viewer is loading",
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "toolCall",
                                    "name": "bash",
                                    "arguments": {
                                        "command": "echo hello",
                                        "timeout": 30,
                                    },
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "message",
                        "message": {
                            "role": "toolResult",
                            "toolName": "bash",
                            "isError": False,
                            "content": [{"type": "text", "text": "ok"}],
                        },
                    }
                ),
                "{malformed json",
            ]
        ),
        encoding="utf-8",
    )

    screen = SessionLogScreen(session, str(session_file))
    tail_lines = _read_jsonl_tail_lines(str(session_file))[-200:]
    for line_no, raw in enumerate(tail_lines, start=1):
        payload = raw.strip()
        if not payload:
            screen._rows.append((line_no, "•", "#636e7b", "[blank line]"))
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            screen._rows.append(
                (line_no, "•", "#f85149", screen._truncate(f"[invalid JSON] {payload}"))
            )
            continue
        if not isinstance(parsed, dict):
            continue
        bullet, color, summary = screen._summarize_row(parsed)
        screen._rows.append((line_no, bullet, color, screen._truncate(summary)))

    rendered = "\n".join(summary for _, _, _, summary in screen._rows)
    assert "User asks for session logs" in rendered
    assert "Assistant confirms log viewer is loading" in rendered
    assert "bash" in rendered
    assert "ok" in rendered
    assert "invalid JSON" in rendered

    screen._search_term = "assistant"
    screen._sync_matches()
    assert screen._match_indices
    assert screen._match_cursor == 0


def test_action_view_session_log_binding_opens_screen(tmp_path) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session_file = tmp_path / "binding-session.jsonl"
    session_file.write_text(
        json.dumps(
            {
                "type": "message",
                "message": {"role": "assistant", "content": "Ready"},
            }
        ),
        encoding="utf-8",
    )
    session = _active_session(session_id="binding-log", pane="%10")
    session.resume_command = f"omp --session '{session_file}'"

    async def run() -> None:
        async with app.run_test() as pilot:
            app._sessions = [session]
            app._session_map = {session.session_id: session}
            app._ordered_keys = [session.session_id]
            app._selected_session = session
            app._update_table()
            app.query_one("#session-table").move_cursor(row=0)

            await pilot.press("l")
            await asyncio.sleep(0)

            assert isinstance(app.screen, SessionLogScreen)
            assert app.screen._log_path == str(session_file)

    asyncio.run(run())


def test_action_view_session_log_notifies_when_missing(monkeypatch) -> None:
    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    app._conversation_preview_mode = False
    session = _active_session(session_id="missing-log", pane="%11")
    session.resume_command = "omp --session '/tmp/does-not-exist.jsonl'"

    notices: list[str] = []
    monkeypatch.setattr(app, "_current_session", lambda: session)
    monkeypatch.setattr(
        app,
        "notify",
        lambda message, **kwargs: notices.append(str(message)),
    )

    app.action_view_session_log()

    assert notices == ["Log file not found"]
    assert _extract_session_file_path(session.resume_command) == "/tmp/does-not-exist.jsonl"
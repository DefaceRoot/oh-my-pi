"""session_export.py - Export sessions to Markdown and clipboard.

Provides:
- E: export current session to markdown file
- ctrl+e: copy selected session summary to clipboard
- ctrl+shift+e: export currently visible conversation
- action_export_sessions: export all sessions summary as markdown
"""

from __future__ import annotations

import importlib
import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any


def _safe_title_fragment(value: str, max_len: int = 40) -> str:
    raw = (value or "").strip()[:max_len]
    sanitized = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in raw)
    compact = re.sub(r"_+", "_", sanitized).strip("_")
    return compact or "session"


def _message_text_blocks(content: Any) -> list[str]:
    if isinstance(content, str):
        text = content.strip()
        return [text] if text else []

    if not isinstance(content, list):
        return []

    blocks: list[str] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = str(block.get("text", "")).strip()
        if text:
            blocks.append(text)
    return blocks


def _resolve_session_jsonl_path(session: Any) -> Path | None:
    candidates: list[Path] = []

    resume_command = str(getattr(session, "resume_command", "") or "")
    if resume_command:
        match = re.search(r"--session\s+'([^']+)'", resume_command)
        if not match:
            match = re.search(r'--session\s+"([^"]+)"', resume_command)
        if match:
            candidates.append(Path(match.group(1)).expanduser())

    session_file_path = getattr(session, "session_file_path", None)
    if isinstance(session_file_path, str) and session_file_path.strip():
        candidates.append(Path(session_file_path.strip()).expanduser())

    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except Exception:
            continue

    session_id = str(getattr(session, "session_id", "") or "").strip()
    if not session_id:
        return None

    sessions_root = Path("~/.omp/agent/sessions").expanduser()
    try:
        exact = next(
            (
                path
                for path in sessions_root.glob(f"**/*_{session_id}.jsonl")
                if path.is_file()
            ),
            None,
        )
        if exact is not None:
            return exact

        partial = next(
            (
                path
                for path in sessions_root.glob(f"**/*{session_id}*.jsonl")
                if path.is_file()
            ),
            None,
        )
        return partial
    except Exception:
        return None


def _render_tool_args(tool_name: str, raw_args: Any) -> tuple[str, str]:
    args = raw_args
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {"value": args}

    if not isinstance(args, dict):
        args = {}

    command = args.get("command")
    if isinstance(command, str) and command.strip():
        language = "bash" if tool_name.lower() in {"bash", "ssh"} else "text"
        return language, command.strip()

    script = args.get("script")
    if isinstance(script, str) and script.strip():
        return "javascript", script.strip()

    text = json.dumps(args, indent=2, ensure_ascii=False)
    return "json", text


def _render_tool_result(block: dict[str, Any]) -> str:
    content = block.get("content")
    if isinstance(content, str):
        stripped = content.strip()
        return stripped or "[no output]"

    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                item_type = str(item.get("type") or "")
                if item_type == "text":
                    text = str(item.get("text", "")).strip()
                    if text:
                        text_parts.append(text)
                    continue
                text_parts.append(json.dumps(item, ensure_ascii=False))
            elif isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    text_parts.append(stripped)

        if text_parts:
            return "\n\n".join(text_parts)

    serialized = json.dumps(block, ensure_ascii=False)
    return serialized if serialized else "[no output]"


def _conversation_markdown_lines(jsonl_path: Path) -> list[str]:
    lines: list[str] = []
    pending_tool_names: dict[str, str] = {}

    try:
        with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                payload = raw.strip()
                if not payload:
                    continue

                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                if not isinstance(obj, dict):
                    continue

                message = obj.get("message")
                if not isinstance(message, dict):
                    continue

                role = str(message.get("role") or "")
                content = message.get("content")

                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict):
                            continue

                        block_type = str(block.get("type") or "")

                        if role == "assistant" and block_type in {"tool_use", "toolCall"}:
                            tool_name = str(block.get("name") or "tool").strip() or "tool"
                            tool_args = (
                                block.get("input", {})
                                if block_type == "tool_use"
                                else block.get("arguments", {})
                            )
                            language, body = _render_tool_args(tool_name, tool_args)
                            lines.append(f"### Tool: {tool_name}")
                            lines.append(f"```{language}")
                            lines.append(body)
                            lines.append("```")
                            lines.append("")

                            tool_id = str(block.get("id") or "").strip()
                            if tool_id:
                                pending_tool_names[tool_id] = tool_name
                            continue

                        if block_type in {"tool_result", "toolResult"}:
                            tool_id = str(
                                block.get("tool_use_id")
                                or block.get("toolUseId")
                                or block.get("tool_call_id")
                                or ""
                            ).strip()
                            tool_name = pending_tool_names.get(tool_id, "")
                            if tool_name:
                                lines.append(f"**Result ({tool_name}):**")
                            else:
                                lines.append("**Result:**")
                            lines.append("```")
                            lines.append(_render_tool_result(block))
                            lines.append("```")
                            lines.append("")

                if role not in {"user", "assistant"}:
                    continue

                text_blocks = _message_text_blocks(content)
                for text in text_blocks:
                    heading = "User" if role == "user" else "Assistant"
                    lines.append(f"### {heading}")
                    lines.append(text)
                    lines.append("")
    except OSError:
        return []

    while lines and not lines[-1]:
        lines.pop()
    return lines


def _last_user_message(jsonl_path: Path) -> str:
    latest = ""
    try:
        with jsonl_path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                payload = raw.strip()
                if not payload:
                    continue
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                if not isinstance(obj, dict):
                    continue

                message = obj.get("message")
                if not isinstance(message, dict) or str(message.get("role") or "") != "user":
                    continue

                for text in _message_text_blocks(message.get("content")):
                    stripped = text.strip()
                    if stripped:
                        latest = stripped
    except OSError:
        return ""

    return latest[-200:]


def session_to_markdown(session: Any, jsonl_path: Path | None = None) -> str:
    """Convert a session and its JSONL log to Markdown format."""
    lines: list[str] = []
    lines.append(f"# Session: {getattr(session, 'title', '') or getattr(session, 'session_id', 'Unknown')}")
    lines.append("")

    session_start_ts = getattr(session, "session_start_ts", None)
    if session_start_ts:
        try:
            date_label = datetime.fromtimestamp(float(session_start_ts)).strftime("%Y-%m-%d %H:%M")
        except (TypeError, ValueError, OSError):
            date_label = "Unknown"
    else:
        date_label = "Unknown"

    lines.append(f"**Date:** {date_label}")
    lines.append(f"**Branch:** {getattr(session, 'branch', '') or 'unknown'}")
    lines.append(f"**Model:** {getattr(session, 'model', '') or 'unknown'}")
    lines.append(f"**Total Cost:** ${float(getattr(session, 'cost_usd', 0.0) or 0.0):.4f}")

    tokens_in = int(getattr(session, "total_tokens_in", 0) or 0)
    tokens_out = int(getattr(session, "total_tokens_out", 0) or 0)
    lines.append(f"**Total Tokens:** {tokens_in + tokens_out:,}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Conversation")
    lines.append("")

    if jsonl_path and jsonl_path.exists():
        conversation_lines = _conversation_markdown_lines(jsonl_path)
        if conversation_lines:
            lines.extend(conversation_lines)
        else:
            lines.append("_No conversation messages found in log._")
    else:
        lines.append("_Session log not found. Export includes metadata only._")

    return "\n".join(lines).rstrip() + "\n"


def get_export_dir() -> Path:
    """Get an export directory, preferring ~/Downloads when writable."""
    downloads = Path.home() / "Downloads"
    if downloads.exists() and os.access(downloads, os.W_OK):
        return downloads

    export_dir = Path.home() / ".omp" / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    if os.access(export_dir, os.W_OK):
        return export_dir

    raise OSError("No writable export directory available")


def _copy_to_clipboard(text: str) -> bool:
    payload = text.encode()
    for cmd in (
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
    ):
        try:
            proc = subprocess.run(
                cmd,
                input=payload,
                capture_output=True,
                timeout=3,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
        except Exception:
            continue

        if proc.returncode == 0:
            return True

    return False


def _selected_session(app: Any) -> Any | None:
    current = getattr(app, "_current_session", None)
    if callable(current):
        try:
            session = current()
            if session is not None:
                return session
        except Exception:
            pass

    selected = getattr(app, "_selected_session", None)
    if selected is not None:
        return selected

    sessions = getattr(app, "_sessions", [])
    try:
        table = app.query_one("#session-table")
        row = int(getattr(table, "cursor_row", -1))
        if 0 <= row < len(sessions):
            return sessions[row]
    except Exception:
        pass

    return None


def _save_markdown_file(prefix: str, markdown: str) -> Path:
    export_dir = get_export_dir()
    filename = f"{prefix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"
    path = export_dir / filename
    path.write_text(markdown, encoding="utf-8")
    return path


def _all_sessions_summary_markdown(sessions: list[Any]) -> str:
    now_label = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        "# Sessions Summary",
        "",
        f"**Generated:** {now_label}",
        f"**Count:** {len(sessions)}",
        "",
        "| Session | Status | Cost | Tokens | Duration |",
        "|---|---|---:|---:|---|",
    ]

    total_cost = 0.0
    total_tokens = 0

    for session in sessions:
        title = str(
            getattr(session, "display_title", "")
            or getattr(session, "title", "")
            or getattr(session, "session_id", "")
        )
        status = str(getattr(session, "status", "") or "unknown")
        cost = float(getattr(session, "cost_usd", 0.0) or 0.0)
        tokens = int(getattr(session, "total_tokens_in", 0) or 0) + int(
            getattr(session, "total_tokens_out", 0) or 0
        )
        duration = str(
            getattr(session, "duration_str", "")
            or getattr(session, "elapsed_str", "")
            or "—"
        )

        total_cost += cost
        total_tokens += tokens

        clean_title = title.replace("|", "\\|").strip()[:80] or "(untitled)"
        clean_status = status.replace("|", "\\|")
        lines.append(
            f"| {clean_title} | {clean_status} | ${cost:.4f} | {tokens:,} | {duration} |"
        )

    lines.extend(
        [
            "",
            "## Totals",
            f"- Total cost: ${total_cost:.4f}",
            f"- Total tokens: {total_tokens:,}",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def _patch_app() -> None:
    try:
        from textual.binding import Binding
        from textual.widgets import Static

        app_mod = importlib.import_module("agents_view.app")
        AgentsViewApp = getattr(app_mod, "AgentsViewApp", None)
        HelpScreen = getattr(app_mod, "HelpScreen", None)
        if AgentsViewApp is None or HelpScreen is None:
            return
    except Exception:
        return

    if getattr(AgentsViewApp, "_session_export_feature_patched", False):
        return

    def _action_export_session(self: Any) -> None:
        session = _selected_session(self)
        if session is None:
            self.notify("No session selected", severity="warning")
            return

        jsonl_path = _resolve_session_jsonl_path(session)
        markdown = session_to_markdown(session, jsonl_path)
        safe_title = _safe_title_fragment(str(getattr(session, "title", "") or "session"))

        try:
            export_path = _save_markdown_file(safe_title, markdown)
        except OSError as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return
        except Exception as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return

        self.notify(f"Exported to {export_path}", severity="information")

    def _action_copy_session_summary(self: Any) -> None:
        session = _selected_session(self)
        if session is None:
            self.notify("No session selected", severity="warning")
            return

        jsonl_path = _resolve_session_jsonl_path(session)
        last_message = _last_user_message(jsonl_path) if jsonl_path else ""
        if not last_message:
            last_message = "(no user message found)"

        summary = "\n".join(
            [
                f"Session: {getattr(session, 'display_title', '') or getattr(session, 'title', '')}",
                f"Status: {getattr(session, 'status', 'unknown')} | Branch: {getattr(session, 'branch', '') or 'unknown'} | Cost: ${float(getattr(session, 'cost_usd', 0.0) or 0.0):.2f}",
                f"Last message: {last_message[-200:]}",
            ]
        )

        if _copy_to_clipboard(summary):
            self.notify("Copied session summary", severity="information")
            return

        self.notify("Clipboard unavailable; summary not copied", severity="warning")

    def _action_export_visible_conversation(self: Any) -> None:
        session = _selected_session(self)
        if session is None:
            self.notify("No session selected", severity="warning")
            return

        preview_text = ""
        try:
            preview_widget = self.query_one("#preview-content", Static)
            renderable = getattr(preview_widget, "renderable", None)
            if renderable is not None and hasattr(renderable, "plain"):
                preview_text = str(getattr(renderable, "plain", "")).strip()
            elif renderable is not None:
                preview_text = str(renderable).strip()
        except Exception:
            preview_text = ""

        jsonl_path = _resolve_session_jsonl_path(session)
        fallback_lines = _conversation_markdown_lines(jsonl_path) if jsonl_path else []

        lines = [
            f"# Visible Conversation: {getattr(session, 'title', '') or getattr(session, 'session_id', 'Session')}",
            "",
            f"**Exported:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "",
            "## Conversation",
            "",
        ]

        if preview_text:
            lines.append("```text")
            lines.append(preview_text)
            lines.append("```")
        elif fallback_lines:
            lines.extend(fallback_lines)
        else:
            lines.append("_No visible conversation to export._")

        safe_title = _safe_title_fragment(str(getattr(session, "title", "") or "session"))
        markdown = "\n".join(lines).rstrip() + "\n"

        try:
            export_path = _save_markdown_file(f"{safe_title}-visible", markdown)
        except OSError as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return
        except Exception as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return

        self.notify(f"Exported conversation to {export_path}", severity="information")

    def _action_export_all_sessions_summary(self: Any) -> None:
        sessions = list(getattr(self, "_sessions", []) or [])
        if not sessions:
            self.notify("No sessions to export", severity="warning")
            return

        markdown = _all_sessions_summary_markdown(sessions)
        try:
            export_path = _save_markdown_file("sessions-summary", markdown)
        except OSError as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return
        except Exception as exc:
            self.notify(f"Export failed: {exc}", severity="error")
            return

        self.notify(f"Exported all sessions summary to {export_path}", severity="information")

    AgentsViewApp.action_export_session = _action_export_session
    AgentsViewApp.action_copy_session_summary = _action_copy_session_summary
    AgentsViewApp.action_export_visible_conversation = _action_export_visible_conversation
    AgentsViewApp.action_export_all_sessions_summary = _action_export_all_sessions_summary
    AgentsViewApp.action_export_sessions = _action_export_all_sessions_summary

    rewritten_bindings = [
        binding
        for binding in list(AgentsViewApp.BINDINGS)
        if getattr(binding, "key", "") not in {"E", "ctrl+e", "ctrl+shift+e"}
    ]
    rewritten_bindings.extend(
        [
            Binding("E", "export_session", "Export session"),
            Binding("ctrl+e", "copy_session_summary", "Copy summary"),
            Binding(
                "ctrl+shift+e",
                "export_visible_conversation",
                "Export visible conversation",
                show=False,
            ),
        ]
    )
    AgentsViewApp.BINDINGS = rewritten_bindings

    help_rows = [
        row
        for row in list(HelpScreen._BINDINGS_TABLE)
        if row != ("App", "Ctrl+E", "Export sessions")
    ]
    HelpScreen._BINDINGS_TABLE = help_rows

    for entry in (
        ("Session", "E", "Export to Markdown"),
        ("Session", "Ctrl+E", "Copy session summary"),
        ("Session", "Ctrl+Shift+E", "Export visible conversation"),
    ):
        if entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(entry)

    AgentsViewApp._session_export_feature_patched = True


_patch_app()

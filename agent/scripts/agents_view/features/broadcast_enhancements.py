"""broadcast_enhancements.py - Enhanced broadcast with tag/status/role filtering."""

from __future__ import annotations

import time
import re
from collections import deque
from datetime import datetime
from typing import TYPE_CHECKING, Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Button, DataTable, Static

if TYPE_CHECKING:
    from agents_view.model import AgentSession


_broadcast_history: deque[dict[str, object]] = deque(maxlen=20)

_TAG_BROADCAST_RE = re.compile(r"^#(\w+)\s+broadcast:\s*(.+)$", re.IGNORECASE)
_STATUS_BROADCAST_RE = re.compile(
    r"^@(stalled|running|idle|asking|review):\s*(.+)$",
    re.IGNORECASE,
)
_ROLE_BROADCAST_RE = re.compile(r"^@(orchestrators?|workers?|agents?):\s*(.+)$", re.IGNORECASE)

_PREVIEW_MESSAGE_MAX = 220


class BroadcastPreviewScreen(Screen[bool]):
    """Preview recipients before sending a directive broadcast."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("q", "cancel", "Cancel", show=False),
        Binding("enter", "confirm", "Confirm", show=False),
    ]

    CSS = """
    BroadcastPreviewScreen {
        align: center middle;
        background: #22272e80;
    }

    #broadcast-preview-dialog {
        width: 96;
        max-width: 95vw;
        height: auto;
        max-height: 85vh;
        border: round #316dca;
        background: #22272e;
        padding: 1;
    }

    #broadcast-preview-meta {
        color: #adbac7;
        margin-bottom: 1;
    }

    #broadcast-preview-table {
        height: 16;
        max-height: 45vh;
    }

    #broadcast-preview-actions {
        height: auto;
        margin-top: 1;
        align-horizontal: right;
    }

    #broadcast-preview-actions Button {
        margin-left: 1;
    }
    """

    def __init__(self, directive_text: str, message: str, recipients: list[AgentSession]) -> None:
        super().__init__()
        self._directive_text = directive_text
        self._message = message
        self._recipients = recipients

    def compose(self) -> ComposeResult:
        with Vertical(id="broadcast-preview-dialog"):
            yield Static("Broadcast preview", classes="spawn-label")
            yield Static(id="broadcast-preview-meta")
            yield DataTable(id="broadcast-preview-table", cursor_type="row", show_cursor=True)
            with Horizontal(id="broadcast-preview-actions"):
                yield Button("Cancel", id="broadcast-preview-cancel")
                yield Button("Confirm", id="broadcast-preview-confirm", variant="primary")

    def on_mount(self) -> None:
        meta = self.query_one("#broadcast-preview-meta", Static)
        table = self.query_one("#broadcast-preview-table", DataTable)

        table.add_columns("Session", "Status", "Role", "Tags")
        for session in self._recipients:
            table.add_row(
                _session_title(session),
                str(getattr(session, "status", "") or "unknown"),
                _session_role_label(session),
                _session_tags_label(session),
            )
        if self._recipients:
            table.focus()

        directive_preview = _truncate(self._directive_text, 120)
        message_preview = _truncate(self._message, _PREVIEW_MESSAGE_MAX)
        meta.update(
            f"Targets: {len(self._recipients)} session(s)\n"
            f"Directive: {directive_preview}\n"
            f"Message: {message_preview}"
        )

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = str(getattr(event.button, "id", ""))
        if button_id == "broadcast-preview-confirm":
            self.dismiss(True)
        elif button_id == "broadcast-preview-cancel":
            self.dismiss(False)


class BroadcastHistoryScreen(Screen[None]):
    """Show recent directive broadcasts from the in-memory circular history."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("q", "dismiss", "Close", show=False),
    ]

    CSS = """
    BroadcastHistoryScreen {
        background: #22272e;
    }

    #broadcast-history-title {
        height: auto;
        padding: 1 2;
        color: #adbac7;
        background: #1c2128;
        border: round #30363d;
        margin: 0 1;
    }

    #broadcast-history-table {
        height: 1fr;
        background: #22272e;
    }
    """

    def __init__(self, entries: list[dict[str, object]]) -> None:
        super().__init__()
        self._entries = entries

    def compose(self) -> ComposeResult:
        yield Static("Broadcast history (last 20)", id="broadcast-history-title")
        yield DataTable(id="broadcast-history-table", cursor_type="row", show_cursor=True)

    def on_mount(self) -> None:
        table = self.query_one("#broadcast-history-table", DataTable)
        table.add_column("Recent broadcasts", key="entry")

        if not self._entries:
            table.add_row(Text("(no broadcast history yet)", style="#636e7b"))
            return

        for entry in reversed(self._entries):
            timestamp = _format_ts(entry.get("ts"))
            count_raw = entry.get("count", 0)
            if isinstance(count_raw, bool):
                count = int(count_raw)
            elif isinstance(count_raw, (int, float)):
                count = int(count_raw)
            elif isinstance(count_raw, str):
                try:
                    count = int(float(count_raw.strip() or "0"))
                except ValueError:
                    count = 0
            else:
                count = 0
            directive = str(entry.get("directive", "")).strip()
            rendered = f"[{timestamp}] -> {count} sessions | {directive}".strip()
            table.add_row(Text(_truncate(rendered, 220), style="#adbac7"))

    def action_dismiss(self) -> None:
        self.dismiss(None)


def parse_broadcast_directive(text: str) -> dict[str, str] | None:
    """Parse special broadcast directives from input text."""
    raw = text.strip()
    if not raw:
        return None

    tag_match = _TAG_BROADCAST_RE.match(raw)
    if tag_match:
        return {
            "type": "tag",
            "target": tag_match.group(1).strip().lower(),
            "message": tag_match.group(2).strip(),
        }

    status_match = _STATUS_BROADCAST_RE.match(raw)
    if status_match:
        return {
            "type": "status",
            "target": status_match.group(1).strip().lower(),
            "message": status_match.group(2).strip(),
        }

    role_match = _ROLE_BROADCAST_RE.match(raw)
    if role_match:
        role_target = role_match.group(1).strip().lower()
        normalized_role = "orchestrator" if role_target.startswith("orchestrator") else "worker"
        return {
            "type": "role",
            "target": normalized_role,
            "message": role_match.group(2).strip(),
        }

    return None


def filter_sessions_for_broadcast(sessions: list[AgentSession], directive: dict[str, str]) -> list[AgentSession]:
    """Filter sessions based on broadcast directive type."""
    directive_type = directive.get("type", "").lower()
    target = directive.get("target", "").lower()

    filtered: list[AgentSession] = []
    for session in sessions:
        pane_id = str(getattr(session, "tmux_pane", "") or "").strip()
        if not pane_id:
            continue

        if directive_type == "tag":
            tags = getattr(session, "tags", [])
            if not isinstance(tags, list):
                continue
            normalized_tags = {str(tag).strip().lower() for tag in tags if str(tag).strip()}
            if target in normalized_tags:
                filtered.append(session)
            continue

        if directive_type == "status":
            status = str(getattr(session, "status", "") or "").strip().lower()
            state = str(getattr(session, "state", "") or "").strip().lower()
            if target == "running":
                if state == "active" and status not in {"idle", "offline", "stalled"}:
                    filtered.append(session)
            elif status == target:
                filtered.append(session)
            continue

        if directive_type == "role":
            role = str(getattr(session, "role", "") or "").strip().lower()
            if target == "orchestrator" and role == "orchestrator":
                filtered.append(session)
            if target == "worker" and role in {"", "default", "worker", "agent"}:
                filtered.append(session)

    return filtered


def _truncate(text: str, max_len: int) -> str:
    clean = text.strip()
    if len(clean) <= max_len:
        return clean
    return f"{clean[: max_len - 1]}…"


def _session_title(session: AgentSession) -> str:
    title = str(getattr(session, "display_title", "") or "").strip()
    if not title:
        title = str(getattr(session, "title", "") or "").strip()
    if not title:
        title = str(getattr(session, "session_id", "session"))[:12]
    return _truncate(title, 44)


def _session_role_label(session: AgentSession) -> str:
    role = str(getattr(session, "role", "") or "").strip().lower()
    if role == "orchestrator":
        return "orchestrator"
    if role in {"default", "worker", "agent"}:
        return "worker"
    return "worker"


def _session_tags_label(session: AgentSession) -> str:
    tags = getattr(session, "tags", [])
    if not isinstance(tags, list) or not tags:
        return "-"
    normalized = [f"#{str(tag).strip()}" for tag in tags if str(tag).strip()]
    if not normalized:
        return "-"
    return _truncate(", ".join(normalized), 40)


def _format_ts(value: object) -> str:
    if isinstance(value, bool):
        ts = float(int(value))
    elif isinstance(value, (int, float)):
        ts = float(value)
    elif isinstance(value, str):
        try:
            ts = float(value.strip() or "0")
        except ValueError:
            ts = time.time()
    else:
        ts = time.time()
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def _record_broadcast(directive_text: str, recipient_count: int) -> None:
    _broadcast_history.append(
        {
            "ts": time.time(),
            "directive": directive_text.strip(),
            "count": int(recipient_count),
        }
    )


def _build_confirmation_message(directive: dict[str, str], recipient_count: int) -> str:
    directive_type = directive.get("type", "")
    target = directive.get("target", "")

    if directive_type == "tag":
        return f"Broadcasting to {recipient_count} sessions tagged #{target}..."
    if directive_type == "status":
        return f"Broadcasting to {recipient_count} {target} session(s)..."
    if directive_type == "role":
        label = "orchestrator" if target == "orchestrator" else "worker"
        return f"Broadcasting to {recipient_count} {label} session(s)..."
    return f"Broadcasting to {recipient_count} sessions..."


def _patch_app() -> None:
    try:
        from agents_view import actions
        from agents_view.app import AgentsViewApp, HelpScreen
        from textual.widgets import Input
    except Exception:
        return

    if getattr(AgentsViewApp, "_broadcast_enhancements_feature_patched", False):
        return

    original_on_input_submitted = getattr(AgentsViewApp, "on_input_submitted", None)

    def _action_broadcast_history(self: Any) -> None:
        self.push_screen(BroadcastHistoryScreen(list(_broadcast_history)))

    def _enhanced_on_input_submitted(self: Any, event: Any) -> None:
        if getattr(event.input, "id", "") != "session-input":
            if callable(original_on_input_submitted):
                original_on_input_submitted(self, event)
            return

        raw_text = str(getattr(event, "value", "") or "").strip()
        directive = parse_broadcast_directive(raw_text)
        if directive is None:
            if callable(original_on_input_submitted):
                original_on_input_submitted(self, event)
            return

        message = directive.get("message", "").strip()
        if not message:
            self.notify("Broadcast message is empty", severity="warning")
            return

        sessions = list(getattr(self, "_sessions", []))
        recipients = filter_sessions_for_broadcast(sessions, directive)
        if not recipients:
            self.notify("No matching sessions for broadcast directive", severity="warning")
            try:
                event.input.clear()
            except Exception:
                pass
            return

        self.notify(_build_confirmation_message(directive, len(recipients)), severity="information")

        def _after_preview(confirmed: bool | None) -> None:
            if not confirmed:
                self.notify("Broadcast cancelled", severity="information")
                return

            sent_to = actions.broadcast_input(self._tmux, recipients, message)
            _record_broadcast(raw_text, len(recipients))
            self.notify(f"Broadcast sent to {len(sent_to)}/{len(recipients)} sessions")
            try:
                input_widget = self.query_one("#session-input", Input)
                input_widget.clear()
            except Exception:
                pass

        self.push_screen(BroadcastPreviewScreen(raw_text, message, recipients), callback=_after_preview)

        stop = getattr(event, "stop", None)
        prevent_default = getattr(event, "prevent_default", None)
        if callable(stop):
            stop()
        if callable(prevent_default):
            prevent_default()

    AgentsViewApp.action_broadcast_history = _action_broadcast_history  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.on_input_submitted = _enhanced_on_input_submitted  # type: ignore[method-assign]

    existing_actions = {str(getattr(binding, "action", "")) for binding in list(AgentsViewApp.BINDINGS)}
    existing_keys = {str(getattr(binding, "key", "")) for binding in list(AgentsViewApp.BINDINGS)}

    if "B" not in existing_keys:
        key = "B"
    elif "b" not in existing_keys:
        key = "b"
    else:
        key = "ctrl+shift+b"
    if "broadcast_history" not in existing_actions:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding(key, "broadcast_history", "Broadcast history", show=False)
        ]

    help_row = ("Broadcast", key, "Broadcast history")
    if help_row not in HelpScreen._BINDINGS_TABLE:
        HelpScreen._BINDINGS_TABLE.append(help_row)

    AgentsViewApp._broadcast_enhancements_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

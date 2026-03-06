"""task_list_panel.py - Persistent todo task panel above the preview pane."""

from __future__ import annotations

import inspect
import re
from pathlib import Path
from typing import Any, Optional

from rich.text import Text

_STATUS_MAP = {
    "✓": "done",
    "→": "in_progress",
    "○": "pending",
    "✗": "abandoned",
    "▶": "in_progress",
}

_STATUS_ICONS = {
    "done": ("✓", "#57ab5a"),
    "in_progress": ("▶", "#f0883e"),
    "pending": ("○", "#636e7b"),
    "abandoned": ("✗", "#6e7681"),
}

_RUNNING_CHILD_STATUSES = {"run", "running", "busy", "active", "asking", "review"}

_ROLE_LABELS = {
    "default": "DEF",
    "orchestrator": "ORCH",
    "explore": "EXPL",
    "task": "TASK",
    "lint": "LINT",
    "designer": "DSGN",
    "verifier": "VRFY",
    "merge": "MRGE",
    "research": "RSCH",
    "reviewer": "REVW",
    "plan": "PLAN",
}



def _parse_todo_text(text: str) -> tuple[str, list[dict[str, str]]]:
    """Parse todo board text into a header line and structured tasks."""
    tasks: list[dict[str, str]] = []
    header = ""

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        if not header and ("phase" in stripped.lower() or "complete" in stripped.lower()):
            header = stripped
            continue

        marker_match = re.match(r"^[\-\s]*([✓→○✗▶])\s+(.*)$", stripped)
        if not marker_match:
            continue

        marker, payload = marker_match.groups()
        status = _STATUS_MAP.get(marker)
        if status is None:
            continue

        payload = payload.strip()
        if not payload:
            continue

        task_id = ""
        content = payload
        task_match = re.match(r"(task-\d+|task\d+)\s+(.*)", payload, re.IGNORECASE)
        if task_match:
            task_id = task_match.group(1)
            content = task_match.group(2).strip()

        tasks.append({"id": task_id, "content": content, "status": status})

    return header, tasks



def _to_context_pct(child: Any) -> float:
    raw = (
        getattr(child, "context_usage_pct", None)
        or getattr(child, "context_pct", None)
        or getattr(child, "ctx_pct", None)
        or 0
    )
    try:
        pct = float(raw)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(100.0, pct))


def _format_tokens(n: int) -> str:
    """Format a token count as a compact human-readable string."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "0"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)



def _render_task_list(
    session: Any,
    todo_text: str,
    child_sessions: list[Any],
    width: int = 80,
) -> Text:
    result = Text()

    title = str(getattr(session, "title", None) or getattr(session, "name", None) or "Session")
    title_limit = max(10, width - 10)
    if len(title) > title_limit:
        title = title[: title_limit - 1] + "…"

    result.append(" TASKS ", style="bold white on #1e3a5f")
    result.append(f" {title}\n", style="bold #adbac7")

    if not todo_text.strip():
        result.append("  (no active task list)\n", style="dim #636e7b")
        return result

    header, tasks = _parse_todo_text(todo_text)
    if header:
        result.append(f"  {header}\n", style="dim #8b949e")

    for task in tasks:
        status = task.get("status", "pending")
        icon, color = _STATUS_ICONS.get(status, ("?", "#8b949e"))
        is_active = status == "in_progress"
        style = f"bold {color}" if is_active else f"dim {color}"

        task_id = task.get("id", "")
        content = task.get("content", "")
        max_content = max(18, width - 12)
        if len(content) > max_content:
            content = content[: max_content - 1] + "…"

        result.append(f"  {icon}  ", style=style)
        if task_id:
            result.append(f"{task_id}  ", style=f"dim {color}")
        result.append(f"{content}\n", style=style)

        if not is_active or not child_sessions:
            continue

        for child in child_sessions:
            child_status = str(getattr(child, "status", "") or "").strip().lower()
            child_state = str(getattr(child, "state", "") or "").strip().lower()
            if child_status and child_status not in _RUNNING_CHILD_STATUSES and child_state != "active":
                continue

            raw_role = str(getattr(child, "role", "") or "").lower()
            child_role = _ROLE_LABELS.get(raw_role, raw_role.upper()[:3] or "SUB")
            child_title = str(
                getattr(child, "title", "")
                or getattr(child, "name", "")
                or "(subagent)"
            )
            title_max = max(12, width - 50)
            if len(child_title) > title_max:
                child_title = child_title[: title_max - 1] + "…"

            child_status_text = str(getattr(child, "status", "") or "").strip().lower()

            tokens_in = 0
            tokens_out = 0
            try:
                tokens_in = int(getattr(child, "total_tokens_in", 0) or 0)
            except (TypeError, ValueError):
                pass
            try:
                tokens_out = int(getattr(child, "total_tokens_out", 0) or 0)
            except (TypeError, ValueError):
                pass

            ctx_float = _to_context_pct(child)
            bar_filled = int(round(ctx_float / 10.0))
            bar_filled = max(0, min(10, bar_filled))
            bar = "█" * bar_filled + "░" * (10 - bar_filled)
            if ctx_float > 80:
                ctx_color = "#f85149"
            elif ctx_float > 50:
                ctx_color = "#d29922"
            else:
                ctx_color = "#539bf5"

            result.append("     └─ ", style="dim #539bf5")
            result.append(f"{child_role:<4} ", style="bold #539bf5")
            result.append(f"{child_title}  ", style="#adbac7")
            if child_status_text:
                result.append(f"{child_status_text} ", style="dim #8b949e")
            tok_label = f"{_format_tokens(tokens_in)}↑ {_format_tokens(tokens_out)}↓"
            result.append(f"{tok_label} ", style="dim #adbac7")
            result.append(bar, style=ctx_color)
            result.append(f" {ctx_float:.0f}%\n", style=f"dim {ctx_color}")

    return result



def _mount_task_panel(app: Any) -> None:
    """Mount the task panel as first child of #right-panel."""
    from textual.containers import ScrollableContainer
    from textual.widgets import Static

    if bool(getattr(app, "_task_panel_mounted", False)):
        return

    try:
        right_panel = app.query_one("#right-panel")
    except Exception:
        return

    panel = ScrollableContainer(
        Static("", id="task-list-content", markup=False),
        id="task-list-panel",
    )

    children = list(right_panel.children)
    try:
        if children:
            right_panel.mount(panel, before=children[0])
        else:
            right_panel.mount(panel)
        app._task_panel_mounted = True
    except Exception:
        return



def _session_jsonl_path(session: Any, find_jsonl_fn: Any) -> Optional[Path]:
    if find_jsonl_fn is not None:
        try:
            resolved = find_jsonl_fn(session)
            if isinstance(resolved, Path):
                return resolved
        except Exception:
            pass

    raw = (
        getattr(session, "session_file_path", None)
        or getattr(session, "log_path", None)
        or getattr(session, "jsonl_path", None)
        or getattr(session, "path", None)
    )
    if raw:
        candidate = Path(str(raw)).expanduser()
        if candidate.exists() and candidate.is_file():
            return candidate

    return None



def _collect_child_sessions(app: Any, parent_session_id: str) -> list[Any]:
    if not parent_session_id:
        return []

    sessions = getattr(app, "_agent_sessions", None)
    if not isinstance(sessions, list):
        sessions = getattr(app, "_sessions", None)
    if not isinstance(sessions, list):
        return []

    children: list[Any] = []
    for child in sessions:
        parent_id = str(getattr(child, "parent_session_id", "") or "").strip()
        if parent_id != parent_session_id:
            continue
        children.append(child)

    return children



def _update_task_panel(app: Any, session: Any, extract_fn: Any, find_jsonl_fn: Any) -> None:
    try:
        content_widget = app.query_one("#task-list-content")
    except Exception:
        return

    todo_text = ""
    jsonl_path = _session_jsonl_path(session, find_jsonl_fn)
    if jsonl_path and jsonl_path.exists():
        try:
            todo_text = str(extract_fn(jsonl_path) or "")
        except Exception:
            todo_text = ""

    session_id = str(getattr(session, "session_id", "") or getattr(session, "id", "") or "").strip()
    child_sessions = _collect_child_sessions(app, session_id)

    width = 60
    try:
        panel = app.query_one("#task-list-panel")
        panel_width = int(getattr(panel.size, "width", 60) or 60)
        if panel_width > 8:
            width = panel_width - 2
    except Exception:
        pass

    rendered = _render_task_list(session, todo_text, child_sessions, width=width)
    try:
        app.call_from_thread(content_widget.update, rendered)
    except RuntimeError:
        content_widget.update(rendered)



def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    if bool(getattr(AgentsViewApp, "_task_list_panel_feature_patched", False)):
        return

    try:
        from agents_view.features.conversation_preview import (
            _extract_latest_todo_state,
            _get_session_jsonl_path,
        )

        find_jsonl_fn = _get_session_jsonl_path
    except Exception:
        try:
            from agents_view.features.conversation_preview import _extract_latest_todo_state

            find_jsonl_fn = None
        except Exception:
            return

    original_init = getattr(AgentsViewApp, "__init__", None)
    original_on_mount = getattr(AgentsViewApp, "on_mount", None)
    original_schedule = getattr(AgentsViewApp, "_schedule_preview_update", None)
    if not callable(original_init):
        return

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        self._task_panel_mounted = False

    async def _patched_on_mount(self: Any) -> None:
        if callable(original_on_mount):
            mount_result = original_on_mount(self)
            if inspect.isawaitable(mount_result):
                await mount_result
        _mount_task_panel(self)
        selected = getattr(self, "_selected_session", None)
        if selected is not None:
            _update_task_panel(self, selected, _extract_latest_todo_state, find_jsonl_fn)

    def _patched_schedule(self: Any, session: Any) -> None:
        if callable(original_schedule):
            original_schedule(self, session)
        if session is None:
            return
        try:
            _update_task_panel(self, session, _extract_latest_todo_state, find_jsonl_fn)
        except Exception:
            pass

    task_panel_css = """
#task-list-panel {
    height: 12;
    max-height: 16;
    min-height: 5;
    border-bottom: solid #316dca;
    background: #1c2128;
    overflow-y: auto;
    overflow-x: hidden;
}
#task-list-content {
    padding: 0 1;
}
"""

    existing_css = str(getattr(AgentsViewApp, "CSS", "") or "")
    if "#task-list-panel" not in existing_css:
        AgentsViewApp.CSS = existing_css + "\n" + task_panel_css

    AgentsViewApp.__init__ = _patched_init  # type: ignore[method-assign]
    if callable(original_on_mount):
        AgentsViewApp.on_mount = _patched_on_mount  # type: ignore[method-assign]
    if callable(original_schedule):
        AgentsViewApp._schedule_preview_update = _patched_schedule  # type: ignore[method-assign]

    AgentsViewApp._task_list_panel_feature_patched = True


_patch_app()

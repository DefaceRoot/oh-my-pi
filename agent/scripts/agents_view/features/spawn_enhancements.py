from __future__ import annotations

import os
import shlex
import subprocess
from typing import Any, Iterable

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Input, Select, Static

from agents_view import actions

_HARNESS_OPTIONS: list[tuple[str, str]] = [
    ("omp (Oh My Pi — default)", "omp"),
    ("claude (Claude Code direct)", "claude"),
    ("codex (OpenAI Codex)", "codex"),
    ("opencode (OpenCode)", "opencode"),
]

_ROLE_OPTIONS: list[tuple[str, str]] = [
    ("default (standard agent)", "default"),
    ("orchestrator (coordinates subagents)", "orchestrator"),
]

_TEMPLATE_PROMPTS = [
    "Implement feature: ",
    "Fix bug: ",
    "Write tests for: ",
    "Review code: ",
    "Refactor: ",
]


class EnhancedSpawnScreen(Screen):
    """Enhanced new agent session dialog with discovery helpers."""

    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("ctrl+t", "toggle_templates", "Templates"),
    ]

    CSS = """
    EnhancedSpawnScreen {
        align: center middle;
        background: #22272e80;
    }
    EnhancedSpawnScreen > Vertical#spawn-dialog-v2 {
        width: 76;
        height: auto;
        max-height: 42;
        background: #2d333b;
        border: round #316dca;
        padding: 1 2;
    }
    EnhancedSpawnScreen Static.spawn-label {
        color: #8b949e;
        height: 1;
    }
    EnhancedSpawnScreen Input.spawn-field {
        border: solid #444c56;
        background: #22272e;
        color: #adbac7;
        height: 3;
        margin-bottom: 1;
    }
    EnhancedSpawnScreen Input.spawn-field:focus {
        border: solid #316dca;
    }
    EnhancedSpawnScreen Select.spawn-field {
        margin-bottom: 1;
    }
    EnhancedSpawnScreen DataTable.spawn-dropdown {
        margin-bottom: 1;
        height: 8;
        max-height: 8;
        min-height: 3;
        background: #1f242d;
    }
    EnhancedSpawnScreen .hidden {
        display: none;
    }
    EnhancedSpawnScreen Static#spawn-role-note {
        color: #636e7b;
        margin-bottom: 1;
    }
    EnhancedSpawnScreen Static#spawn-cwd-display {
        color: #6cb6ff;
        margin-bottom: 1;
    }
    """

    def __init__(
        self,
        tmux: Any,
        scope_root: str,
        prefill_branch: str = "",
        prefill: dict[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self._tmux = tmux
        self._scope_root = scope_root
        self._prefill_branch = prefill_branch
        self._prefill = dict(prefill or {})

        self._repo_root = self._resolve_repo_root()
        self._branches = self._load_branches()

        self._filtered_branches: list[str] = []
        self._templates_open = False

    def compose(self) -> ComposeResult:
        project = os.path.basename(self._scope_root.rstrip("/")) or (
            "(all)" if self._scope_root == "/" else self._scope_root
        )
        with Vertical(id="spawn-dialog-v2"):
            yield Static("[▶] New Agent Session (Enhanced)", classes="spawn-label")
            yield Static(f"Project: {project}", classes="spawn-label")

            yield Static("Harness:", classes="spawn-label")
            yield Select(
                _HARNESS_OPTIONS,
                value="omp",
                id="spawn-harness",
                classes="spawn-field",
            )

            yield Static("Branch:", classes="spawn-label")
            yield Input(
                id="spawn-branch",
                value=self._prefill_branch,
                placeholder="feature/new-thing",
                classes="spawn-field",
            )
            yield DataTable(
                id="spawn-branch-dropdown",
                classes="spawn-dropdown hidden",
                cursor_type="row",
                show_header=False,
                show_cursor=True,
            )

            with Vertical(id="spawn-role-container"):
                yield Static("Role (OMP only):", classes="spawn-label")
                yield Select(
                    _ROLE_OPTIONS,
                    value="default",
                    id="spawn-role",
                    classes="spawn-field",
                )
            yield Static(
                "Role not applicable for selected harness",
                id="spawn-role-note",
                classes="spawn-label hidden",
            )

            yield Static("Working directory:", classes="spawn-label")
            yield Input(
                id="spawn-cwd",
                value=self._default_cwd(),
                placeholder="/path/to/start/directory",
                classes="spawn-field",
            )
            yield Static("", id="spawn-cwd-display")

            yield Static("Task:", classes="spawn-label")
            yield Input(
                id="spawn-task",
                value="",
                placeholder="Describe the task for the agent...",
                classes="spawn-field",
            )

            yield Static("Templates (Ctrl+T):", classes="spawn-label")
            yield DataTable(
                id="spawn-template-table",
                classes="spawn-dropdown hidden",
                cursor_type="row",
                show_header=False,
                show_cursor=True,
            )
            yield Static(
                "[Enter in Task] Launch  [Tab in dropdown] Complete  [Esc] Cancel",
                classes="spawn-label",
            )

    def on_mount(self) -> None:
        self._setup_dropdown_table("#spawn-branch-dropdown", "branch", 70)
        self._setup_dropdown_table("#spawn-template-table", "template", 70)

        self._set_select_value(
            "#spawn-harness",
            str(self._prefill.get("harness") or "omp"),
            _HARNESS_OPTIONS,
            fallback="omp",
        )
        self._set_select_value(
            "#spawn-role",
            str(self._prefill.get("role") or "default"),
            _ROLE_OPTIONS,
            fallback="default",
        )

        defaults = {
            "branch": self._prefill_branch,
            "task": "",
            "cwd": self._default_cwd(),
        }
        for key, default in defaults.items():
            value = self._prefill.get(key, default)
            if value is None:
                value = default
            elif not isinstance(value, str):
                value = str(value)
            try:
                self.query_one(f"#spawn-{key}", Input).value = value
            except Exception:
                pass

        self._sync_role_visibility()
        self._refresh_branch_dropdown(show=False)
        self._refresh_template_table()
        self._refresh_cwd_display()

    def on_focus(self, event: Any) -> None:
        widget_id = getattr(getattr(event, "widget", None), "id", "")
        if widget_id == "spawn-branch":
            self._refresh_branch_dropdown(show=True)

    def on_select_changed(self, event: Select.Changed) -> None:
        if (event.select.id or "") == "spawn-harness":
            self._sync_role_visibility()

    def on_input_changed(self, event: Input.Changed) -> None:
        field_id = event.input.id or ""
        if field_id == "spawn-branch":
            self._refresh_branch_dropdown(show=True)
            return
        if field_id == "spawn-cwd":
            self._refresh_cwd_display()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        field_id = event.input.id or ""
        if field_id == "spawn-branch":
            self._select_branch_from_dropdown()
            return
        if field_id == "spawn-task":
            self.action_launch()

    def on_key(self, event: Any) -> None:
        focused_id = getattr(self.focused, "id", "")
        if focused_id == "spawn-branch":
            if event.key == "tab":
                self._tab_complete_branch()
                event.stop()
                return
            if event.key in {"up", "down"}:
                self._move_dropdown_cursor("#spawn-branch-dropdown", event.key)
                event.stop()
                return
            if event.key == "enter" and self._is_dropdown_visible("#spawn-branch-dropdown"):
                self._select_branch_from_dropdown()
                event.stop()
                return

        if focused_id == "spawn-template-table" and event.key == "enter":
            self._select_template()
            event.stop()

    def action_toggle_templates(self) -> None:
        table = self.query_one("#spawn-template-table", DataTable)
        self._templates_open = not self._templates_open
        if self._templates_open:
            table.remove_class("hidden")
            table.focus()
        else:
            table.add_class("hidden")
            self.query_one("#spawn-task", Input).focus()

    def action_launch(self) -> None:
        try:
            harness = self._selected_value("#spawn-harness", fallback="omp")
            role = self._selected_value("#spawn-role", fallback="default")
            if harness != "omp":
                role = "default"

            launch_harness = self._build_harness_command(harness, role)
            cwd = self.query_one("#spawn-cwd", Input).value.strip()
            launch_root = cwd or self._repo_root
            if launch_root and not os.path.isdir(launch_root):
                self.notify(
                    f"Directory not found: {launch_root}; falling back to {self._repo_root}",
                    severity="warning",
                )
                launch_root = self._repo_root

            current = self._tmux.get_current_session() or ""
            if launch_root:
                command = f"cd {shlex.quote(launch_root)} && {launch_harness}"
                name = harness.split()[0][:20] or "omp"
                self._tmux.new_window(command, session=current, name=name)
            else:
                actions.create_session(self._tmux, current, harness=launch_harness)

            branch = self.query_one("#spawn-branch", Input).value.strip()
            task = self.query_one("#spawn-task", Input).value.strip()
            details = [
                f"harness={harness}",
                f"branch={branch or '-'}",
                f"role={role if harness == 'omp' else 'n/a'}",
                f"cwd={launch_root or '-'}",
            ]
            if task:
                details.append("task set")
            self.notify("Launched session (" + ", ".join(details) + ")")
        except Exception as exc:
            self.notify(str(exc), severity="error")
        self.dismiss(True)

    def _sync_role_visibility(self) -> None:
        harness = self._selected_value("#spawn-harness", fallback="omp")
        is_omp = harness == "omp"
        role_container = self.query_one("#spawn-role-container", Vertical)
        role_note = self.query_one("#spawn-role-note", Static)
        role_select = self.query_one("#spawn-role", Select)

        if is_omp:
            role_container.remove_class("hidden")
            role_note.add_class("hidden")
            role_select.disabled = False
        else:
            role_container.add_class("hidden")
            role_note.remove_class("hidden")
            role_select.disabled = True

    @staticmethod
    def _build_harness_command(harness: str, role: str) -> str:
        normalized_harness = (harness or "omp").strip() or "omp"
        if normalized_harness != "omp":
            return normalized_harness
        normalized_role = (role or "default").strip().lower()
        if normalized_role == "orchestrator":
            return "omp --role orchestrator"
        return "omp --role default"

    def _set_select_value(
        self,
        selector: str,
        value: str,
        options: list[tuple[str, str]],
        *,
        fallback: str,
    ) -> None:
        normalized = (value or "").strip()
        allowed = {option_value for _, option_value in options}
        if normalized not in allowed:
            normalized = fallback
        try:
            self.query_one(selector, Select).value = normalized
        except Exception:
            pass

    def _selected_value(self, selector: str, *, fallback: str) -> str:
        try:
            raw = self.query_one(selector, Select).value
        except Exception:
            return fallback
        if isinstance(raw, str):
            normalized = raw.strip()
            if normalized:
                return normalized
        return fallback

    def _setup_dropdown_table(self, selector: str, column_key: str, width: int) -> None:
        table = self.query_one(selector, DataTable)
        if getattr(table, "columns", None):
            return
        table.add_column(column_key, width=width)

    def _refresh_branch_dropdown(self, *, show: bool) -> None:
        query = self.query_one("#spawn-branch", Input).value.strip()
        self._filtered_branches = self._fuzzy_filter(query, self._branches)
        table = self.query_one("#spawn-branch-dropdown", DataTable)
        table.clear()
        for branch in self._filtered_branches[:60]:
            table.add_row(Text(self._shorten(branch), style="#adbac7"))
        if show and self._filtered_branches:
            table.remove_class("hidden")
            table.move_cursor(row=0)
        else:
            table.add_class("hidden")

    def _refresh_template_table(self) -> None:
        table = self.query_one("#spawn-template-table", DataTable)
        table.clear()
        for template in _TEMPLATE_PROMPTS:
            table.add_row(Text(template, style="#adbac7"))

    def _refresh_cwd_display(self) -> None:
        cwd = self.query_one("#spawn-cwd", Input).value.strip()
        shown = cwd or "(default)"
        self.query_one("#spawn-cwd-display", Static).update(
            f"Session will start in: {self._shorten(shown, limit=68)}"
        )

    def _select_branch_from_dropdown(self) -> None:
        selected = self._dropdown_value("#spawn-branch-dropdown", self._filtered_branches)
        if not selected:
            return
        self.query_one("#spawn-branch", Input).value = selected
        self.query_one("#spawn-branch-dropdown", DataTable).add_class("hidden")

    def _select_template(self) -> None:
        table = self.query_one("#spawn-template-table", DataTable)
        idx = int(getattr(table, "cursor_row", 0) or 0)
        if idx < 0 or idx >= len(_TEMPLATE_PROMPTS):
            return
        task_input = self.query_one("#spawn-task", Input)
        task_input.value = _TEMPLATE_PROMPTS[idx]
        self._templates_open = False
        table.add_class("hidden")
        task_input.focus()

    def _tab_complete_branch(self) -> None:
        if not self._filtered_branches:
            return
        self.query_one("#spawn-branch", Input).value = self._filtered_branches[0]
        self.query_one("#spawn-branch-dropdown", DataTable).add_class("hidden")

    def _move_dropdown_cursor(self, selector: str, key: str) -> None:
        table = self.query_one(selector, DataTable)
        if "hidden" in table.classes:
            return
        max_row = max(0, table.row_count - 1)
        current = int(getattr(table, "cursor_row", 0) or 0)
        if key == "up":
            table.move_cursor(row=max(0, current - 1))
        elif key == "down":
            table.move_cursor(row=min(max_row, current + 1))

    def _dropdown_value(self, selector: str, values: list[str]) -> str:
        if not values:
            return ""
        table = self.query_one(selector, DataTable)
        idx = int(getattr(table, "cursor_row", 0) or 0)
        if idx < 0 or idx >= len(values):
            return ""
        return values[idx]

    def _is_dropdown_visible(self, selector: str) -> bool:
        table = self.query_one(selector, DataTable)
        return "hidden" not in table.classes

    def _resolve_repo_root(self) -> str:
        base = self._scope_root if self._scope_root and self._scope_root != "/" else os.getcwd()
        return os.path.realpath(base)

    def _default_cwd(self) -> str:
        prefilled = str(self._prefill.get("cwd") or "").strip()
        if prefilled:
            return prefilled
        return self._repo_root

    def _load_branches(self) -> list[str]:
        try:
            result = subprocess.run(
                ["git", "branch", "--sort=-committerdate", "--format=%(refname:short)"],
                cwd=self._repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except Exception:
            return []
        if result.returncode != 0:
            return []
        names = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return self._unique(names)

    @staticmethod
    def _shorten(value: str, *, limit: int = 66) -> str:
        if len(value) <= limit:
            return value
        if limit <= 1:
            return "…"
        return value[: max(1, limit - 1)] + "…"

    @staticmethod
    def _fuzzy_filter(query: str, values: Iterable[str]) -> list[str]:
        needle = query.strip().lower()
        if not needle:
            return list(values)

        scored: list[tuple[int, int, str]] = []
        for value in values:
            score = EnhancedSpawnScreen._fuzzy_score(needle, value.lower())
            if score is None:
                continue
            scored.append((score, len(value), value))

        scored.sort(key=lambda item: (item[0], item[1], item[2]))
        return [item[2] for item in scored]

    @staticmethod
    def _fuzzy_score(query: str, text: str) -> int | None:
        idx = 0
        gap_score = 0
        for char in query:
            next_idx = text.find(char, idx)
            if next_idx < 0:
                return None
            gap_score += next_idx - idx
            idx = next_idx + 1
        return gap_score + (len(text) - len(query))

    @staticmethod
    def _unique(items: Iterable[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for item in items:
            if item in seen:
                continue
            seen.add(item)
            result.append(item)
        return result


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    current = getattr(AgentsViewApp, "action_new_session", None)
    if getattr(current, "_spawn_enhanced", False):
        return

    def _action_new_session_enhanced(self: Any) -> None:
        prefill_branch = ""
        prefill: dict[str, str] = {}
        selected = getattr(self, "_selected_session", None)
        if selected:
            prefill_branch = str(getattr(selected, "branch", "") or "")
            for key in ("harness", "role", "cwd"):
                value = str(getattr(selected, key, "") or "").strip()
                if value:
                    prefill[key] = value

        self.push_screen(
            EnhancedSpawnScreen(
                tmux=self._tmux,
                scope_root=self.scope_root,
                prefill_branch=prefill_branch,
                prefill=prefill,
            )
        )

    setattr(_action_new_session_enhanced, "_spawn_enhanced", True)
    AgentsViewApp.action_new_session = _action_new_session_enhanced  # type: ignore[method-assign]


_patch_app()

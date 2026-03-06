"""yazzie_integration.py - Detect Yazzie file manager's current directory.

Provides ``get_yazzie_cwd()`` used by spawn flows to pre-fill the working
directory from Yazzie's current location.
"""

from __future__ import annotations

import importlib
import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Any
_CACHE_TTL_SECONDS = 2.0
_STALE_FILE_MAX_AGE_SECONDS = 30.0
_YAZZIE_ENV_VARS = ("YAZZIE_CWD", "YAZZIE_DIR", "YAZZIE_PATH")

_yazzie_cwd_cache: dict[str, Any] = {"dir": None, "ts": 0.0}


def _normalize_existing_dir(value: str | None) -> str | None:
    if not value:
        return None
    text = value.strip().strip("\x00")
    if not text:
        return None
    if text.startswith("'") and text.endswith("'"):
        text = text[1:-1]
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1]

    candidate = Path(text).expanduser()
    try:
        if candidate.is_dir():
            return str(candidate.resolve())
    except Exception:
        return None
    return None


def _path_is_fresh(path: Path) -> bool:
    try:
        age = time.time() - path.stat().st_mtime
        return age <= _STALE_FILE_MAX_AGE_SECONDS
    except Exception:
        return False


def _read_tmux_yazzie_dir() -> str | None:
    commands = (
        ["tmux", "show-environment", "-g", "YAZZIE_CWD"],
        ["tmux", "show-environment", "YAZZIE_CWD"],
    )
    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
        except Exception:
            continue
        if result.returncode != 0:
            continue
        output = (result.stdout or "").strip()
        if not output or output.startswith("-YAZZIE_CWD"):
            continue
        if "=" not in output:
            continue
        value = output.split("=", 1)[1]
        normalized = _normalize_existing_dir(value)
        if normalized:
            return normalized
    return None


def _read_yazzie_shared_file() -> str | None:
    candidates = (
        Path.home() / ".yazzie" / "current_dir",
        Path.home() / ".config" / "yazzie" / "cwd",
    )
    for path in candidates:
        try:
            if not path.exists() or not path.is_file() or not _path_is_fresh(path):
                continue
            value = path.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            continue
        normalized = _normalize_existing_dir(value)
        if normalized:
            return normalized
    return None


def _read_yazzie_pipe() -> str | None:
    path = Path.home() / ".yazzie" / "cwd.pipe"
    try:
        if not path.exists() or not _path_is_fresh(path):
            return None
        mode = path.stat().st_mode
        if not stat.S_ISFIFO(mode):
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except Exception:
        return None

    try:
        data = os.read(fd, 4096)
    except BlockingIOError:
        return None
    except Exception:
        return None
    finally:
        try:
            os.close(fd)
        except Exception:
            pass

    if not data:
        return None
    raw_value = data.decode("utf-8", errors="replace").strip().splitlines()
    if not raw_value:
        return None
    return _normalize_existing_dir(raw_value[-1])


def get_yazzie_cwd() -> str | None:
    """Get Yazzie's current directory using multiple detection methods."""
    global _yazzie_cwd_cache

    now = time.time()
    if now - float(_yazzie_cwd_cache.get("ts", 0.0)) < _CACHE_TTL_SECONDS:
        cached = _yazzie_cwd_cache.get("dir")
        return cached if isinstance(cached, str) else None

    cwd: str | None = None

    for env_var in _YAZZIE_ENV_VARS:
        cwd = _normalize_existing_dir(os.environ.get(env_var))
        if cwd:
            break

    if not cwd:
        cwd = _read_tmux_yazzie_dir()

    if not cwd:
        cwd = _read_yazzie_shared_file()

    if not cwd:
        cwd = _read_yazzie_pipe()

    _yazzie_cwd_cache = {"dir": cwd, "ts": now}
    return cwd


def _fallback_dir_for_app(app: Any) -> str:
    scope_root = getattr(app, "scope_root", "")
    if isinstance(scope_root, str) and scope_root.strip() and scope_root != "/":
        normalized = _normalize_existing_dir(scope_root)
        if normalized:
            return normalized
    return os.getcwd()


def _sync_yazzie_state(app: Any, *, notify_change: bool) -> str:
    yazzie_dir = get_yazzie_cwd()
    fallback_dir = _fallback_dir_for_app(app)
    default_dir = yazzie_dir or fallback_dir

    previous_yazzie = getattr(app, "_yazzie_last_dir", None)
    if notify_change and yazzie_dir and isinstance(previous_yazzie, str):
        if previous_yazzie and yazzie_dir != previous_yazzie:
            try:
                app.notify(f"Yazzie: → {yazzie_dir}", timeout=2)
            except Exception:
                pass

    setattr(app, "_yazzie_last_dir", yazzie_dir)
    setattr(app, "_spawn_default_cwd", default_dir)
    setattr(app, "_spawn_default_cwd_source", "Yazzie" if yazzie_dir else "Scope")
    return default_dir


def _resolve_spawn_cwd_prefill(screen: Any) -> tuple[str, str]:
    value = None
    source = "Scope"

    prefill = getattr(screen, "_prefill", {})
    if isinstance(prefill, dict):
        value = prefill.get("cwd")
        prefill_source = prefill.get("_cwd_source")
        if isinstance(prefill_source, str) and prefill_source.strip():
            source = prefill_source.strip()

    app = getattr(screen, "app", None)
    if not value and app is not None:
        value = getattr(app, "_spawn_default_cwd", None)
        app_source = getattr(app, "_spawn_default_cwd_source", None)
        if isinstance(app_source, str) and app_source.strip():
            source = app_source.strip()

    normalized = _normalize_existing_dir(str(value)) if isinstance(value, str) else None
    if not normalized:
        scope_root = getattr(screen, "_scope_root", "")
        normalized = _normalize_existing_dir(scope_root)
    if not normalized:
        normalized = os.getcwd()

    return normalized, source


def _patch_app() -> None:
    try:
        app_module = importlib.import_module("agents_view.app")
        AgentsViewApp: Any = getattr(app_module, "AgentsViewApp", None)
        SpawnScreen: Any = getattr(app_module, "SpawnScreen", None)
    except Exception:
        return
    if AgentsViewApp is None or SpawnScreen is None:
        return

    if getattr(AgentsViewApp, "_yazzie_integration_patched", False):
        return
    setattr(AgentsViewApp, "_yazzie_integration_patched", True)

    AgentsViewApp._get_yazzie_cwd = staticmethod(get_yazzie_cwd)

    original_init = AgentsViewApp.__init__

    def _init_with_yazzie(self: Any, scope_root: str) -> None:
        original_init(self, scope_root)
        _sync_yazzie_state(self, notify_change=False)

    AgentsViewApp.__init__ = _init_with_yazzie

    original_apply = getattr(AgentsViewApp, "_apply_refreshed_sessions", None)

    def _apply_refreshed_with_yazzie(self: Any, sessions: list[Any]) -> None:
        if callable(original_apply):
            original_apply(self, sessions)
        _sync_yazzie_state(self, notify_change=True)

    AgentsViewApp._apply_refreshed_sessions = _apply_refreshed_with_yazzie

    def _get_spawn_default_cwd(self: Any) -> str:
        value = getattr(self, "_spawn_default_cwd", None)
        if isinstance(value, str):
            normalized = _normalize_existing_dir(value)
            if normalized:
                return normalized
        return _fallback_dir_for_app(self)

    AgentsViewApp._get_spawn_default_cwd = _get_spawn_default_cwd

    def _action_new_session_with_yazzie(self: Any) -> None:
        prefill_branch = ""
        selected = getattr(self, "_selected_session", None)
        if selected is not None:
            prefill_branch = getattr(selected, "branch", "") or ""

        default_cwd = self._get_spawn_default_cwd()
        source = getattr(self, "_spawn_default_cwd_source", "Scope")
        prefill = {
            "cwd": default_cwd,
            "_cwd_source": source,
        }

        self.push_screen(
            SpawnScreen(
                tmux=self._tmux,
                scope_root=self.scope_root,
                prefill_branch=prefill_branch,
                prefill=prefill,
            )
        )

    AgentsViewApp.action_new_session = _action_new_session_with_yazzie

    def _spawn_compose_with_yazzie(self: Any):
        from textual.containers import Vertical
        from textual.widgets import Input, Static

        project = os.path.basename(self._scope_root) if self._scope_root != "/" else "(all)"
        cwd_value, source = _resolve_spawn_cwd_prefill(self)
        badge = "(Yazzie)" if source.lower() == "yazzie" else f"({source})"

        with Vertical(id="spawn-dialog"):
            yield Static("[▶] New Agent Session", classes="spawn-label")
            yield Static(f"Project: {project}", classes="spawn-label")
            yield Static(f"📂 Directory: {cwd_value} {badge}", id="spawn-cwd-indicator", classes="spawn-label")
            yield Static("Working directory:", classes="spawn-label")
            yield Input(
                id="spawn-cwd",
                value=cwd_value,
                placeholder=self._scope_root,
                classes="spawn-field",
            )
            yield Static("Harness:", classes="spawn-label")
            yield Input(
                id="spawn-harness",
                value="omp",
                placeholder="omp / claude / codex / opencode",
                classes="spawn-field",
            )
            yield Static("Branch:", classes="spawn-label")
            yield Input(
                id="spawn-branch",
                value=self._prefill_branch,
                placeholder="feature/new-thing",
                classes="spawn-field",
            )
            yield Static("Role:", classes="spawn-label")
            yield Input(
                id="spawn-role",
                value="default",
                placeholder="default / orchestrator",
                classes="spawn-field",
            )
            yield Static("Task:", classes="spawn-label")
            yield Input(
                id="spawn-task",
                value="",
                placeholder="Describe the task for the agent...",
                classes="spawn-field",
            )
            yield Static("[Tab to Task then Enter] Launch  [Esc] Cancel", classes="spawn-label")

    SpawnScreen.compose = _spawn_compose_with_yazzie

    original_on_mount = SpawnScreen.on_mount

    def _spawn_on_mount_with_yazzie(self: Any) -> None:
        if callable(original_on_mount):
            original_on_mount(self)

        cwd_value, source = _resolve_spawn_cwd_prefill(self)

        try:
            from textual.widgets import Input, Static

            self.query_one("#spawn-cwd", Input).value = cwd_value
            badge = "(Yazzie)" if source.lower() == "yazzie" else f"({source})"
            self.query_one("#spawn-cwd-indicator", Static).update(
                f"📂 Directory: {cwd_value} {badge}"
            )
        except Exception:
            pass

    SpawnScreen.on_mount = _spawn_on_mount_with_yazzie

    original_launch = SpawnScreen.action_launch

    def _spawn_launch_with_yazzie(self: Any) -> None:
        try:
            from textual.widgets import Input

            harness = self.query_one("#spawn-harness", Input).value.strip() or "omp"
            cwd_raw = self.query_one("#spawn-cwd", Input).value.strip()
            cwd = _normalize_existing_dir(cwd_raw)
            if not cwd:
                cwd = _normalize_existing_dir(getattr(self, "_scope_root", "")) or os.getcwd()

            current = self._tmux.get_current_session() or ""
            actions_mod = getattr(app_module, "actions", None)
            create_session = getattr(actions_mod, "create_session", None)
            if not callable(create_session):
                raise RuntimeError("create_session unavailable")
            create_session(self._tmux, current, harness=harness)

            try:
                app = getattr(self, "app", None)
                if app is not None:
                    setattr(app, "_spawn_default_cwd", cwd)
                    setattr(app, "_spawn_default_cwd_source", "Manual")
            except Exception:
                pass

            self.notify(f"Launched {harness} session")
            self.dismiss(True)
        except Exception:
            if callable(original_launch):
                original_launch(self)
    SpawnScreen.action_launch = _spawn_launch_with_yazzie


_patch_app()

"""live_log_panel.py — Live log stream indicator and popup viewer.

When an OMP agent runs a bash command that redirects output to a log file
(tee, >, 2>&1 | tee), the live-log-watcher extension writes
~/.omp/agent/live-log-state.json.  This feature:

  1. Polls that file every 0.5 s (piggybacking on _schedule_preview_update).
  2. When a live stream is active for the selected session, shows a blinking
     indicator bar above the footer with a hotkey hint.
  3. Pressing 'v' opens LiveLogScreen — a full-screen popup that tails the
     log file in real time and auto-refreshes every 0.5 s.
"""

from __future__ import annotations

import inspect
import json
import os
import time
from pathlib import Path
from typing import Any, Optional

from rich.text import Text

# ── Constants ────────────────────────────────────────────────────────────────

_STATE_FILE = Path("~/.omp/agent/live-log-state.json").expanduser()
_LOG_TAIL_BYTES = 32_768   # 32 KB — enough for hundreds of lines
_LOG_DISPLAY_LINES = 200   # max lines shown in the popup
_REFRESH_INTERVAL = 0.5    # seconds between log tail re-reads inside the popup

# ── Helpers ──────────────────────────────────────────────────────────────────


def _read_state() -> Optional[dict]:
    """Read and parse the live-log state file.  Returns None on any failure."""
    try:
        raw = _STATE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("active"):
            return data
    except Exception:
        pass
    return None


def _tail_file(path: str, n: int = _LOG_DISPLAY_LINES) -> list[str]:
    """Return the last *n* lines of *path* without loading the whole file."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            if size == 0:
                return []
            chunk = min(size, _LOG_TAIL_BYTES)
            fh.seek(max(0, size - chunk))
            raw = fh.read()
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return lines[-n:]
    except OSError:
        return []


def _session_id_for(session: Any) -> str:
    return str(
        getattr(session, "session_id", None)
        or getattr(session, "id", None)
        or ""
    ).strip()


# ── LiveLogScreen ─────────────────────────────────────────────────────────────


def _build_live_log_screen_class() -> type:
    """Build and return the LiveLogScreen class (deferred to avoid import order issues)."""
    from textual.app import ComposeResult
    from textual.binding import Binding
    from textual.containers import ScrollableContainer
    from textual.screen import Screen
    from textual.widgets import Footer, Header, Static

    class LiveLogScreen(Screen):
        """Full-screen live log tail viewer.  Auto-refreshes every 0.5 s."""

        BINDINGS = [
            Binding("escape", "dismiss", "Close"),
            Binding("q", "dismiss", "Close", show=False),
            Binding("end", "scroll_end", "Jump to end", show=False),
        ]

        CSS = """
        LiveLogScreen {
            background: #0d1117;
        }
        LiveLogScreen Header {
            background: #161b22;
            color: #58a6ff;
            text-style: bold;
        }
        LiveLogScreen #log-meta {
            height: 2;
            background: #161b22;
            color: #8b949e;
            padding: 0 2;
        }
        LiveLogScreen #log-scroll {
            height: 1fr;
            background: #0d1117;
            border: round #30363d;
        }
        LiveLogScreen #log-content {
            padding: 0 1;
            color: #c9d1d9;
        }
        LiveLogScreen #log-status {
            height: 1;
            background: #161b22;
            color: #3fb950;
            padding: 0 2;
        }
        LiveLogScreen Footer {
            background: #161b22;
        }
        """

        def __init__(self, log_path: str, command: str, session_id: str) -> None:
            super().__init__()
            self._log_path = log_path
            self._command = command
            self._session_id = session_id
            self._refresh_timer: object | None = None
            self._line_count = 0
            self._last_size = -1

        def compose(self) -> ComposeResult:
            yield Header()
            yield Static("", id="log-meta", markup=False)
            with ScrollableContainer(id="log-scroll"):
                yield Static("", id="log-content", markup=False)
            yield Static("", id="log-status", markup=False)
            yield Footer()

        def on_mount(self) -> None:
            self.title = "Live Stream"
            self.sub_title = Path(self._log_path).name
            self._update_meta()
            self._refresh_log()
            self._refresh_timer = self.set_interval(_REFRESH_INTERVAL, self._poll)

        def on_unmount(self) -> None:
            timer = self._refresh_timer
            if timer is not None:
                cancel = getattr(timer, "cancel", None) or getattr(timer, "stop", None)
                if callable(cancel):
                    cancel()

        def _update_meta(self) -> None:
            meta = self.query_one("#log-meta", Static)
            cmd = self._command
            if len(cmd) > 120:
                cmd = cmd[:117] + "..."
            meta.update(f"cmd: {cmd}\nfile: {self._log_path}")

        def _refresh_log(self) -> None:
            # Check if state is still active; dismiss if the command finished.
            state = _read_state()
            if state is None or state.get("log_path") != self._log_path:
                # Command finished — keep the final output visible but stop polling.
                self._stop_refresh()
                self._update_status("Command finished.  Press Esc to close.")
                return

            lines = _tail_file(self._log_path)
            self._line_count = len(lines)

            content_widget = self.query_one("#log-content", Static)
            rendered = self._render_lines(lines)
            content_widget.update(rendered)

            # Auto-scroll to bottom on new content.
            try:
                scroll = self.query_one("#log-scroll", ScrollableContainer)
                scroll.scroll_end(animate=False)
            except Exception:
                pass

            self._update_status(
                f"Streaming — {self._line_count} lines | {self._log_path}"
                f"  [Esc close]"
            )

        def _render_lines(self, lines: list[str]) -> Text:
            from agents_view.app import _sanitize_preview_ansi

            result = Text()
            for i, line in enumerate(lines):
                clean = _sanitize_preview_ansi(line)
                # Alternate row shading for readability.
                if i % 2 == 0:
                    result.append(clean + "\n", style="#c9d1d9")
                else:
                    result.append(clean + "\n", style="#b1bac4")
            return result

        def _update_status(self, msg: str) -> None:
            try:
                status = self.query_one("#log-status", Static)
                status.update(msg)
            except Exception:
                pass

        def _stop_refresh(self) -> None:
            timer = self._refresh_timer
            if timer is not None:
                cancel = getattr(timer, "cancel", None) or getattr(timer, "stop", None)
                if callable(cancel):
                    cancel()
            self._refresh_timer = None

        def _poll(self) -> None:
            self._refresh_log()

        def action_scroll_end(self) -> None:
            try:
                scroll = self.query_one("#log-scroll", ScrollableContainer)
                scroll.scroll_end(animate=False)
            except Exception:
                pass

    return LiveLogScreen


_LiveLogScreen: type | None = None


def _get_live_log_screen() -> type:
    global _LiveLogScreen
    if _LiveLogScreen is None:
        _LiveLogScreen = _build_live_log_screen_class()
    return _LiveLogScreen


# ── Indicator bar ─────────────────────────────────────────────────────────────


def _mount_live_stream_bar(app: Any) -> None:
    """Inject the #live-stream-bar Static between #stats-bar and Footer."""
    if bool(getattr(app, "_live_stream_bar_mounted", False)):
        return
    from textual.widgets import Static

    bar = Static("", id="live-stream-bar", markup=True)
    try:
        # Mount above the Footer (last child of the Screen).
        screen = app.screen
        children = list(screen.children)
        # Find Footer — inject the bar just before it.
        from textual.widgets import Footer as _Footer
        footer_idx = next(
            (i for i, w in enumerate(children) if isinstance(w, _Footer)), None
        )
        if footer_idx is not None:
            screen.mount(bar, before=children[footer_idx])
        else:
            screen.mount(bar)
        app._live_stream_bar_mounted = True
    except Exception:
        pass


def _set_bar_text(app: Any, active: bool, state: Optional[dict]) -> None:
    """Update the indicator bar content and visibility."""
    try:
        bar = app.query_one("#live-stream-bar")
    except Exception:
        return

    if not active or state is None:
        bar.display = False
        return

    bar.display = True
    log_name = Path(str(state.get("log_path", ""))).name or "log"
    blink_on = bool(getattr(app, "_live_stream_blink_state", False))

    if blink_on:
        label = f"[bold bright_green] ⚡ LIVE STREAM [/bold bright_green]"
        hint_color = "bright_white"
    else:
        label = f"[bold green] ⚡ LIVE STREAM [/bold green]"
        hint_color = "white"

    bar.update(
        f"{label}"
        f"[{hint_color}]  {log_name}  [/{hint_color}]"
        f"[dim]  press [/dim]"
        f"[bold yellow] v [/bold yellow]"
        f"[dim]to open[/dim]"
    )


# ── Patch ─────────────────────────────────────────────────────────────────────


def _patch_app() -> None:
    try:
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    if bool(getattr(AgentsViewApp, "_live_log_panel_feature_patched", False)):
        return

    from textual.binding import Binding

    original_init = getattr(AgentsViewApp, "__init__", None)
    original_on_mount = getattr(AgentsViewApp, "on_mount", None)
    original_schedule = getattr(AgentsViewApp, "_schedule_preview_update", None)

    if not callable(original_init):
        return

    # ── __init__ patch ────────────────────────────────────────────────────────

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        self._live_stream_bar_mounted = False
        self._live_stream_active = False
        self._live_stream_state: Optional[dict] = None
        self._live_stream_blink_state = False
        self._live_stream_blink_timer: object | None = None

    # ── on_mount patch ────────────────────────────────────────────────────────

    async def _patched_on_mount(self: Any) -> None:
        if callable(original_on_mount):
            result = original_on_mount(self)
            if inspect.isawaitable(result):
                await result
        _mount_live_stream_bar(self)
        # Start the blink timer — always running, cheap when bar is hidden.
        try:
            self._live_stream_blink_timer = self.set_interval(0.6, self._live_stream_blink_tick)
        except Exception:
            pass

    # ── blink tick ────────────────────────────────────────────────────────────

    def _live_stream_blink_tick(self: Any) -> None:
        if not bool(getattr(self, "_live_stream_active", False)):
            return
        self._live_stream_blink_state = not bool(
            getattr(self, "_live_stream_blink_state", False)
        )
        _set_bar_text(self, active=True, state=getattr(self, "_live_stream_state", None))

    # ── _schedule_preview_update patch ───────────────────────────────────────

    def _patched_schedule(self: Any, session: Any) -> None:
        if callable(original_schedule):
            original_schedule(self, session)
        if session is None:
            return
        try:
            _poll_live_stream(self, session)
        except Exception:
            pass

    def _poll_live_stream(self: Any, session: Any) -> None:
        """Check the state file and update bar visibility for the selected session."""
        state = _read_state()
        selected_sid = _session_id_for(session)

        if state is not None and (
            not selected_sid or state.get("session_id") == selected_sid
        ):
            self._live_stream_active = True
            self._live_stream_state = state
        else:
            if bool(getattr(self, "_live_stream_active", False)):
                # Transition: was active, now gone — reset blink state.
                self._live_stream_blink_state = False
            self._live_stream_active = False
            self._live_stream_state = None

        _set_bar_text(self, active=bool(self._live_stream_active), state=self._live_stream_state)

    # ── action: open popup ───────────────────────────────────────────────────

    def _action_view_live_stream(self: Any) -> None:
        state = getattr(self, "_live_stream_state", None)
        if state is None:
            # Nothing active — check file directly as a fallback.
            state = _read_state()
        if state is None:
            try:
                self.notify("No live stream active", severity="warning", timeout=3)
            except Exception:
                pass
            return
        LiveLogScreen = _get_live_log_screen()
        self.push_screen(
            LiveLogScreen(
                log_path=str(state.get("log_path", "")),
                command=str(state.get("command", "")),
                session_id=str(state.get("session_id", "")),
            )
        )

    # ── Wire everything in ────────────────────────────────────────────────────

    AgentsViewApp.__init__ = _patched_init  # type: ignore[method-assign]

    if callable(original_on_mount):
        AgentsViewApp.on_mount = _patched_on_mount  # type: ignore[method-assign]

    if callable(original_schedule):
        AgentsViewApp._schedule_preview_update = _patched_schedule  # type: ignore[method-assign]

    AgentsViewApp._live_stream_blink_tick = _live_stream_blink_tick  # type: ignore[attr-defined,method-assign]
    AgentsViewApp.action_view_live_stream = _action_view_live_stream  # type: ignore[attr-defined,method-assign]

    # Add the binding only if it isn't already there.
    existing_actions = {getattr(b, "action", "") for b in list(AgentsViewApp.BINDINGS)}
    if "view_live_stream" not in existing_actions:
        AgentsViewApp.BINDINGS = list(AgentsViewApp.BINDINGS) + [
            Binding("v", "view_live_stream", "Live stream", show=False),
        ]

    # Register in the help screen table.
    try:
        from agents_view.app import HelpScreen
        entry = ("Screens", "v", "Live stream viewer")
        if entry not in HelpScreen._BINDINGS_TABLE:
            HelpScreen._BINDINGS_TABLE.append(entry)
    except Exception:
        pass

    # ── CSS ───────────────────────────────────────────────────────────────────

    _bar_css = """
#live-stream-bar {
    display: none;
    height: 1;
    background: #0d1117;
    color: #3fb950;
    padding: 0 1;
    text-align: left;
}
"""
    existing_css = str(getattr(AgentsViewApp, "CSS", "") or "")
    if "#live-stream-bar" not in existing_css:
        AgentsViewApp.CSS = existing_css + "\n" + _bar_css

    AgentsViewApp._live_log_panel_feature_patched = True  # type: ignore[attr-defined]


_patch_app()

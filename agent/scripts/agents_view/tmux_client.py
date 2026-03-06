from __future__ import annotations

import logging
import subprocess
from typing import Optional

log = logging.getLogger(__name__)


class TmuxError(Exception):
    pass


class TmuxClient:
    def run(self, args: list[str], timeout: float = 5.0) -> str:
        """Run a tmux command; raises TmuxError on failure or timeout."""
        try:
            result = subprocess.run(
                ["tmux"] + args,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            raise TmuxError(f"tmux {args[0]!r} timed out after {timeout}s") from e
        except FileNotFoundError as e:
            raise TmuxError("tmux not found in PATH") from e
        if result.returncode != 0:
            raise TmuxError(
                f"tmux {args[0]!r} exited {result.returncode}: {result.stderr.strip()}"
            )
        return result.stdout

    def list_panes_all(self) -> list[dict]:
        """Return all panes across all sessions as dicts."""
        fmt = (
            "#{session_name}\t#{window_id}\t#{pane_id}"
            "\t#{pane_pid}\t#{pane_current_command}"
            "\t#{pane_current_path}\t#{pane_active}"
        )
        try:
            output = self.run(["list-panes", "-a", "-F", fmt])
        except TmuxError as e:
            log.error("list_panes_all: %s", e)
            return []

        panes: list[dict] = []
        for line in output.splitlines():
            parts = line.split("\t")
            if len(parts) != 7:
                continue
            panes.append(
                {
                    "session": parts[0],
                    "window": parts[1],
                    "pane": parts[2],
                    "pid": parts[3],
                    "command": parts[4],
                    "cwd": parts[5],
                    "active": parts[6] == "1",
                }
            )
        return panes

    def get_sidebar_pane(self) -> Optional[dict[str, str]]:
        """Return pane metadata for @sidebar_role=1, or None."""
        fmt = (
            "#{pane_id}\t#{pane_pid}\t#{pane_current_path}"
            "\t#{session_name}\t#{window_id}\t#{@sidebar_role}"
        )
        try:
            output = self.run(["list-panes", "-a", "-F", fmt], timeout=2.0)
        except TmuxError as e:
            log.debug("get_sidebar_pane: %s", e)
            return None

        for line in output.splitlines():
            parts = line.split("\t")
            if len(parts) != 6 or parts[5] != "1":
                continue
            return {
                "pane": parts[0],
                "pid": parts[1],
                "cwd": parts[2],
                "session": parts[3],
                "window": parts[4],
            }
        return None

    def capture_pane(self, pane_id: str, lines: int = 40) -> str:
        """Capture visible pane content; returns empty string on error."""
        try:
            return self.run(
                ["capture-pane", "-p", "-e", "-t", pane_id, "-S", str(-lines)]
            )
        except TmuxError as e:
            log.debug("capture_pane %s: %s", pane_id, e)
            return ""

    def switch_to_pane(self, session: str, window: str, pane: str) -> None:
        """Focus the tmux client on the given pane."""
        for cmd, target in (
            (["switch-client", "-t", session], "switch-client"),
            (["select-window", "-t", window], "select-window"),
            (["select-pane", "-t", pane], "select-pane"),
        ):
            try:
                self.run(cmd)
            except TmuxError as e:
                log.error("switch_to_pane %s (%s): %s", target, pane, e)

    def send_keys(self, pane_id: str, text: str, enter: bool = True) -> None:
        """Send text to a pane, optionally followed by Enter."""
        args = ["send-keys", "-t", pane_id, text]
        if enter:
            args.append("Enter")
        self.run(args)

    def new_window(
        self,
        command: str,
        session: Optional[str] = None,
        name: str = "resume",
    ) -> str:
        """Open a new window running command; returns the new window_id."""
        args = ["new-window", "-P", "-F", "#{window_id}", "-n", name]
        if session:
            args += ["-t", session]
        args.append(command)
        return self.run(args).strip()

    def get_current_session(self) -> Optional[str]:
        """Return the current tmux client session name, or None."""
        try:
            return self.run(["display-message", "-p", "#{client_session}"]).strip() or None
        except TmuxError as e:
            log.debug("get_current_session: %s", e)
            return None

    def pane_exists(self, pane_id: str) -> bool:
        """Return True if the pane still exists."""
        try:
            self.run(["display-message", "-p", "-t", pane_id, "#{pane_id}"], timeout=2.0)
            return True
        except TmuxError:
            return False

    def kill_pane(self, pane_id: str) -> None:
        """Kill a tmux pane."""
        try:
            self.run(["kill-pane", "-t", pane_id])
        except TmuxError as e:
            log.error("kill_pane %s: %s", pane_id, e)

    def ensure_window_1(self, session: str, window_name: str = "Agents") -> str:
        """Return the window_id of window index 1, creating it if necessary."""
        try:
            output = self.run(
                ["list-windows", "-t", session, "-F", "#{window_index}\t#{window_id}"]
            )
            for line in output.splitlines():
                parts = line.split("\t")
                if len(parts) == 2 and parts[0] == "1":
                    return parts[1]
        except TmuxError as e:
            log.warning("ensure_window_1: list-windows failed: %s", e)

        # Window 1 not found — create it.
        try:
            return self.run(
                [
                    "new-window",
                    "-P",
                    "-F",
                    "#{window_id}",
                    "-t",
                    f"{session}:1",
                    "-n",
                    window_name,
                ]
            ).strip()
        except TmuxError as e:
            log.error("ensure_window_1: failed to create window: %s", e)
            raise

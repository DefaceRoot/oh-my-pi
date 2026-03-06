"""Regression tests for Agents View CLI interrupt handling."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "agents-view.py"


def test_main_handles_keyboard_interrupt_without_traceback() -> None:
    launcher = f"""
import importlib.util
import pathlib
import sys

script_path = pathlib.Path({str(SCRIPT_PATH)!r})
spec = importlib.util.spec_from_file_location("agents_view_cli", script_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InterruptingApp:
    def __init__(self, scope_root: str) -> None:
        self.scope_root = scope_root

    def run(self) -> None:
        raise KeyboardInterrupt

module.AgentsViewApp = InterruptingApp
sys.argv = ["agents-view.py"]
module.main()
"""

    result = subprocess.run(
        [sys.executable, "-c", launcher],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 130
    assert "Traceback" not in result.stderr


def test_main_interrupt_during_threaded_worker_teardown_is_clean() -> None:
    launcher = f"""
import concurrent.futures
import importlib.util
import os
import pathlib
import signal
import sys
import threading
import time

script_path = pathlib.Path({str(SCRIPT_PATH)!r})
spec = importlib.util.spec_from_file_location("agents_view_cli", script_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ThreadedInterruptingApp:
    def __init__(self, scope_root: str) -> None:
        self.scope_root = scope_root

    def run(self) -> None:
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        pool.submit(time.sleep, 2.0)
        threading.Timer(0.1, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
        raise KeyboardInterrupt

module.AgentsViewApp = ThreadedInterruptingApp
sys.argv = ["agents-view.py"]
module.main()
"""

    result = subprocess.run(
        [sys.executable, "-c", launcher],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 130
    assert "Exception ignored on threading shutdown" not in result.stderr
    assert "Traceback" not in result.stderr


def test_patch_shutdown_emits_via_mode_controller() -> None:
    patch_source = (
        Path(__file__).resolve().parents[3]
        / "patches/implement-workflow-clickable-v11.7.2/files/pi-coding-agent/src/modes/interactive-mode.ts"
    ).read_text()

    assert 'this.session.emitCustomToolSessionEvent("shutdown")' not in patch_source
    assert 'this.emitCustomToolSessionEvent("shutdown")' in patch_source

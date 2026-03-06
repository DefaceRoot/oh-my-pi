"""Tests for threaded refresh worker behavior in AgentsViewApp."""
from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path
# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))


import agents_view.adapters.active_tmux_adapter as active_mod
from agents_view.app import AgentsViewApp


def test_refresh_active_worker_dispatch_is_non_blocking(monkeypatch):
    """Slow active discovery must not block the UI thread."""

    def slow_list_active(self, scope_root: str):
        time.sleep(0.1)
        return []

    monkeypatch.setattr(active_mod.ActiveTmuxAdapter, "list_active", slow_list_active)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []

    async def run() -> None:
        async with app.run_test() as pilot:
            start_dispatch = time.perf_counter()
            app._refresh_active()
            dispatch_elapsed = time.perf_counter() - start_dispatch
            assert dispatch_elapsed < 0.05

            before_yield = time.perf_counter()
            await asyncio.sleep(0)
            yield_elapsed = time.perf_counter() - before_yield
            assert yield_elapsed < 0.05
            await asyncio.sleep(0.15)

    asyncio.run(run())


def test_refresh_all_worker_dispatch_is_non_blocking(monkeypatch):
    """Slow full refresh collection must not block UI thread dispatch."""

    def slow_collect_all(self):
        time.sleep(0.1)
        return []

    monkeypatch.setattr(AgentsViewApp, "_collect_all_sessions", slow_collect_all)

    app = AgentsViewApp(scope_root="/")
    app._adapters = []
    apply_thread_ids: list[int] = []
    orig_apply = app._apply_refreshed_sessions

    def wrapped_apply(sessions):
        apply_thread_ids.append(threading.get_ident())
        orig_apply(sessions)

    monkeypatch.setattr(app, "_apply_refreshed_sessions", wrapped_apply)

    async def run() -> None:
        async with app.run_test():
            main_thread_id = threading.get_ident()

            start_dispatch = time.perf_counter()
            app._refresh_all()
            dispatch_elapsed = time.perf_counter() - start_dispatch
            assert dispatch_elapsed < 0.05

            before_yield = time.perf_counter()
            await asyncio.sleep(0)
            yield_elapsed = time.perf_counter() - before_yield
            assert yield_elapsed < 0.05

            await asyncio.sleep(0.15)
            assert apply_thread_ids
            assert all(tid == main_thread_id for tid in apply_thread_ids)

    asyncio.run(run())
"""performance_cache.py - Performance optimizations for agents view.

Provides:
- Preview content caching (LRU cache)
- Filter input debouncing
- Differential table updates
- Smart refresh scheduling based on session states
"""

from __future__ import annotations

import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

from textual import work
from textual.widgets import DataTable, Input


class LRUCache:
    """Simple thread-safe LRU cache with max size."""

    def __init__(self, max_size: int = 50) -> None:
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._max_size = max_size
        self._lock = threading.RLock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            elif len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)
            self._cache[key] = value

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._cache.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


_PREVIEW_CACHE_TTL_SECONDS = 5.0
_FILTER_DEBOUNCE_SECONDS = 0.05
_PREVIEW_DEBOUNCE_SECONDS = 0.05
_PREVIEW_TAIL_BYTES = 32_768
_DIFF_STATS_THROTTLE_SECONDS = 30.0
_REFRESH_FAST_SECONDS = 1.0
_REFRESH_IDLE_SECONDS = 5.0
_REFRESH_MAX_SECONDS = 10.0

# Global preview cache.
_preview_cache: LRUCache = LRUCache(max_size=50)

# session_id -> (mtime, checked_at_monotonic)
_preview_mtime_cache: dict[str, tuple[float, float]] = {}
_preview_mtime_lock = threading.RLock()

# session_id -> last_refresh_monotonic
_diff_stats_last_refresh: dict[str, float] = {}

# session_id -> comparable row values
_last_row_values: dict[str, tuple[str, ...]] = {}

# Selected session id used to gate parse_session_start_time lazily.
_lazy_selected_session_id: Optional[str] = None


def _session_id_from_jsonl_path(path: Path) -> str:
    stem = path.stem
    if "_" in stem:
        return stem.rsplit("_", 1)[-1]
    return stem


def _resolve_mtime(session_id: str, jsonl_path: Path) -> Optional[float]:
    try:
        mtime = jsonl_path.stat().st_mtime
    except OSError:
        return None

    with _preview_mtime_lock:
        _preview_mtime_cache[session_id] = (mtime, time.monotonic())
    return mtime


def _cache_key(session_id: str, mtime: float) -> str:
    return f"{session_id}:{mtime:.6f}"


def get_cached_preview(session_id: str, jsonl_path: Path) -> Optional[Any]:
    """Get cached preview or None if stale/missing."""
    mtime = _resolve_mtime(session_id, jsonl_path)
    if mtime is None:
        return None
    return _preview_cache.get(_cache_key(session_id, mtime))

def _fast_mtime_check(session_file: Path, session_id: str) -> Optional[Any]:
    """Return cached preview when file mtime matches current cache key."""
    try:
        mtime = session_file.stat().st_mtime
    except OSError:
        return None
    with _preview_mtime_lock:
        _preview_mtime_cache[session_id] = (mtime, time.monotonic())
    return _preview_cache.get(_cache_key(session_id, mtime))


def store_cached_preview(session_id: str, jsonl_path: Path, content: Any) -> None:
    """Store rendered preview in cache."""
    mtime = _resolve_mtime(session_id, jsonl_path)
    if mtime is None:
        return
    _preview_cache.put(_cache_key(session_id, mtime), content)


def should_refresh_diff_stats(session_id: str, interval: float = _DIFF_STATS_THROTTLE_SECONDS) -> bool:
    """Check if diff stats should be refreshed (throttled)."""
    now = time.monotonic()
    last = _diff_stats_last_refresh.get(session_id, 0.0)
    if now - last >= interval:
        _diff_stats_last_refresh[session_id] = now
        return True
    return False


def get_optimal_refresh_interval(sessions: list[Any]) -> float:
    """Compute optimal refresh interval based on session states."""
    hot_states = {"running", "stalled", "asking", "review"}
    has_hot_session = any(
        getattr(session, "status", "unknown") in hot_states for session in sessions
    )
    interval = _REFRESH_FAST_SECONDS if has_hot_session else _REFRESH_IDLE_SECONDS
    return max(_REFRESH_FAST_SECONDS, min(_REFRESH_MAX_SECONDS, interval))


def _cancel_timer(handle: object | None) -> None:
    if handle is None:
        return
    try:
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            cancel()
            return
    except Exception:
        pass
    try:
        stop = getattr(handle, "stop", None)
        if callable(stop):
            stop()
    except Exception:
        pass


def _cell_value(cell: Any) -> str:
    plain = getattr(cell, "plain", None)
    if isinstance(plain, str):
        return plain
    return str(cell)


def _row_signature(cells: list[Any]) -> tuple[str, ...]:
    return tuple(_cell_value(cell) for cell in cells)


def _patch_app() -> None:
    try:
        from agents_view import app as app_mod
        from agents_view.app import AgentsViewApp
    except Exception:
        return

    if getattr(AgentsViewApp, "_performance_cache_feature_patched", False):
        return
    setattr(AgentsViewApp, "_performance_cache_feature_patched", True)

    original_on_input_changed = AgentsViewApp.on_input_changed
    original_apply_refreshed_sessions = AgentsViewApp._apply_refreshed_sessions
    original_schedule_preview_update = AgentsViewApp._schedule_preview_update
    original_render_active_preview = app_mod._render_active_preview
    original_parse_session_start_time = app_mod.parse_session_start_time

    def _render_active_preview_cached(session_file_path: str, **kwargs: Any) -> Any:
        session_path = Path(session_file_path)
        session_id = _session_id_from_jsonl_path(session_path)
        cached = get_cached_preview(session_id, session_path)
        if cached is not None:
            return cached

        rendered = original_render_active_preview(session_file_path, **kwargs)
        store_cached_preview(session_id, session_path, rendered)
        return rendered

    setattr(app_mod, "_render_active_preview", _render_active_preview_cached)

    def _parse_session_start_time_lazy(session_file_path: str) -> Optional[float]:
        if not _lazy_selected_session_id:
            return None
        session_id = _session_id_from_jsonl_path(Path(session_file_path))
        if session_id != _lazy_selected_session_id:
            return None
        return original_parse_session_start_time(session_file_path)

    setattr(app_mod, "parse_session_start_time", _parse_session_start_time_lazy)

    try:
        default_settings = getattr(app_mod, "_DEFAULT_AGENTS_VIEW_SETTINGS", None)
        if isinstance(default_settings, dict):
            default_settings["preview_tail_bytes"] = _PREVIEW_TAIL_BYTES
    except Exception:
        pass

    try:
        allowed_settings = getattr(app_mod, "_ALLOWED_AGENTS_VIEW_SETTINGS", None)
        if isinstance(allowed_settings, dict):
            allowed_settings["preview_tail_bytes"] = (_PREVIEW_TAIL_BYTES,)
    except Exception:
        pass

    try:
        app_mod._JSONL_TAIL_BYTES = min(int(getattr(app_mod, "_JSONL_TAIL_BYTES", _PREVIEW_TAIL_BYTES)), _PREVIEW_TAIL_BYTES)
    except Exception:
        app_mod._JSONL_TAIL_BYTES = _PREVIEW_TAIL_BYTES

    def _action_clear_preview_cache(self: Any) -> None:
        _preview_cache.clear()
        _preview_mtime_cache.clear()
        self.notify("Preview cache cleared")

    def _on_input_changed_debounced(self: Any, event: Input.Changed) -> None:
        if event.input.id != "filter-input":
            original_on_input_changed(self, event)
            return

        self._perf_filter_pending_value = event.value
        _cancel_timer(getattr(self, "_perf_filter_debounce_handle", None))

        def _apply_filter() -> None:
            self._perf_filter_debounce_handle = None
            self._filter_text = getattr(self, "_perf_filter_pending_value", "")
            self._update_table()
            self._update_subtitle()

        self._perf_filter_debounce_handle = self.set_timer(
            _FILTER_DEBOUNCE_SECONDS,
            _apply_filter,
        )

    def _schedule_preview_update_faster(self: Any, session: Any) -> None:
        try:
            self._preview_pending_session_id = session.session_id
            _cancel_timer(getattr(self, "_preview_debounce_handle", None))
            self._preview_debounce_handle = None

            selected = getattr(self, "_selected_session", None)
            if selected is not None and selected.session_id == session.session_id:
                session_file = app_mod._extract_session_file_path(getattr(session, "resume_command", None))
                if session_file:
                    session_path = Path(session_file)
                    cached = _fast_mtime_check(session_path, session.session_id)
                    if cached is None:
                        cached = get_cached_preview(session.session_id, session_path)
                    if cached is not None:
                        try:
                            file_stat = session_path.stat()
                        except OSError:
                            file_stat = None
                        if file_stat is None:
                            cached = None
                        else:
                            subagent_rows = self._subagent_rows_for_session(session)
                            selected_idx = self._selected_subagent_index.get(session.session_id, -1)
                            if selected_idx >= len(subagent_rows):
                                selected_idx = -1
                                self._selected_subagent_index[session.session_id] = -1
                            preview_max_lines = self._preview_max_lines_setting()

                            def _mtime_float(value: object) -> float:
                                if isinstance(value, (int, float, str)):
                                    try:
                                        return float(value)
                                    except ValueError:
                                        return 0.0
                                return 0.0

                            subagent_key = tuple(
                                (
                                    str(row.get("session_id") or ""),
                                    str(row.get("status") or ""),
                                    _mtime_float(row.get("mtime")),
                                )
                                for row in subagent_rows
                            )

                            preview_render_key: tuple[object, ...] = (
                                session.session_id,
                                file_stat.st_mtime,
                                file_stat.st_size,
                                selected_idx,
                                session.last_activity_ts,
                                subagent_key,
                                preview_max_lines,
                            )
                            branch_part = session.branch if session.branch else ""
                            role_label, _ = session.role_rich
                            panel_title = (
                                f"{branch_part} — {role_label.strip()}"
                                if branch_part
                                else role_label.strip() or ""
                            )
                            status_line = self._preview_status_line(session)
                            self._apply_worker_preview(
                                session.session_id,
                                cached,
                                preview_render_key,
                                panel_title,
                                status_line,
                            )
                            return

            self._preview_debounce_handle = self.set_timer(
                _PREVIEW_DEBOUNCE_SECONDS,
                self._do_preview_update,
            )
        except Exception:
            original_schedule_preview_update(self, session)

    def _update_table_differential(self: Any) -> None:
        try:
            table = self.query_one("#session-table", DataTable)
        except Exception:
            return

        new_keys = self._compute_ordered_keys(self._sessions)
        new_map = {session.session_id: session for session in self._sessions}

        if new_keys == self._ordered_keys:
            col_keys = self._session_table_column_keys()
            for key in new_keys:
                if app_mod._is_separator_key(key):
                    _last_row_values.pop(key, None)
                    continue
                session = new_map.get(key)
                if session is None:
                    continue

                cells = self._make_row_cells(session)
                signature = _row_signature(cells)
                if _last_row_values.get(key) == signature:
                    continue

                for col_key, cell in zip(col_keys, cells):
                    try:
                        table.update_cell(key, col_key, cell, update_width=False)
                    except Exception:
                        pass
                _last_row_values[key] = signature
        else:
            prev_key: Optional[str] = None
            if self._selected_session:
                prev_key = self._selected_session.session_id

            table.clear()
            for key in new_keys:
                if app_mod._is_separator_key(key):
                    table.add_row(
                        *self._separator_row(self._separator_label_for_key(key)),
                        key=key,
                    )
                    continue

                session = new_map.get(key)
                if session is None:
                    continue
                cells = self._make_row_cells(session)
                table.add_row(*cells, key=key)
                _last_row_values[key] = _row_signature(cells)

            self._ordered_keys = new_keys
            self._restore_cursor(table, prev_key, new_keys)

        stale_ids = [session_id for session_id in _last_row_values if session_id not in new_map]
        for session_id in stale_ids:
            _last_row_values.pop(session_id, None)

        self._ordered_keys = new_keys
        self._session_map = new_map
        selected_before = set(self._broadcast_selected_ids)
        self._broadcast_selected_ids.intersection_update(set(new_map.keys()))
        if self._broadcast_selected_ids != selected_before:
            self._cancel_pending_broadcast()

        if self._selected_session and self._selected_session.session_id not in self._ordered_keys:
            self._selected_session = self._current_session()

        if self._selected_session and self._selected_session.state == "active":
            self._schedule_preview_update(self._selected_session)
        self._apply_auto_follow_cursor(table, new_keys, new_map)

    def _refresh_diff_stats_selected(self: Any) -> None:
        selected = self._selected_session
        if selected is None or not selected.cwd or selected.state != "active":
            return

        session_id = selected.session_id
        if not should_refresh_diff_stats(session_id):
            return

        import subprocess

        badge = ""
        added = 0
        removed = 0
        file_count = 0

        try:
            result = subprocess.run(
                ["git", "diff", "--shortstat"],
                cwd=selected.cwd,
                capture_output=True,
                text=True,
                timeout=2,
            )
            out = result.stdout.strip()
            if out:
                files = re.search(r"(\d+) file[s]? changed", out)
                ins = re.search(r"(\d+) insertion", out)
                dels = re.search(r"(\d+) deletion", out)
                file_count = int(files.group(1)) if files else 0
                added = int(ins.group(1)) if ins else 0
                removed = int(dels.group(1)) if dels else 0
                parts: list[str] = []
                if ins:
                    parts.append(f"+{ins.group(1)}")
                if dels:
                    parts.append(f"−{dels.group(1)}")
                if parts:
                    badge = "[" + " ".join(parts) + "]"
        except Exception:
            pass

        if not badge:
            try:
                ahead_result = subprocess.run(
                    ["git", "rev-list", "--count", "@{upstream}..HEAD"],
                    cwd=selected.cwd,
                    capture_output=True,
                    text=True,
                    timeout=2,
                )
                n = ahead_result.stdout.strip()
                if n and n != "0":
                    badge = f"[↑{n}]"
            except Exception:
                pass

        self.call_from_thread(
            self._apply_diff_stats,
            [(session_id, badge, added, removed, file_count)],
        )

    def _apply_refreshed_sessions_with_smart_refresh(self: Any, sessions: list[Any]) -> None:
        global _lazy_selected_session_id

        interval = get_optimal_refresh_interval(sessions)
        self._refresh_foreground_active_interval = interval
        self._refresh_foreground_all_interval = interval

        selected = self._selected_session
        _lazy_selected_session_id = selected.session_id if selected is not None else None
        try:
            original_apply_refreshed_sessions(self, sessions)
        finally:
            _lazy_selected_session_id = None

    setattr(AgentsViewApp, "action_clear_preview_cache", _action_clear_preview_cache)
    setattr(AgentsViewApp, "on_input_changed", _on_input_changed_debounced)
    setattr(AgentsViewApp, "_schedule_preview_update", _schedule_preview_update_faster)
    setattr(AgentsViewApp, "_update_table", _update_table_differential)
    setattr(
        AgentsViewApp,
        "_refresh_diff_stats",
        work(
            thread=True,
            exclusive=True,
            group="refresh-diff-stat",
        )(_refresh_diff_stats_selected),
    )
    setattr(
        AgentsViewApp,
        "_apply_refreshed_sessions",
        _apply_refreshed_sessions_with_smart_refresh,
    )

    setattr(AgentsViewApp, "_preview_cache", _preview_cache)
    setattr(AgentsViewApp, "_get_cached_preview", staticmethod(get_cached_preview))
    setattr(AgentsViewApp, "_store_cached_preview", staticmethod(store_cached_preview))
    setattr(
        AgentsViewApp,
        "_get_optimal_refresh_interval",
        staticmethod(get_optimal_refresh_interval),
    )


_patch_app()
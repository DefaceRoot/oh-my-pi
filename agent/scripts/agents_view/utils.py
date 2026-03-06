from __future__ import annotations

import os
import json
import logging
import math
import time
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Optional
log = logging.getLogger(__name__)

_GIT_BRANCH_CACHE: dict[str, tuple[float, str]] = {}
_GIT_REPO_CACHE: dict[str, tuple[float, str]] = {}


def get_git_branch(cwd: str) -> str:
    """Return git branch for cwd by reading .git/HEAD, walking up to fs root.

    Returns empty string if no git repo or detached HEAD.
    """
    if not cwd:
        return ""
    try:
        path = Path(cwd)
        for candidate in [path] + list(path.parents):
            git = candidate / ".git"
            if git.is_file():
                # Worktree: .git is a file "gitdir: /path/to/.git/worktrees/name"
                content = git.read_text(errors="replace").strip()
                if content.startswith("gitdir:"):
                    gitdir = Path(content[len("gitdir:"):].strip())
                    head = (gitdir / "HEAD").read_text(errors="replace").strip()
                    if head.startswith("ref: refs/heads/"):
                        return head[len("ref: refs/heads/"):]
                    return ""  # detached
            elif git.is_dir():
                head = (git / "HEAD").read_text(errors="replace").strip()
                if head.startswith("ref: refs/heads/"):
                    return head[len("ref: refs/heads/"):]
                return ""  # detached
    except OSError:
        pass
    return ""


def get_git_branch_cached(cwd: str, ttl: float = 30.0) -> str:
    """Return git branch for cwd using a best-effort TTL cache."""
    if not cwd:
        return ""
    now = time.time()
    cached = _GIT_BRANCH_CACHE.get(cwd)
    if cached is not None:
        ts, branch = cached
        if now - ts < ttl:
            return branch
    branch = get_git_branch(cwd)
    _GIT_BRANCH_CACHE[cwd] = (now, branch)
    return branch

def get_git_repo_name(cwd: str) -> str:
    """Return the git repo root directory name for cwd, walking up to fs root.

    Returns empty string if no git repo found.
    """
    if not cwd:
        return ""
    try:
        path = Path(cwd)
        for candidate in [path] + list(path.parents):
            git = candidate / ".git"
            if git.is_file():
                content = git.read_text(errors="replace").strip()
                if content.startswith("gitdir:"):
                    gitdir = Path(content[len("gitdir:"):].strip())
                    return gitdir.parent.parent.parent.name
                return ""
            elif git.is_dir():
                return candidate.name
    except OSError:
        pass
    return ""


def get_git_repo_name_cached(cwd: str, ttl: float = 60.0) -> str:
    """Return git repo name for cwd using a best-effort TTL cache."""
    if not cwd:
        return ""
    now = time.time()
    cached = _GIT_REPO_CACHE.get(cwd)
    if cached is not None:
        ts, name = cached
        if now - ts < ttl:
            return name
    name = get_git_repo_name(cwd)
    _GIT_REPO_CACHE[cwd] = (now, name)
    return name


def fetch_pr_details(branch: str, repo_root: str) -> dict:
    """Fetch detailed PR info including CI checks, labels, and reviewers."""
    if not branch or not repo_root:
        return {}

    try:
        import subprocess as _sp

        result = _sp.run(
            [
                "gh",
                "pr",
                "view",
                branch,
                "--json",
                "title,number,state,url,labels,reviews,statusCheckRollup,mergeable,additions,deletions,changedFiles",
            ],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            payload = json.loads(result.stdout or "{}")
            if isinstance(payload, dict):
                return payload
    except Exception:
        pass

    return {}

# --------------------------------------------------------------------------- #
#  OMP session JSONL helpers                                                  #
# --------------------------------------------------------------------------- #

def _parse_timestamp_value(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if math.isfinite(ts) and ts > 0:
            return ts
        return None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            ts = float(raw)
        except ValueError:
            try:
                ts = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return None
        if math.isfinite(ts) and ts > 0:
            return ts
    return None


def _extract_timestamp_from_record(record: object) -> Optional[float]:
    if not isinstance(record, dict):
        return None
    for key in ("ts", "timestamp"):
        ts = _parse_timestamp_value(record.get(key))
        if ts is not None:
            return ts
    msg = record.get("message")
    if isinstance(msg, dict):
        for key in ("ts", "timestamp"):
            ts = _parse_timestamp_value(msg.get(key))
            if ts is not None:
                return ts
    return None


def parse_session_start_time(jsonl_path: str) -> Optional[float]:
    """Best-effort parse of the first timestamp in a session JSONL file."""
    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(4096)
    except OSError:
        return None

    if not head:
        return None

    for idx, raw in enumerate(head.splitlines()):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue

        ts = _extract_timestamp_from_record(obj)
        if ts is not None:
            return ts

        if idx == 0 and isinstance(obj.get("cwd"), str):
            for key in ("session", "data", "meta"):
                ts = _extract_timestamp_from_record(obj.get(key))
                if ts is not None:
                    return ts

        if obj.get("type") == "system":
            for key in ("data", "meta", "payload", "message"):
                ts = _extract_timestamp_from_record(obj.get(key))
                if ts is not None:
                    return ts

    return None

_ROLE_CANONICAL: frozenset[str] = frozenset({"default", "orchestrator"})


def extract_last_mc_role(lines: list[str]) -> str | None:
    """Return the role encoded by the LAST model_change event in *lines*.

    Mirrors OMP's ``getLastModelChangeRole()`` logic:
      - null/undefined role  → ``"default"``  (JS: ``role ?? "default"``)
      - canonical role       → ``"default"`` or ``"orchestrator"``
      - transient/config     → ``""``  (``temporary`` / ``smol`` / ``slow`` / etc.)
      - no model_change      → ``None``  (caller decides; typically leave blank)
    """
    for raw in reversed(lines):
        try:
            obj = json.loads(raw)
            if obj.get("type") == "model_change":
                r = obj.get("role")
                if r is None:
                    return "default"
                return r if r in _ROLE_CANONICAL else ""
        except json.JSONDecodeError:
            continue
    return None

def extract_last_mc_model(lines: list[str]) -> str:
    """Return model identifier from the LAST model_change event in *lines*."""
    for raw in reversed(lines):
        try:
            obj = json.loads(raw)
            if obj.get("type") == "model_change":
                return str(obj.get("model") or "")
        except json.JSONDecodeError:
            continue
    return ""

_MODELS_FILE = Path(__file__).resolve().parents[2] / "models.yml"
_MODEL_CONTEXT_DEFAULT_WINDOW = 128_000


@lru_cache(maxsize=1)
def _load_model_context_windows() -> dict[str, int]:
    """Load model context windows from agent/models.yml if available."""
    try:
        import yaml  # type: ignore[import-untyped]
    except Exception:
        return {}

    try:
        raw = _MODELS_FILE.read_text(encoding="utf-8")
    except OSError:
        return {}

    try:
        data = yaml.safe_load(raw)
    except Exception:
        return {}

    if not isinstance(data, dict):
        return {}

    providers = data.get("providers")
    if not isinstance(providers, dict):
        return {}

    windows: dict[str, int] = {}
    for provider_cfg in providers.values():
        if not isinstance(provider_cfg, dict):
            continue

        models = provider_cfg.get("models")
        if isinstance(models, list):
            for model_cfg in models:
                if not isinstance(model_cfg, dict):
                    continue
                model_id = str(model_cfg.get("id") or "").strip().lower()
                context_window = model_cfg.get("contextWindow")
                if not model_id or not isinstance(context_window, (int, float)):
                    continue
                window = int(context_window)
                if window > 0:
                    windows[model_id] = window

        model_overrides = provider_cfg.get("modelOverrides")
        if isinstance(model_overrides, dict):
            for model_id, override_cfg in model_overrides.items():
                if not isinstance(model_id, str) or not isinstance(override_cfg, dict):
                    continue
                context_window = override_cfg.get("contextWindow")
                if not isinstance(context_window, (int, float)):
                    continue
                window = int(context_window)
                if window > 0:
                    windows[model_id.strip().lower()] = window

    return windows


def context_window_for_model(model: str) -> Optional[int]:
    """Resolve model context window using OMP model config semantics."""
    model_full = (model or "").strip().lower()
    if not model_full:
        return None

    model_id = model_full.split("/")[-1]
    windows = _load_model_context_windows()

    if model_full in windows:
        return windows[model_full]
    if model_id in windows:
        return windows[model_id]

    for key, window in windows.items():
        if key and (key in model_full or key in model_id):
            return window

    return _MODEL_CONTEXT_DEFAULT_WINDOW


def format_tokens_k(tokens: int) -> str:
    return f"{max(0, round(tokens / 1_000))}k"


def _usage_context_tokens(usage: dict) -> int:
    def _to_int(value: object) -> int:
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return 0
        return 0

    return (
        _to_int(usage.get("input", 0))
        + _to_int(usage.get("output", 0))
        + _to_int(usage.get("cacheRead", 0))
        + _to_int(usage.get("cacheWrite", 0))
    )


def parse_context_usage_from_jsonl_lines(
    lines: list[str], *, fallback_model: str = ""
) -> Optional[float]:
    """Compute OMP-style context usage from assistant usage records in JSONL lines."""
    main_roles = {"default", "orchestrator"}
    tail = lines[-200:]
    current_model = fallback_model
    current_role = "default" if fallback_model else ""

    latest_usage: Optional[dict] = None
    latest_model = fallback_model
    latest_main_usage: Optional[dict] = None
    latest_main_model = fallback_model

    for raw in tail:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue

        if obj.get("type") == "model_change":
            model = str(obj.get("model") or "")
            if model:
                current_model = model
            role = obj.get("role")
            if role is None:
                current_role = "default"
            else:
                current_role = role if role in main_roles else ""
            continue

        msg = obj.get("message")
        if not (isinstance(msg, dict) and msg.get("role") == "assistant"):
            continue
        if msg.get("stopReason") == "aborted":
            continue

        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        context_tokens = _usage_context_tokens(usage)
        if context_tokens <= 0:
            continue

        msg_model = str(
            msg.get("model")
            or obj.get("model")
            or current_model
            or fallback_model
        )
        latest_usage = usage
        latest_model = msg_model
        if current_role in main_roles:
            latest_main_usage = usage
            latest_main_model = msg_model

    selected_usage = latest_main_usage or latest_usage
    selected_model = latest_main_model if latest_main_usage is not None else latest_model
    if selected_usage is None:
        return None

    context_tokens = _usage_context_tokens(selected_usage)
    if context_tokens <= 0:
        return None

    window = context_window_for_model(selected_model or fallback_model)
    if not window or window <= 0:
        return None

    return min(1.0, context_tokens / window)


_TOKEN_USAGE_TAIL_BYTES = 50 * 1024
_CLAUDE_INPUT_COST_PER_MTOK = 3.0
_CLAUDE_OUTPUT_COST_PER_MTOK = 15.0


def _read_jsonl_tail_lines_for_usage(jsonl_path: str, tail_bytes: int = _TOKEN_USAGE_TAIL_BYTES) -> list[str]:
    with open(jsonl_path, "r", errors="replace") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        if size > tail_bytes:
            fh.seek(size - tail_bytes)
            fh.readline()
        else:
            fh.seek(0)
        return fh.readlines()


def _to_int_token(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except ValueError:
            return 0
    return 0


def _extract_usage_tokens(usage: dict) -> tuple[int, int]:
    input_tokens = _to_int_token(
        usage.get("input_tokens", usage.get("inputTokens", usage.get("input", 0)))
    )
    output_tokens = _to_int_token(
        usage.get("output_tokens", usage.get("outputTokens", usage.get("output", 0)))
    )
    return (max(0, input_tokens), max(0, output_tokens))


def _parse_event_timestamp(raw_value: object) -> Optional[float]:
    if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool):
        ts = float(raw_value)
        return ts if ts > 0 else None
    if not isinstance(raw_value, str):
        return None
    raw = raw_value.strip()
    if not raw:
        return None
    try:
        ts = float(raw)
        return ts if ts > 0 else None
    except ValueError:
        pass
    try:
        from datetime import datetime
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        return ts if ts > 0 else None
    except Exception:
        return None


def _content_has_error(value: object) -> bool:
    if isinstance(value, str):
        return "error" in value.lower()
    if isinstance(value, dict):
        return any(_content_has_error(v) for v in value.values())
    if isinstance(value, list):
        return any(_content_has_error(v) for v in value)
    return False


def parse_token_usage_from_jsonl(jsonl_path: str) -> dict:
    """Parse token usage, costs, and message statistics from a session JSONL tail."""
    try:
        if not jsonl_path:
            return {}
        if not Path(jsonl_path).exists():
            return {}

        lines = _read_jsonl_tail_lines_for_usage(jsonl_path)
        if not lines:
            return {}

        total_tokens_in = 0
        total_tokens_out = 0
        tool_call_count = 0
        error_count = 0
        session_start_ts: Optional[float] = None

        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue

            message_obj = obj.get("message") if isinstance(obj.get("message"), dict) else None
            role = ""
            content: object = None
            if message_obj is not None:
                role = str(message_obj.get("role") or "")
                content = message_obj.get("content")
            else:
                role = str(obj.get("role") or "")
                content = obj.get("content")

            usage_candidates: list[dict] = []
            top_usage = obj.get("usage")
            if isinstance(top_usage, dict):
                usage_candidates.append(top_usage)
            if message_obj is not None:
                msg_usage = message_obj.get("usage")
                if isinstance(msg_usage, dict) and msg_usage is not top_usage:
                    usage_candidates.append(msg_usage)

            for usage in usage_candidates:
                tokens_in, tokens_out = _extract_usage_tokens(usage)
                total_tokens_in += tokens_in
                total_tokens_out += tokens_out

            if role == "assistant":
                blocks = content if isinstance(content, list) else [content]
                tool_call_count += sum(
                    1
                    for block in blocks
                    if isinstance(block, dict) and block.get("type") in ("tool_use", "toolCall")
                )

            has_error_status = (
                str(obj.get("status") or "").lower() == "error"
                or (
                    message_obj is not None
                    and str(message_obj.get("status") or "").lower() == "error"
                )
            )
            has_error_content = _content_has_error(content)
            if has_error_status or has_error_content:
                error_count += 1

            event_ts = _parse_event_timestamp(
                obj.get("timestamp")
                or obj.get("ts")
                or (message_obj.get("timestamp") if message_obj is not None else None)
                or (message_obj.get("ts") if message_obj is not None else None)
            )
            if event_ts is not None:
                if session_start_ts is None or event_ts < session_start_ts:
                    session_start_ts = event_ts

        cost_usd = (
            (total_tokens_in / 1_000_000) * _CLAUDE_INPUT_COST_PER_MTOK
            + (total_tokens_out / 1_000_000) * _CLAUDE_OUTPUT_COST_PER_MTOK
        )

        return {
            "total_tokens_in": total_tokens_in,
            "total_tokens_out": total_tokens_out,
            "cost_usd": cost_usd,
            "session_start_ts": session_start_ts,
            "tool_call_count": tool_call_count,
            "error_count": error_count,
        }
    except Exception:
        return {}
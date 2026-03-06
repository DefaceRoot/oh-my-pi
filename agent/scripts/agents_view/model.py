from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

WAIT_THRESHOLD_SECONDS = 30
STALL_THRESHOLD_SECONDS = 60
ASKING_COUNTDOWN_SECONDS = 30

HARNESS_LABELS: dict[str, str] = {
    "omp": "OMP",
    "claude": "Claude",
    "codex": "Codex",
    "opencode": "OpenCode",
}


@dataclass
class AgentSession:
    harness: str
    session_id: str
    title: str
    cwd: str
    state: str  # "active" | "inactive"
    tmux_session: Optional[str] = None
    tmux_window: Optional[str] = None
    tmux_pane: Optional[str] = None
    last_activity_ts: Optional[float] = None
    preview_text: str = ""
    resume_command: Optional[str] = None
    scope_match: bool = True
    branch: str = ""       # git branch name
    repo: str = ""         # git repo name (directory name of repo root)
    status: str = "unknown"  # "review"|"wait"|"waiting"|"running"|"idle"|"offline"|"unknown" + extended health statuses
    status_confidence: float = 1.0  # 0.0-1.0 confidence for status rendering
    ask_ts: Optional[float] = None  # set when status=="asking"; epoch of the ask tool_use
    role: str = ""                  # "orchestrator" | "default" | "" (non-OMP / unknown)
    model: str = ""                 # active model identifier (from model_change)
    quick_note: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    diff_shortstat: str = ""
    context_usage_pct: Optional[float] = None
    parent_session_id: Optional[str] = None
    child_session_ids: list[str] = field(default_factory=list)
    total_tokens_in: int = 0       # cumulative input tokens
    total_tokens_out: int = 0      # cumulative output tokens
    cost_usd: float = 0.0          # estimated cost in USD
    session_start_ts: Optional[float] = None   # epoch of first message
    session_duration_s: float = 0.0  # seconds since first message
    tool_call_count: int = 0       # total tool calls observed
    error_count: int = 0           # total error-bearing messages
    tokens_per_minute: float = 0.0 # rolling rate

    @property
    def harness_label(self) -> str:
        return HARNESS_LABELS.get(self.harness, self.harness.upper())

    @property
    def age_str(self) -> str:
        if self.last_activity_ts is None:
            return "?"
        delta = time.time() - self.last_activity_ts
        if delta < 60:
            return f"{int(delta)}s"
        if delta < 3600:
            return f"{int(delta / 60)}m"
        if delta < 86400:
            return f"{int(delta / 3600)}h"
        return f"{int(delta / 86400)}d"

    @property
    def elapsed_str(self) -> str:
        if self.session_start_ts is None:
            return ""
        delta = time.time() - self.session_start_ts
        if delta < 60:
            return ""
        h = int(delta // 3600)
        m = int((delta % 3600) // 60)
        if h >= 24:
            d = h // 24
            return f"{d}d{h % 24:02d}h"
        if h > 0:
            return f"{h}h{m:02d}m"
        return f"{m}m"

    @staticmethod
    def _format_token_total(tokens: int) -> str:
        value = max(0, int(tokens))
        if value >= 1_000:
            return f"{value / 1_000:.1f}k"
        return str(value)

    @property
    def cost_str(self) -> str:
        if self.cost_usd <= 0:
            return "—"
        return f"${self.cost_usd:.4f}"

    @property
    def duration_str(self) -> str:
        if self.session_duration_s <= 0:
            return "—"
        seconds = max(0, int(self.session_duration_s))
        if seconds < 60:
            return f"{seconds}s"
        if seconds < 3600:
            return f"{seconds // 60}m"
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        return f"{hours}h{minutes}m"

    @property
    def tokens_str(self) -> str:
        if self.total_tokens_in <= 0 and self.total_tokens_out <= 0:
            return "—"
        tokens_in = self._format_token_total(self.total_tokens_in)
        tokens_out = self._format_token_total(self.total_tokens_out)
        return f"{tokens_in} in / {tokens_out} out"

    @property
    def display_title(self) -> str:
        base = self.title if self.title else self.cwd
        note = self.quick_note.strip()
        if not note:
            return base
        return f"{base} [{note}]"

    @property
    def tags_str(self) -> str:
        return ", ".join(self.tags) if self.tags else ""

    def has_tag(self, tag: str) -> bool:
        needle = tag.strip().lower()
        if not needle:
            return False
        return any(existing.strip().lower() == needle for existing in self.tags)
    @property
    def status_rich(self) -> tuple[str, str]:
        import time as _t

        now = _t.time()
        if self.status == "asking":
            if self.ask_ts is not None:
                elapsed = max(0, int(now - self.ask_ts))
                if elapsed >= STALL_THRESHOLD_SECONDS:
                    return ("! INPUT", "bold #f85149")
                remaining = max(0, ASKING_COUNTDOWN_SECONDS - elapsed)
                return (f"INPUT {remaining}s", "bold #e8b84b")
            return ("● INPUT", "bold #e8b84b")

        if self.status in ("review", "waiting"):
            return ("◍ REVIEW", "bold #79c0ff")

        if self.status == "wait":
            return ("⏳ WAIT", "bold #d4a72c")

        return {
            "running": ("⚡ RUN ", "bold #57c4f8"),
            "delegating": ("⚡ RUN ", "bold #57c4f8"),
            "test_running": ("▷ TEST", "bold #57c4f8"),
            "build_running": ("⚙ BUILD", "bold #d4a72c"),
            "git_operation": ("⎇ GIT", "bold #79c0ff"),
            "agent_done": ("✓ DONE", "bold #3fb950"),
            "error_state": ("✗ ERR", "bold #f85149"),
            "rate_limited": ("⊘ RATE", "bold #f0883e"),
            "idle": ("○ IDLE", "#636e7b"),
            "offline": ("○ OFF ", "#3d4451"),
            "stalled": ("● STALL", "bold #f85149"),
        }.get(self.status, ("? ????", "#636e7b"))

    @property
    def role_rich(self) -> tuple[str, str]:
        """Returns (label, style) for the ROLE column."""
        if self.role == "orchestrator":
            return ("⬡ ORCH", "bold #f0883e")   # orange
        if self.role == "default":
            return ("◈ DEF ", "bold #539bf5")   # blue (trailing space for width=7)
        return ("     ", "#444c56")              # empty dim for non-OMP / unset
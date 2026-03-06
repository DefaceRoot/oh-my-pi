from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from agents_view.adapters.base import BaseAdapter
from agents_view.model import AgentSession

log = logging.getLogger(__name__)

_CANDIDATE_PATHS = [
    Path("~/.codex").expanduser(),
    Path("~/.local/share/codex").expanduser(),
    Path("~/.config/codex").expanduser(),
]


class CodexAdapter(BaseAdapter):
    def list_active(self, scope_root: str) -> list[AgentSession]:
        return []

    def list_inactive(self, scope_root: str, limit: int = 5) -> list[AgentSession]:
        store: Optional[Path] = None
        for candidate in _CANDIDATE_PATHS:
            if candidate.exists():
                store = candidate
                break

        if store is None:
            log.debug(
                "CodexAdapter: no known Codex store found (checked %s)",
                ", ".join(str(p) for p in _CANDIDATE_PATHS),
            )
            return []

        # Store exists but we have no known session format to parse.
        log.debug("CodexAdapter: store found at %s but no format recognised", store)
        return []

    def build_resume_command(self, session: AgentSession) -> Optional[str]:
        return None

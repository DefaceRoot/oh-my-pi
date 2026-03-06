from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from agents_view.adapters.base import BaseAdapter
from agents_view.model import AgentSession

log = logging.getLogger(__name__)

_CANDIDATE_PATHS = [
    Path("~/.local/share/opencode").expanduser(),
    Path("~/.config/opencode").expanduser(),
]


class OpenCodeAdapter(BaseAdapter):
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
                "OpenCodeAdapter: no known OpenCode store found (checked %s)",
                ", ".join(str(p) for p in _CANDIDATE_PATHS),
            )
            return []

        log.debug("OpenCodeAdapter: store found at %s but no format recognised", store)
        return []

    def build_resume_command(self, session: AgentSession) -> Optional[str]:
        return None

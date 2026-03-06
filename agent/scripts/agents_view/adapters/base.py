from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from agents_view.model import AgentSession


def scope_matches(cwd: str, scope_root: str) -> bool:
    """Return True if cwd falls within scope_root."""
    if scope_root == "/":
        return True
    normalized = scope_root.rstrip("/")
    return cwd == normalized or cwd.startswith(normalized + "/")


class BaseAdapter(ABC):
    @abstractmethod
    def list_active(self, scope_root: str) -> list[AgentSession]:
        ...

    @abstractmethod
    def list_inactive(self, scope_root: str, limit: int = 5) -> list[AgentSession]:
        ...

    @abstractmethod
    def build_resume_command(self, session: AgentSession) -> Optional[str]:
        ...

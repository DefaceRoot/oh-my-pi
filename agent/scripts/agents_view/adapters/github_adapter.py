"""GitHub PR status adapter using the `gh` CLI."""
from __future__ import annotations

import json
import logging
import subprocess
import time
from typing import Optional

log = logging.getLogger(__name__)

_CACHE_TTL = 60.0  # seconds


class PRInfo:
    """A single PR record."""

    __slots__ = ("number", "title", "state", "draft", "url", "ci_status", "reviews")

    def __init__(
        self,
        number: int,
        title: str,
        state: str,
        draft: bool,
        url: str,
        ci_status: str = "",
        reviews: str = "",
    ) -> None:
        self.number = number
        self.title = title
        self.state = state
        self.draft = draft
        self.url = url
        self.ci_status = ci_status
        self.reviews = reviews

    @property
    def ci_glyph(self) -> str:
        return {
            "success": "✔",
            "failure": "✘",
            "pending": "●",
            "neutral": "○",
        }.get(self.ci_status.lower(), "━")

    @property
    def review_glyph(self) -> str:
        return {
            "approved": "✔",
            "changes_requested": "!",
            "review_required": "○",
            "": "—",
        }.get(self.reviews.lower(), "—")


class GitHubAdapter:
    """Lazy-fetching GitHub PR status with 60s cache."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, list[PRInfo]]] = {}  # cwd → (ts, prs)

    def _derive_owner_repo(self, cwd: str) -> Optional[str]:
        """Extract 'owner/repo' from git remote origin in cwd."""
        try:
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=3,
            )
            url = result.stdout.strip()
            if not url:
                return None
            if url.startswith("git@github.com:"):
                return url[len("git@github.com:") :].removesuffix(".git")
            if "github.com/" in url:
                path = url.split("github.com/", 1)[1].removesuffix(".git")
                return path
            return None
        except Exception:
            return None

    def list_prs(self, cwd: str) -> list[PRInfo]:
        """Return PR list for the repo in cwd, using 60s cache."""
        now = time.time()
        cached = self._cache.get(cwd)
        if cached and (now - cached[0]) < _CACHE_TTL:
            return cached[1]

        owner_repo = self._derive_owner_repo(cwd)
        if not owner_repo:
            return []

        try:
            result = subprocess.run(
                [
                    "gh",
                    "pr",
                    "list",
                    "--repo",
                    owner_repo,
                    "--json",
                    "number,title,state,isDraft,url,statusCheckRollup,reviewDecision",
                    "--limit",
                    "20",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                log.debug("gh pr list failed: %s", result.stderr[:200])
                return []

            prs_raw = json.loads(result.stdout)
            prs: list[PRInfo] = []
            for p in prs_raw:
                checks = p.get("statusCheckRollup") or []
                if isinstance(checks, list):
                    conclusions = [
                        c.get("conclusion", "").lower()
                        for c in checks
                        if c.get("conclusion")
                    ]
                    if "failure" in conclusions:
                        ci = "failure"
                    elif "pending" in conclusions or any(
                        c.get("status", "").lower() == "in_progress" for c in checks
                    ):
                        ci = "pending"
                    elif conclusions:
                        ci = "success"
                    else:
                        ci = "neutral"
                else:
                    ci = str(checks).lower() if checks else ""

                prs.append(
                    PRInfo(
                        number=p.get("number", 0),
                        title=p.get("title", ""),
                        state=p.get("state", ""),
                        draft=p.get("isDraft", False),
                        url=p.get("url", ""),
                        ci_status=ci,
                        reviews=p.get("reviewDecision", "") or "",
                    )
                )

            self._cache[cwd] = (now, prs)
            return prs
        except Exception as exc:
            log.debug("gh pr list error: %s", exc)
            return []

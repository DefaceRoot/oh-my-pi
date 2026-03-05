#!/usr/bin/env bash
# Rebase defaceroot/custom onto upstream/main.
# Run this whenever upstream releases a new version.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[rebase-upstream] Fetching upstream..."
git fetch upstream

echo "[rebase-upstream] Current branch: $(git branch --show-current)"
if [ "$(git branch --show-current)" != "defaceroot/custom" ]; then
  echo "ERROR: must be on defaceroot/custom branch" >&2
  exit 1
fi

echo "[rebase-upstream] Rebasing onto upstream/main..."
git rebase upstream/main

echo "[rebase-upstream] Running tests..."
~/.bun/bin/bun test

echo "[rebase-upstream] Done. Review changes, then push with: git push --force-with-lease"

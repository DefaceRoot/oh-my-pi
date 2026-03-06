#!/usr/bin/env bash
# sync-omp.sh — Pull latest config from git and upgrade OMP to latest version.
# Run this periodically to stay current with your config changes and upstream OMP updates.
#
# Usage: ~/.omp/agent/scripts/sync-omp.sh
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Pulling latest config from git..."
if ! git -C "$AGENT_DIR" pull; then
  echo "ERROR: git pull failed (merge conflict?). Resolve manually before running again."
  exit 1
fi

echo "==> Upgrading OMP to latest version..."
bun upgrade -g @oh-my-pi/pi-coding-agent

echo "==> Re-applying patches..."
for patch_script in "$AGENT_DIR"/patches/*/manage.sh; do
  [ -f "$patch_script" ] || continue
  patch_name=$(dirname "$patch_script" | xargs basename)
  echo "    Applying: $patch_name"
  if ! bash "$patch_script" apply 2>&1; then
    echo "    Retrying with --force..."
    bash "$patch_script" apply --force 2>&1 || echo "    WARNING: patch failed for $patch_name — check manually"
  fi
done

echo ""
echo "==> Done. Restart OMP to load all changes."

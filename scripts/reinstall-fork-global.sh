#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
TARBALL_DIR=$(mktemp -d)
trap 'rm -rf -- "$TARBALL_DIR"' EXIT

PACKAGES=(utils natives ai agent tui stats coding-agent)
GLOBAL_PACKAGES=(
  @oh-my-pi/pi-coding-agent
  @oh-my-pi/pi-utils
  @oh-my-pi/pi-natives
  @oh-my-pi/pi-ai
  @oh-my-pi/pi-agent-core
  @oh-my-pi/pi-tui
  @oh-my-pi/omp-stats
)

pack_workspace() {
  local pkg="$1"
  (
    cd "$ROOT_DIR/packages/$pkg"
    bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
  )
}

find_tarball() {
  local pattern="$1"
  local matches=()
  shopt -s nullglob
  matches=( $pattern )
  shopt -u nullglob

  if [[ ${#matches[@]} -ne 1 ]]; then
    echo "Expected exactly one tarball for pattern: $pattern" >&2
    exit 1
  fi

  printf '%s\n' "${matches[0]}"
}

echo "Packing local workspace packages for global install..."
for pkg in "${PACKAGES[@]}"; do
  pack_workspace "$pkg"
done

utils_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-utils-*.tgz)
natives_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-*.tgz)
ai_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-ai-*.tgz)
agent_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-agent-core-*.tgz)
tui_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-tui-*.tgz)
stats_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz)
coding_agent_tgz=$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-coding-agent-*.tgz)

echo "Removing previous global fork packages..."
bun remove -g "${GLOBAL_PACKAGES[@]}" >/dev/null 2>&1 || true

echo "Installing packed fork tarballs globally..."
bun add -g \
  "$utils_tgz" \
  "$natives_tgz" \
  "$ai_tgz" \
  "$agent_tgz" \
  "$tui_tgz" \
  "$stats_tgz" \
  "$coding_agent_tgz"

bash "$SCRIPT_DIR/install.sh" --verify-path-precedence

echo "Fork global reinstall complete"

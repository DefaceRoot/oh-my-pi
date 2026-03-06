#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
AGENT_SOURCE="$REPO_ROOT/agent"
AGENT_LINK="$HOME/.omp/agent"
BACKUP_PATH=""

info()  { echo "[INFO]  $*"; }
ok()    { echo "[OK]    $*"; }
warn()  { echo "[WARN]  $*"; }
error() { echo "[ERROR] $*" >&2; }
hr()    { echo "────────────────────────────────────────────"; }

ensure_bun() {
  hr
  info "Checking Bun installation..."

  if command -v bun >/dev/null 2>&1; then
    ok "Bun already in PATH: $(command -v bun)"
    bun --version | head -1
    return
  fi

  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
    ok "Bun found at $HOME/.bun/bin/bun"
    bun --version | head -1
    return
  fi

  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ok "Bun installed"
  bun --version | head -1
}

sync_agent_symlink() {
  hr
  info "Ensuring ~/.omp/agent points at this fork..."

  mkdir -p "$HOME/.omp"

  if [[ -L "$AGENT_LINK" ]]; then
    local current_target
    current_target="$(readlink "$AGENT_LINK")"
    if [[ "$current_target" == "$AGENT_SOURCE" ]]; then
      ok "~/.omp/agent already points to $AGENT_SOURCE"
      return
    fi

    warn "Replacing symlink target $current_target"
    rm "$AGENT_LINK"
    ln -s "$AGENT_SOURCE" "$AGENT_LINK"
    ok "Updated ~/.omp/agent symlink"
    return
  fi

  if [[ -e "$AGENT_LINK" ]]; then
    BACKUP_PATH="$HOME/.omp/agent.backup-$(date +%Y%m%d%H%M%S)"
    warn "Backing up existing ~/.omp/agent to $BACKUP_PATH"
    mv "$AGENT_LINK" "$BACKUP_PATH"
  fi

  ln -s "$AGENT_SOURCE" "$AGENT_LINK"
  ok "Created ~/.omp/agent -> $AGENT_SOURCE"
}

reinstall_fork() {
  hr
  info "Installing repo dependencies..."
  bun --cwd="$REPO_ROOT" install

  hr
  info "Reinstalling omp globally from this fork..."
  bun --cwd="$REPO_ROOT" run reinstall:fork
  ok "Fork reinstall complete"
}

print_summary() {
  hr
  ok "Setup complete"
  echo ""
  echo "Repo root: $REPO_ROOT"
  echo "Agent source: $AGENT_SOURCE"
  echo "Live agent path: $AGENT_LINK"
  if [[ -n "$BACKUP_PATH" ]]; then
    echo "Backup created: $BACKUP_PATH"
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Launch omp"
  echo "  2. Verify command -v omp prints ~/.bun/bin/omp"
  echo "  3. Follow $REPO_ROOT/UPDATING.md for future updates"
}

if [[ ! -d "$AGENT_SOURCE" ]]; then
  error "Expected repo-managed agent directory at $AGENT_SOURCE"
  exit 1
fi

ensure_bun
sync_agent_symlink
reinstall_fork
print_summary

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
AGENT_SOURCE="$REPO_ROOT/agent"
AGENT_LINK="$HOME/.omp/agent"
LAUNCHER_SOURCE="$REPO_ROOT/omp"
LAUNCHER_LINK="$HOME/.local/bin/omp"
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

install_repo_dependencies() {
  hr
  info "Installing repo dependencies..."
  bun --cwd="$REPO_ROOT" install
  ok "Dependencies installed"
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

install_launcher_symlink() {
  hr
  info "Ensuring omp points at this fork launcher..."

  mkdir -p "$(dirname "$LAUNCHER_LINK")"

  if [[ -L "$LAUNCHER_LINK" ]]; then
    local current_target
    current_target="$(readlink "$LAUNCHER_LINK")"
    if [[ "$current_target" == "$LAUNCHER_SOURCE" ]]; then
      ok "$LAUNCHER_LINK already points to $LAUNCHER_SOURCE"
      return
    fi

    warn "Replacing launcher symlink target $current_target"
    rm "$LAUNCHER_LINK"
    ln -s "$LAUNCHER_SOURCE" "$LAUNCHER_LINK"
    ok "Updated omp launcher symlink"
    return
  fi

  if [[ -e "$LAUNCHER_LINK" ]]; then
    error "$LAUNCHER_LINK already exists and is not a symlink. Move it aside and rerun setup."
    exit 1
  fi

  ln -s "$LAUNCHER_SOURCE" "$LAUNCHER_LINK"
  ok "Created $LAUNCHER_LINK -> $LAUNCHER_SOURCE"
}

print_summary() {
  hr
  ok "Setup complete"
  echo ""
  echo "Repo root: $REPO_ROOT"
  echo "Agent source: $AGENT_SOURCE"
  echo "Live agent path: $AGENT_LINK"
  echo "Launcher path: $LAUNCHER_LINK"
  if [[ -n "$BACKUP_PATH" ]]; then
    echo "Backup created: $BACKUP_PATH"
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Verify command -v omp prints ~/.local/bin/omp or $REPO_ROOT/omp"
  echo "  2. Restart any running omp session"
  echo "  3. Follow $REPO_ROOT/UPDATING.md for future updates"
}

if [[ ! -d "$AGENT_SOURCE" ]]; then
  error "Expected repo-managed agent directory at $AGENT_SOURCE"
  exit 1
fi

if [[ ! -x "$LAUNCHER_SOURCE" ]]; then
  error "Expected executable fork launcher at $LAUNCHER_SOURCE"
  exit 1
fi

ensure_bun
install_repo_dependencies
sync_agent_symlink
install_launcher_symlink
print_summary

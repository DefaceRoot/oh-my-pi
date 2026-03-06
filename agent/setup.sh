#!/usr/bin/env bash
# Pi Coding Agent — Bootstrap Setup Script
# Run this on a fresh machine to reproduce the full OMP environment.
# Safe to run multiple times (idempotent).
set -euo pipefail

REPO_URL="git@github.com:DefaceRoot/Pi-Coding-Agent.git"
AGENT_DIR="$HOME/.omp/agent"
OMP_VERSION="13.3.6"
OMP_VERSION_PREFIX="13"
PATCH_NAME="implement-workflow-clickable-v11.7.2"
PATCH_SCRIPT="$AGENT_DIR/patches/$PATCH_NAME/manage.sh"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo "[INFO]  $*"; }
ok()    { echo "[OK]    $*"; }
warn()  { echo "[WARN]  $*"; }
error() { echo "[ERROR] $*" >&2; }
hr()    { echo "────────────────────────────────────────────"; }

# ── 1. Bun ───────────────────────────────────────────────────────────────────
hr
info "Checking Bun installation..."

if ! command -v bun &>/dev/null; then
  if [[ -f "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
    ok "Bun found at $HOME/.bun/bin/bun"
  else
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    ok "Bun installed"
  fi
else
  ok "Bun already in PATH: $(command -v bun)"
fi

# Source bun env in case the shell hasn't picked it up yet
if [[ -f "$HOME/.bun/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.bun/env"
fi

bun --version | head -1

# ── 2. Oh My Pi (OMP) ────────────────────────────────────────────────────────
hr
info "Checking OMP installation (target: v${OMP_VERSION})..."

install_omp() {
  info "Installing @oh-my-pi/pi-coding-agent@${OMP_VERSION}..."
  bun install -g "@oh-my-pi/pi-coding-agent@${OMP_VERSION}"
  ok "OMP installed"
}

if command -v omp &>/dev/null; then
  INSTALLED_VER=$(omp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
  if [[ "$INSTALLED_VER" == "$OMP_VERSION" ]]; then
    ok "OMP v${INSTALLED_VER} already installed — skipping"
  else
    warn "OMP v${INSTALLED_VER} installed, expected v${OMP_VERSION}. Reinstalling..."
    install_omp
  fi
else
  install_omp
fi

# ── 3. Clone / update agent config repo ──────────────────────────────────────
hr
info "Setting up agent config repo at $AGENT_DIR..."

mkdir -p "$HOME/.omp"

if [[ -d "$AGENT_DIR/.git" ]]; then
  info "Repo already exists — pulling latest master..."
  git -C "$AGENT_DIR" fetch origin
  git -C "$AGENT_DIR" checkout master
  git -C "$AGENT_DIR" merge --ff-only origin/master || {
    warn "Fast-forward merge failed. Local changes may conflict with origin."
    warn "Resolve manually in $AGENT_DIR"
  }
  ok "Agent config up to date"
else
  info "Cloning $REPO_URL → $AGENT_DIR"
  git clone "$REPO_URL" "$AGENT_DIR"
  git -C "$AGENT_DIR" checkout master
  ok "Repo cloned"
fi

# ── 4. Settings (API keys) ────────────────────────────────────────────────────
hr
info "Checking settings.json..."

SETTINGS_FILE="$AGENT_DIR/settings.json"
SETTINGS_TEMPLATE="$AGENT_DIR/settings.template.json"

if [[ -f "$SETTINGS_FILE" ]]; then
  ok "settings.json already exists — skipping"
else
  if [[ -f "$SETTINGS_TEMPLATE" ]]; then
    cp "$SETTINGS_TEMPLATE" "$SETTINGS_FILE"
    warn "Created settings.json from template."
    warn "REQUIRED: Edit $SETTINGS_FILE and fill in your API keys:"
    warn "  - ZAI_API_KEY"
    warn "  - BTCA_API_KEY"
    warn "OMP will not function correctly until this is done."
  else
    error "settings.template.json not found — cannot create settings.json"
    error "Create $SETTINGS_FILE manually before launching OMP."
  fi
fi

# ── 5. MCP configuration ──────────────────────────────────────────────────────
hr
info "MCP configuration..."

MCP_FILE="$AGENT_DIR/mcp.json"
MCP_TEMPLATE="$AGENT_DIR/mcp.template.json"

if [[ -f "$MCP_FILE" ]]; then
  ok "mcp.json already present"
  # Check if it still has the placeholder
  if grep -q "REPLACE_WITH_YOUR_BTCA_KEY" "$MCP_FILE" 2>/dev/null; then
    warn "mcp.json contains a placeholder BTCA key."
    warn "Edit $MCP_FILE and set your real BTCA Bearer token."
  fi
else
  if [[ -f "$MCP_TEMPLATE" ]]; then
    cp "$MCP_TEMPLATE" "$MCP_FILE"
    warn "Created mcp.json from template."
    warn "Edit $MCP_FILE and replace '<REPLACE_WITH_YOUR_BTCA_KEY>' with your BTCA token."
    warn "Get your token at: https://btca.dev"
  else
    error "Neither mcp.json nor mcp.template.json found."
    error "Create $MCP_FILE manually — see mcp.template.json in the repo for the structure."
  fi
fi

# ── 6. Apply patches ─────────────────────────────────────────────────────────
hr
info "Applying OMP patches ($PATCH_NAME)..."

if [[ ! -f "$PATCH_SCRIPT" ]]; then
  error "Patch script not found: $PATCH_SCRIPT"
  error "Ensure the repo was cloned correctly."
  exit 1
fi

# Check current patch status
PATCH_STATUS=$(bash "$PATCH_SCRIPT" status 2>&1 || true)
if echo "$PATCH_STATUS" | grep -qi "applied\|present\|ok"; then
  ok "Patches already applied — skipping"
else
  info "Applying patches..."
  if bash "$PATCH_SCRIPT" apply 2>&1; then
    ok "Patches applied successfully"
  else
    warn "Patch apply failed. This usually means OMP version mismatch."
    warn "Expected version prefix: ${OMP_VERSION_PREFIX}.x"
    warn "Try: bash $PATCH_SCRIPT apply --force"
    warn "Or reinstall OMP: bun install -g @oh-my-pi/pi-coding-agent@${OMP_VERSION}"
  fi
fi

# ── 7. Python dependencies (agents-view) ─────────────────────────────────────
hr
info "Installing Python dependencies for agents-view..."

REQ_FILE="$AGENT_DIR/scripts/agents_view/requirements.txt"

if ! command -v python3 &>/dev/null; then
  warn "python3 not found — skipping agents-view dependency install."
  warn "Install Python 3.10+ and run: pip3 install -r $REQ_FILE"
else
  PY_VER=$(python3 --version 2>&1)
  info "Using $PY_VER"
  if python3 -m pip install -r "$REQ_FILE" --quiet; then
    ok "Python dependencies installed"
  else
    warn "pip install failed. Try: pip3 install -r $REQ_FILE"
  fi
fi

# ── 8. ompa command (agents-view launcher) ───────────────────────────────────
hr
info "Installing ompa command..."

OMPA_SRC="$AGENT_DIR/bin/ompa"
OMPA_DEST="$HOME/.local/bin/ompa"

mkdir -p "$HOME/.local/bin"

if [[ ! -f "$OMPA_SRC" ]]; then
  warn "bin/ompa not found in repo — skipping ompa install"
else
  cp "$OMPA_SRC" "$OMPA_DEST"
  chmod +x "$OMPA_DEST"
  ok "ompa installed to $OMPA_DEST"
  # Remind if ~/.local/bin is not on PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
    warn "~/.local/bin is not in your PATH."
    warn "Add this to ~/.bashrc or ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ── 9. Tmux hooks (agents-view auto-start) ───────────────────────────────────
hr
info "Setting up tmux agents-view hooks..."

AGENTS_MANAGER="$AGENT_DIR/scripts/agents-view-manager.sh"

if [[ ! -f "$AGENTS_MANAGER" ]]; then
  warn "agents-view-manager.sh not found — skipping tmux hook setup"
elif ! command -v tmux &>/dev/null; then
  warn "tmux not found — install tmux to use the agents-view auto-start feature"
else
  # Install session-created hook so agents-view window appears in every new session
  if tmux show-hooks -g 2>/dev/null | grep -q 'agents-view-manager'; then
    ok "Tmux agents-view hook already installed"
  else
    tmux set-hook -g session-created \
      "run-shell '$AGENTS_MANAGER ensure \"#{session_name}\"'" 2>/dev/null && \
      ok "Tmux session-created hook installed" || \
      warn "Could not install tmux hook (no server running?). Run once inside tmux: $AGENTS_MANAGER ensure-all"
  fi
  # Ensure existing sessions also get the agents-view window
  if tmux list-sessions &>/dev/null 2>&1; then
    bash "$AGENTS_MANAGER" ensure-all 2>/dev/null && \
      ok "Agents view ensured in all existing tmux sessions" || \
      warn "Could not ensure agents-view in existing sessions — run: $AGENTS_MANAGER ensure-all"
  fi
fi

# ── 10. Tmux session browser keybinding ──────────────────────────────────────
hr
info "Setting up tmux session browser keybinding (prefix + S)..."

TMUX_LOCAL="$HOME/.tmux.conf.local"
SESSION_BROWSER="$AGENT_DIR/scripts/session-browser.sh"
KEYBINDING="bind S display-popup -E -w '85%' -h '80%' \"$SESSION_BROWSER\""

if grep -q 'session-browser.sh' "$TMUX_LOCAL" 2>/dev/null; then
  ok "Session browser keybinding already in $TMUX_LOCAL"
elif grep -q 'session-browser.sh' "$HOME/.tmux.conf" 2>/dev/null; then
  warn "session-browser.sh found in ~/.tmux.conf — move it to $TMUX_LOCAL (oh-my-tmux compatibility)"
elif [[ -f "$TMUX_LOCAL" ]]; then
  printf '\n# OMP session browser -- open with prefix + S\n%s\n' "$KEYBINDING" >> "$TMUX_LOCAL"
  ok "Session browser keybinding added to $TMUX_LOCAL"
  info "Reload with: tmux source-file ~/.tmux.conf"
else
  info "No ~/.tmux.conf.local found. Add this to your tmux config manually:"
  echo "  $KEYBINDING"
fi

# ── 11. SSH key reminder ─────────────────────────────────────────────────────
hr
info "SSH / remote host configuration..."

SSH_KEY="$HOME/.ssh/omp_esxi_rsa"
if [[ -f "$SSH_KEY" ]]; then
  ok "ESXi SSH key found at $SSH_KEY"
else
  warn "ESXi SSH key not found at $SSH_KEY"
  warn "If you use remote SSH features (ESXi host), copy your private key there:"
  warn "  scp your-key $SSH_KEY && chmod 600 $SSH_KEY"
  warn "Host config is in: $AGENT_DIR/ssh.json"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
hr
ok "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. If this is a fresh install, edit: $SETTINGS_FILE"
echo "     Add your ZAI_API_KEY and BTCA_API_KEY."
echo "  2. Verify mcp.json has a valid BTCA Bearer token: $MCP_FILE"
echo "  3. Launch OMP from any project directory: omp"
echo "  4. Launch the agents-view dashboard: ompa"
echo "  5. Session browser (in tmux): prefix + S"
echo ""
echo "To update patches after an OMP upgrade:"
echo "  bash $PATCH_SCRIPT restore   # revert patched files"
echo "  bun install -g @oh-my-pi/pi-coding-agent@<new-version>"
echo "  bash $PATCH_SCRIPT apply     # re-apply patches"
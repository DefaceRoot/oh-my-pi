#!/usr/bin/env bash
# install-omp-config.sh — Bootstrap OMP + this config repo on a new machine.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/scripts/install-omp-config.sh | bash
#   OR after cloning:
#   bash ~/.omp/agent/scripts/install-omp-config.sh
#
# What it does:
#   1. Checks required tools (bun, git, tmux, fzf)
#   2. Installs OMP globally via bun
#   3. Sets up ~/.omp/agent/ from this git repo
#   4. Creates settings.json from template (prompts for API keys)
#   5. Relies on runtime workflow changes shipped directly with OMP package source
#   6. Adds tmux session browser keybinding
set -euo pipefail

REPO_URL="${OMP_CONFIG_REPO:-}"  # Set OMP_CONFIG_REPO env var or it will prompt
AGENT_DIR="$HOME/.omp/agent"
TMUX_CONF="$HOME/.tmux.conf"

# ─── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}WARNING:${NC} $*"; }
error()   { echo -e "${RED}ERROR:${NC} $*"; exit 1; }

# ─── 1. Check dependencies ─────────────────────────────────────────────────
info "Checking dependencies..."
MISSING=()
for cmd in bun git tmux; do
  command -v "$cmd" &>/dev/null || MISSING+=("$cmd")
done
if ! command -v fzf &>/dev/null; then
  warn "fzf not found. Session browser won't work. Install: sudo dnf install fzf (Fedora) or brew install fzf (macOS)"
fi
if [ ${#MISSING[@]} -gt 0 ]; then
  error "Missing required tools: ${MISSING[*]}. Install them first."
fi

# ─── 2. Install OMP ────────────────────────────────────────────────────────
if command -v omp &>/dev/null; then
  info "OMP already installed. Upgrading..."
  bun upgrade -g @oh-my-pi/pi-coding-agent
else
  info "Installing OMP..."
  bun install -g @oh-my-pi/pi-coding-agent
fi

# ─── 3. Clone / update config repo ────────────────────────────────────────
if [ -d "$AGENT_DIR/.git" ]; then
  info "Config repo already exists at $AGENT_DIR. Pulling latest..."
  git -C "$AGENT_DIR" pull
else
  if [ -z "$REPO_URL" ]; then
    echo -n "Enter your OMP config git repo URL (e.g. git@github.com:you/omp-config.git): "
    read -r REPO_URL
  fi
  if [ -d "$AGENT_DIR" ] && [ "$(ls -A "$AGENT_DIR")" ]; then
    warn "$AGENT_DIR already exists and is not empty."
    echo -n "Back it up and replace? [y/N]: "
    read -r confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || error "Aborted. Manually back up $AGENT_DIR first."
    mv "$AGENT_DIR" "${AGENT_DIR}.bak.$(date +%Y%m%d-%H%M%S)"
    warn "Backed up old agent dir"
  fi
  mkdir -p "$(dirname "$AGENT_DIR")"
  info "Cloning config repo to $AGENT_DIR..."
  git clone "$REPO_URL" "$AGENT_DIR"
fi

# ─── 4. Settings / secrets ────────────────────────────────────────────────
if [ ! -f "$AGENT_DIR/settings.json" ]; then
  if [ -f "$AGENT_DIR/settings.template.json" ]; then
    info "Creating settings.json from template..."
    cp "$AGENT_DIR/settings.template.json" "$AGENT_DIR/settings.json"
    warn "Edit $AGENT_DIR/settings.json and replace all <REPLACE_WITH_YOUR_KEY> values with real API keys."
    warn "Required keys: ZAI_API_KEY, BTCA_API_KEY (and any others in the template)"
  else
    warn "No settings.template.json found. Create $AGENT_DIR/settings.json manually."
  fi
else
  info "settings.json already exists, skipping."
fi

# ─── 5. Runtime workflow model ───────────────────────────────────────────
info "Runtime workflow changes now come directly from OMP package source; restart omp after upgrades to load updates."


# ─── 6. Tmux session browser keybinding ────────────────────────────────────
# oh-my-tmux users: write to .tmux.conf.local (NOT .tmux.conf which uses cut -c3- shell embedding)
TMUX_LOCAL="$HOME/.tmux.conf.local"
KEYBINDING="bind S display-popup -E -w '85%' -h '80%' \"$AGENT_DIR/scripts/session-browser.sh\""

# Check both files to avoid duplicates
if grep -q "session-browser.sh" "$TMUX_CONF" 2>/dev/null; then
  warn "session-browser.sh found in $TMUX_CONF — this will cause tmux errors with oh-my-tmux!"
  warn "Remove it from $TMUX_CONF and add to $TMUX_LOCAL instead."
elif grep -q "session-browser.sh" "$TMUX_LOCAL" 2>/dev/null; then
  info "Tmux session browser keybinding already present in $TMUX_LOCAL"
elif [ -f "$TMUX_LOCAL" ]; then
  info "Adding tmux session browser keybinding (prefix + S) to $TMUX_LOCAL..."
  echo "" >> "$TMUX_LOCAL"
  echo "# OMP session browser -- open with prefix + S" >> "$TMUX_LOCAL"
  echo "$KEYBINDING" >> "$TMUX_LOCAL"
  info "Reload tmux: tmux source-file $TMUX_CONF"
else
  info "No .tmux.conf.local found. Add this line to your tmux config manually:"
  echo "  $KEYBINDING"
fi

# ─── 7. Agents View manager tmux hooks ─────────────────────────────────────
AGENTS_MANAGER="$AGENT_DIR/scripts/agents-view-manager.sh"
if [ -f "$AGENTS_MANAGER" ]; then
	if tmux list-sessions &>/dev/null; then
		# Set up tmux hooks to ensure Agents View exists in all current + new sessions
		if ! tmux show-hooks -g 2>/dev/null | grep -q 'agents-view-manager'; then
			tmux set-hook -g session-created "run-shell '$AGENTS_MANAGER ensure \"#{session_name}\"'" 2>/dev/null || true
			info "Agents View: tmux session-created hook installed."
		else
			info "Agents View: tmux hook already present."
		fi
		# Ensure existing sessions
		bash "$AGENTS_MANAGER" ensure-all 2>/dev/null || warn "Could not ensure Agents View in existing sessions (run manually: $AGENTS_MANAGER ensure-all)"
	else
		info "No tmux server running; hooks will activate on next tmux session start."
	fi
else
	warn "agents-view-manager.sh not found at $AGENTS_MANAGER — skipping Agents View setup."
fi

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
info "Installation complete!"
echo ""
echo "  Next steps:"
echo "  1. If you see settings.json warnings above, fill in your API keys"
echo "  2. Reload tmux: tmux source-file $TMUX_CONF"
echo "  3. Start OMP: omp"
echo "  4. Session browser: prefix + S (in tmux)"
echo "  5. To push your config to git: cd $AGENT_DIR && git add -A && git commit -m 'initial config' && git push"

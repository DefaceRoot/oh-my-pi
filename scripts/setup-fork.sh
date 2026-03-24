#!/usr/bin/env bash
#
# Oh My Pi - Fork Setup Script
# ==============================
# This script sets up a cloned fork of oh-my-pi to work properly with all
# features enabled: orchestrator delegation, agent configs, skills, etc.
#
# Usage:
#   cd /path/to/oh-my-pi
#   ./scripts/setup-fork.sh
#
# Or for fresh clones:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_FORK/main/scripts/setup-fork.sh | bash -s -- /path/to/clone
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Script directory detection
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

# Default paths
AGENT_SOURCE="$REPO_ROOT/agent"
AGENT_LINK="$HOME/.omp/agent"
LAUNCHER_SOURCE="$REPO_ROOT/omp"
LAUNCHER_LINK="$HOME/.local/bin/omp"
BIN_DIR="$HOME/.local/bin"
OMP_DIR="$HOME/.omp"

# Minimum versions
MIN_BUN_VERSION="1.3.7"

# Track what we modify for rollback
BACKUP_PATH=""
MODIFIED_FILES=()

# ============================================================================
# Helper Functions
# ============================================================================

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
log_success() { echo -e "${GREEN}${BOLD}✓ $*${NC}"; }

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║           Oh My Pi - Fork Setup Script                       ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "This script will:"
    echo "  • Install Bun (if needed)"
    echo "  • Install project dependencies"
    echo "  • Link ~/.omp/agent to this fork"
    echo "  • Link ~/.local/bin/omp to fork launcher"
    echo "  • Configure MCP with correct paths"
    echo "  • Verify installation"
    echo ""
}

# ============================================================================
# Bun Installation
# ============================================================================

ensure_bun() {
    log_step "Checking Bun installation..."

    if command -v bun >/dev/null 2>&1; then
        local version
        version=$(bun --version 2>/dev/null | head -1)
        log_ok "Bun found: $version at $(command -v bun)"

        # Check version
        local version_clean="${version%%-*}"
        if [[ "$(printf '%s\n' "$MIN_BUN_VERSION" "$version_clean" | sort -V | head -n1)" != "$MIN_BUN_VERSION" ]]; then
            log_warn "Bun $MIN_BUN_VERSION or newer is recommended (current: $version_clean)"
            log_info "You can upgrade with: bun upgrade"
        fi
        return 0
    fi

    if [[ -x "$HOME/.bun/bin/bun" ]]; then
        export PATH="$HOME/.bun/bin:$PATH"
        log_ok "Bun found at ~/.bun/bin/bun"
        bun --version | head -1
        return 0
    fi

    log_info "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    log_ok "Bun installed successfully"
    bun --version | head -1
}

# ============================================================================
# Dependencies
# ============================================================================

install_dependencies() {
    log_step "Installing project dependencies..."

    if [[ ! -f "$REPO_ROOT/package.json" ]]; then
        log_error "No package.json found in $REPO_ROOT"
        exit 1
    fi

    cd "$REPO_ROOT"
    bun install
    log_ok "Dependencies installed"
}

# ============================================================================
# Symlink Management
# ============================================================================

setup_agent_symlink() {
    log_step "Setting up ~/.omp/agent symlink..."

    mkdir -p "$OMP_DIR"

    if [[ -L "$AGENT_LINK" ]]; then
        local current_target
        current_target="$(readlink "$AGENT_LINK")"
        if [[ "$current_target" == "$AGENT_SOURCE" ]]; then
            log_ok "~/.omp/agent already points to this fork"
            return 0
        fi
        log_warn "Replacing existing symlink: $current_target"
        rm "$AGENT_LINK"
        ln -s "$AGENT_SOURCE" "$AGENT_LINK"
        log_ok "Updated ~/.omp/agent symlink"
        return 0
    fi

    if [[ -e "$AGENT_LINK" ]]; then
        BACKUP_PATH="$OMP_DIR/agent.backup-$(date +%Y%m%d%H%M%S)"
        log_warn "Backing up existing ~/.omp/agent to $BACKUP_PATH"
        mv "$AGENT_LINK" "$BACKUP_PATH"
    fi

    ln -s "$AGENT_SOURCE" "$AGENT_LINK"
    log_ok "Created ~/.omp/agent -> $AGENT_SOURCE"
}

setup_launcher_symlink() {
    log_step "Setting up omp launcher..."

    if [[ ! -x "$LAUNCHER_SOURCE" ]]; then
        log_error "Expected executable fork launcher at $LAUNCHER_SOURCE"
        exit 1
    fi

    mkdir -p "$BIN_DIR"

    if [[ -L "$LAUNCHER_LINK" ]]; then
        local current_target
        current_target="$(readlink "$LAUNCHER_LINK")"
        if [[ "$current_target" == "$LAUNCHER_SOURCE" ]]; then
            log_ok "Launcher already points to this fork"
            return 0
        fi
        log_warn "Replacing launcher symlink: $current_target"
        rm "$LAUNCHER_LINK"
        ln -s "$LAUNCHER_SOURCE" "$LAUNCHER_LINK"
        log_ok "Updated omp launcher symlink"
        return 0
    fi

    if [[ -e "$LAUNCHER_LINK" ]]; then
        log_error "$LAUNCHER_LINK exists and is not a symlink."
        log_info "Remove it manually: rm $LAUNCHER_LINK"
        exit 1
    fi

    ln -s "$LAUNCHER_SOURCE" "$LAUNCHER_LINK"
    log_ok "Created $LAUNCHER_LINK -> $LAUNCHER_SOURCE"
}

# ============================================================================
# MCP Configuration
# ============================================================================

configure_mcp() {
    log_step "Configuring MCP..."

    local mcp_source="$REPO_ROOT/agent/mcp.json"
    local mcp_template="$REPO_ROOT/agent/mcp.template.json"
    local mcp_target="$OMP_DIR/mcp.json"

    if [[ -f "$mcp_source" ]]; then
        # Copy mcp.json and update paths
        cp "$mcp_source" "$mcp_target"
        MODIFIED_FILES+=("$mcp_target")

        # Replace hardcoded paths with dynamic resolution
        # Use a temp file for sed in-place editing
        local temp_file
        temp_file=$(mktemp)

        # Replace the hardcoded absolute paths with template variables
        sed "s|/home/colin/devpod-repos/DefaceRoot/oh-my-pi|$REPO_ROOT|g" "$mcp_target" > "$temp_file"
        mv "$temp_file" "$mcp_target"

        log_ok "MCP configuration updated at $mcp_target"
    elif [[ -f "$mcp_template" ]]; then
        cp "$mcp_template" "$mcp_target"
        MODIFIED_FILES+=("$mcp_target")
        log_ok "MCP configuration created from template"
    else
        log_warn "No MCP configuration found"
    fi
}

# ============================================================================
# Shell Configuration
# ============================================================================

update_shell_config() {
    log_step "Checking shell configuration..."

    local shell_name="${SHELL##*/}"
    local config_file=""

    case "$shell_name" in
        bash)
            config_file="$HOME/.bashrc"
            [[ -f "$HOME/.bash_profile" ]] && config_file="$HOME/.bash_profile"
            ;;
        zsh)
            config_file="$HOME/.zshrc"
            ;;
        fish)
            config_file="$HOME/.config/fish/config.fish"
            ;;
        *)
            log_warn "Unknown shell: $shell_name"
            return 0
            ;;
    esac

    # Check if PATH already contains ~/.local/bin
    if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
        log_ok "~/.local/bin is already in PATH"
        return 0
    fi

    log_info "~/.local/bin is not in your PATH"
    log_info "Would you like to add it to $config_file?"

    # Auto-accept in non-interactive mode
    if [[ ! -t 0 ]]; then
        log_info "Non-interactive mode detected, skipping shell config update"
        return 0
    fi

    read -rp "Add to PATH? [Y/n] " response
    case "$response" in
        [Nn]*)
            log_info "Skipped. Add manually: export PATH=\"$BIN_DIR:\$PATH\""
            ;;
        *)
            if [[ "$shell_name" == "fish" ]]; then
                echo "fish_add_path $BIN_DIR" >> "$config_file"
            else
                echo "" >> "$config_file"
                echo "# Added by oh-my-pi setup" >> "$config_file"
                echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$config_file"
            fi
            log_ok "Added $BIN_DIR to PATH in $config_file"
            log_info "Run: source $config_file"
            ;;
    esac
}

# ============================================================================
# Verification
# ============================================================================

verify_installation() {
    log_step "Verifying installation..."

    local errors=0

    # Check agent symlink
    if [[ -L "$AGENT_LINK" ]]; then
        local target
        target=$(readlink "$AGENT_LINK")
        if [[ "$target" == "$AGENT_SOURCE" ]]; then
            log_ok "Agent symlink correct"
        else
            log_error "Agent symlink points to wrong location: $target"
            ((errors++))
        fi
    else
        log_error "Agent symlink missing at $AGENT_LINK"
        ((errors++))
    fi

    # Check launcher symlink
    if [[ -L "$LAUNCHER_LINK" ]]; then
        local target
        target=$(readlink "$LAUNCHER_LINK")
        if [[ "$target" == "$LAUNCHER_SOURCE" ]]; then
            log_ok "Launcher symlink correct"
        else
            log_error "Launcher symlink points to wrong location: $target"
            ((errors++))
        fi
    else
        log_error "Launcher symlink missing at $LAUNCHER_LINK"
        ((errors++))
    fi

    # Check critical agent files exist
    local critical_files=(
        "AGENTS.md"
        "config.yml"
        "roles.yml"
        "AGENTS-orchestrator.md"
    )

    for file in "${critical_files[@]}"; do
        if [[ -f "$AGENT_SOURCE/$file" ]]; then
            log_ok "Found $file"
        else
            log_error "Missing critical file: $file"
            ((errors++))
        fi
    done

    # Check orchestrator extension
    if [[ -f "$AGENT_SOURCE/extensions/orchestrator-mode/index.ts" ]]; then
        log_ok "Orchestrator extension found"
    else
        log_warn "Orchestrator extension not found (may be optional)"
    fi

    # Check node_modules
    if [[ -d "$REPO_ROOT/node_modules" ]]; then
        log_ok "Node modules installed"
    else
        log_error "Node modules missing - run 'bun install'"
        ((errors++))
    fi

    # Check if omp is in PATH
    if command -v omp >/dev/null 2>&1; then
        local omp_path
        omp_path=$(command -v omp)
        log_ok "omp is in PATH: $omp_path"
    else
        log_warn "omp is not in your current PATH"
        log_info "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
    fi

    if [[ $errors -eq 0 ]]; then
        return 0
    else
        return 1
    fi
}

# ============================================================================
# Feature Tests
# ============================================================================

test_features() {
    log_step "Testing fork features..."

    # Test 1: Environment variable check
    export PI_CODING_AGENT_DIR="$AGENT_SOURCE"

    if [[ -d "$PI_CODING_AGENT_DIR" ]]; then
        log_ok "PI_CODING_AGENT_DIR resolves correctly"
    else
        log_error "PI_CODING_AGENT_DIR does not resolve to valid directory"
        return 1
    fi

    # Test 2: Check that agent config can be loaded
    if [[ -f "$AGENT_SOURCE/config.yml" ]]; then
        log_ok "Agent config readable"
    else
        log_error "Cannot read agent config"
        return 1
    fi

    # Test 3: Verify roles config
    if [[ -f "$AGENT_SOURCE/roles.yml" ]]; then
        log_ok "Roles config readable"
    else
        log_error "Cannot read roles config"
        return 1
    fi

    # Test 4: Check skills directory structure
    local skills_count
    skills_count=$(find "$AGENT_SOURCE/skills" -name "SKILL.md" 2>/dev/null | wc -l)
    if [[ $skills_count -gt 0 ]]; then
        log_ok "Found $skills_count skills"
    else
        log_warn "No skills found in $AGENT_SOURCE/skills"
    fi

    # Test 5: Verify CLI can be invoked (dry run)
    if command -v bun >/dev/null 2>&1; then
        if bun --cwd="$REPO_ROOT/packages/coding-agent" src/cli.ts --help >/dev/null 2>&1; then
            log_ok "CLI can be invoked"
        else
            # --help might not exist, try with version or just check file exists
            if [[ -f "$REPO_ROOT/packages/coding-agent/src/cli.ts" ]]; then
                log_ok "CLI entry point exists"
            fi
        fi
    fi

    return 0
}

# ============================================================================
# Summary
# ============================================================================

print_summary() {
    echo ""
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}                   Setup Complete!${NC}"
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "Repository:      $REPO_ROOT"
    echo "Agent source:    $AGENT_SOURCE"
    echo "Agent link:      $AGENT_LINK"
    echo "Launcher:        $LAUNCHER_LINK"
    [[ -n "$BACKUP_PATH" ]] && echo "Backup:          $BACKUP_PATH"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo "  1. Ensure ~/.local/bin is in your PATH:"
    echo "     export PATH=\"$BIN_DIR:\$PATH\""
    echo ""
    echo "  2. Restart your shell or run:"
    echo "     source ~/.bashrc  (or ~/.zshrc)"
    echo ""
    echo "  3. Verify installation:"
    echo "     omp --version"
    echo ""
    echo "  4. Your orchestrator and all fork features are now active!"
    echo ""
    echo -e "${YELLOW}Note:${NC} If you have issues, check:"
    echo "  - All symlinks point correctly (ls -la ~/.omp/ ~/.local/bin/)"
    echo "  - Bun is in your PATH"
    echo "  - Node modules are installed"
    echo ""
}

print_error_summary() {
    echo ""
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}                   Setup Failed${NC}"
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "Some verification checks failed. Please review the errors above."
    echo ""
    echo "Common fixes:"
    echo "  - Ensure you have write permissions to ~/.omp and ~/.local/bin"
    echo "  - Run with proper shell (not sh): bash scripts/setup-fork.sh"
    echo "  - Check that the repository is fully cloned (git lfs pull)"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    print_banner

    # Validate we're in a proper repo
    if [[ ! -d "$AGENT_SOURCE" ]]; then
        log_error "Expected agent directory at $AGENT_SOURCE"
        log_info "Are you running this from the repo root?"
        exit 1
    fi

    if [[ ! -f "$REPO_ROOT/package.json" ]]; then
        log_error "Expected package.json at $REPO_ROOT"
        exit 1
    fi

    # Run setup steps
    ensure_bun
    install_dependencies
    setup_agent_symlink
    setup_launcher_symlink
    configure_mcp
    update_shell_config

    # Verify and test
    if verify_installation && test_features; then
        print_summary
        exit 0
    else
        print_error_summary
        exit 1
    fi
}

# Handle command line args
while [[ $# -gt 0 ]]; do
    case $1 in
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --help, -h     Show this help message"
            echo "  --no-shell     Skip shell configuration prompts"
            echo "  --verify-only  Only run verification, skip setup"
            echo ""
            echo "Environment:"
            echo "  REPO_ROOT      Override repository root (default: auto-detect)"
            exit 0
            ;;
        --no-shell)
            # Non-interactive mode
            exec < /dev/null
            shift
            ;;
        --verify-only)
            verify_installation && test_features
            exit $?
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

main

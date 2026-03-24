#!/usr/bin/env bash
#
# Oh My Pi - Fresh Clone Installer
# ==================================
# One-command installer for setting up the oh-my-pi fork on a new machine.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DefaceRoot/oh-my-pi/main/scripts/install-fork.sh | bash
#
#   # Or with specific directory:
#   curl -fsSL ... | bash -s -- --dir ~/my-omp
#
#   # Or clone manually then run setup:
#   git clone https://github.com/DefaceRoot/oh-my-pi.git
#   cd oh-my-pi && ./scripts/setup-fork.sh
#

set -euo pipefail

# Configuration
DEFAULT_REPO_URL="https://github.com/DefaceRoot/oh-my-pi.git"
DEFAULT_INSTALL_DIR="$HOME/oh-my-pi"
MIN_BUN_VERSION="1.3.7"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# Parse arguments
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
REPO_URL="$DEFAULT_REPO_URL"
SKIP_CLONE=false

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }

print_banner() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║      Oh My Pi - Fresh Clone Installer                        ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dir|-d)
            INSTALL_DIR="$2"
            shift 2
            ;;
        --repo|-r)
            REPO_URL="$2"
            shift 2
            ;;
        --skip-clone)
            SKIP_CLONE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dir, -d DIR       Install to specific directory (default: ~/oh-my-pi)"
            echo "  --repo, -r URL      Clone from specific repo (default: DefaceRoot/oh-my-pi)"
            echo "  --skip-clone        Skip cloning (use if already cloned)"
            echo "  --help, -h          Show this help"
            echo ""
            echo "Examples:"
            echo "  $0"
            echo "  $0 --dir ~/projects/omp"
            echo "  $0 --repo https://github.com/myuser/oh-my-pi.git"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    # Check git
    if ! command -v git >/dev/null 2>&1; then
        log_error "Git is required but not installed"
        exit 1
    fi
    log_ok "Git found: $(git --version)"

    # Check curl
    if ! command -v curl >/dev/null 2>&1; then
        log_error "curl is required but not installed"
        exit 1
    fi
    log_ok "curl found"
}

# Install Bun if needed
ensure_bun() {
    log_step "Checking Bun..."

    if command -v bun >/dev/null 2>&1; then
        log_ok "Bun found: $(bun --version)"
        return 0
    fi

    if [[ -x "$HOME/.bun/bin/bun" ]]; then
        export PATH="$HOME/.bun/bin:$PATH"
        log_ok "Bun found at ~/.bun/bin"
        return 0
    fi

    log_info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    log_ok "Bun installed: $(bun --version)"
}

# Clone the repository
clone_repo() {
    if [[ "$SKIP_CLONE" == true ]]; then
        log_step "Using existing clone at $INSTALL_DIR"
        if [[ ! -d "$INSTALL_DIR/.git" ]]; then
            log_error "No git repository found at $INSTALL_DIR"
            exit 1
        fi
        return 0
    fi

    log_step "Cloning repository..."

    if [[ -d "$INSTALL_DIR" ]]; then
        log_warn "Directory $INSTALL_DIR already exists"
        read -rp "Remove and re-clone? [y/N] " response
        case "$response" in
            [Yy]*)
                rm -rf "$INSTALL_DIR"
                ;;
            *)
                log_info "Using existing directory"
                SKIP_CLONE=true
                return 0
                ;;
        esac
    fi

    log_info "Cloning from $REPO_URL to $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    log_ok "Repository cloned"

    # Pull LFS files if git-lfs is available
    if command -v git-lfs >/dev/null 2>&1; then
        log_info "Pulling Git LFS files..."
        cd "$INSTALL_DIR"
        git lfs pull || log_warn "Git LFS pull failed (may not be critical)"
    fi
}

# Run the setup script
run_setup() {
    log_step "Running fork setup..."

    local setup_script="$INSTALL_DIR/scripts/setup-fork.sh"

    if [[ ! -f "$setup_script" ]]; then
        log_error "Setup script not found at $setup_script"
        exit 1
    fi

    chmod +x "$setup_script"

    # Run setup from within the repo
    cd "$INSTALL_DIR"
    bash "$setup_script"
}

# Print final instructions
print_success() {
    echo ""
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}                   Installation Complete!${NC}"
    echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${CYAN}Your fork is installed at:${NC} $INSTALL_DIR"
    echo ""
    echo "Quick commands:"
    echo "  cd $INSTALL_DIR"
    echo "  omp --version        # Check version"
    echo "  omp --help           # Show help"
    echo ""
    echo -e "${CYAN}Features ready to use:${NC}"
    echo "  ✓ Orchestrator delegation"
    echo "  ✓ Agent configs (AGENTS-orchestrator.md, etc.)"
    echo "  ✓ Skills and extensions"
    echo "  ✓ Custom output structure"
    echo ""
    echo -e "${YELLOW}Important:${NC}"
    echo "  1. Ensure ~/.local/bin is in your PATH"
    echo "  2. Restart your shell or run: source ~/.bashrc (or ~/.zshrc)"
    echo "  3. Start using: omp"
    echo ""
}

# Main
main() {
    print_banner
    check_prerequisites
    ensure_bun
    clone_repo
    run_setup
    print_success
}

main

#!/usr/bin/env bash
# worktree-setup.sh - Automated worktree creation and project setup
# Usage: worktree-setup.sh <branch-name> [worktree-dir]
#
# This script:
# 1. Validates git repository state
# 2. Creates worktree directory structure
# 3. Ensures .gitignore includes worktree directory
# 4. Creates the worktree with new branch
# 5. Detects and runs project-specific setup

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Validate arguments
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <branch-name> [worktree-dir]"
    echo "  branch-name: Name for the new git branch (e.g., feature/auth)"
    echo "  worktree-dir: Base directory for worktrees (default: .worktrees)"
    exit 1
fi

BRANCH_NAME="$1"
WORKTREE_BASE="${2:-.worktrees}"

# Validate we're in a git repo
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    log_error "Not inside a git repository"
    exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Check if branch already exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    log_error "Branch '$BRANCH_NAME' already exists"
    exit 1
fi

# Determine worktree path (sanitize branch name for directory)
WORKTREE_DIR_NAME=$(echo "$BRANCH_NAME" | tr '/' '-')
WORKTREE_PATH="$WORKTREE_BASE/$WORKTREE_DIR_NAME"

# Check if worktree path already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    log_error "Worktree path '$WORKTREE_PATH' already exists"
    exit 1
fi

# Create worktree base directory if needed
if [[ ! -d "$WORKTREE_BASE" ]]; then
    log_info "Creating worktree directory: $WORKTREE_BASE"
    mkdir -p "$WORKTREE_BASE"
fi

# Ensure worktree directory is in .gitignore
if ! git check-ignore -q "$WORKTREE_BASE" 2>/dev/null; then
    log_warn "$WORKTREE_BASE not in .gitignore, adding..."
    echo "$WORKTREE_BASE/" >> .gitignore
    git add .gitignore
    git commit -m "chore: add $WORKTREE_BASE to .gitignore"
    log_info "Committed .gitignore update"
fi

# Create the worktree
log_info "Creating worktree: $WORKTREE_PATH (branch: $BRANCH_NAME)"
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME"

# Move to worktree for setup
cd "$WORKTREE_PATH"
FULL_PATH=$(pwd)
log_info "Worktree created at: $FULL_PATH"

# Project setup based on detected files
setup_log=""

# Node.js / Bun
if [[ -f "package.json" ]]; then
    if [[ -f "bun.lock" ]] || [[ -f "bun.lockb" ]]; then
        log_info "Detected Bun project, running bun install..."
        if bun install; then
            setup_log+="bun install: success\n"
        else
            setup_log+="bun install: failed\n"
            log_warn "bun install failed"
        fi
    elif [[ -f "pnpm-lock.yaml" ]]; then
        log_info "Detected pnpm project, running pnpm install..."
        if pnpm install; then
            setup_log+="pnpm install: success\n"
        else
            setup_log+="pnpm install: failed\n"
            log_warn "pnpm install failed"
        fi
    elif [[ -f "yarn.lock" ]]; then
        log_info "Detected Yarn project, running yarn install..."
        if yarn install; then
            setup_log+="yarn install: success\n"
        else
            setup_log+="yarn install: failed\n"
            log_warn "yarn install failed"
        fi
    else
        log_info "Detected npm project, running npm install..."
        if npm install; then
            setup_log+="npm install: success\n"
        else
            setup_log+="npm install: failed\n"
            log_warn "npm install failed"
        fi
    fi
fi

# Rust
if [[ -f "Cargo.toml" ]]; then
    log_info "Detected Rust project, running cargo build..."
    if cargo build; then
        setup_log+="cargo build: success\n"
    else
        setup_log+="cargo build: failed\n"
        log_warn "cargo build failed"
    fi
fi

# Python
if [[ -f "pyproject.toml" ]]; then
    if [[ -f "poetry.lock" ]]; then
        log_info "Detected Poetry project, running poetry install..."
        if poetry install; then
            setup_log+="poetry install: success\n"
        else
            setup_log+="poetry install: failed\n"
            log_warn "poetry install failed"
        fi
    elif [[ -f "uv.lock" ]]; then
        log_info "Detected uv project, running uv sync..."
        if uv sync; then
            setup_log+="uv sync: success\n"
        else
            setup_log+="uv sync: failed\n"
            log_warn "uv sync failed"
        fi
    else
        log_info "Detected Python project, running pip install -e ."
        if pip install -e .; then
            setup_log+="pip install -e .: success\n"
        else
            setup_log+="pip install -e .: failed\n"
            log_warn "pip install failed"
        fi
    fi
elif [[ -f "requirements.txt" ]]; then
    log_info "Detected Python project, running pip install -r requirements.txt..."
    if pip install -r requirements.txt; then
        setup_log+="pip install: success\n"
    else
        setup_log+="pip install: failed\n"
        log_warn "pip install failed"
    fi
fi

# Go
if [[ -f "go.mod" ]]; then
    log_info "Detected Go project, running go mod download..."
    if go mod download; then
        setup_log+="go mod download: success\n"
    else
        setup_log+="go mod download: failed\n"
        log_warn "go mod download failed"
    fi
fi

# Output summary
echo ""
log_info "=== Worktree Setup Complete ==="
echo "  Branch: $BRANCH_NAME"
echo "  Path: $FULL_PATH"
if [[ -n "$setup_log" ]]; then
    echo ""
    echo "Setup log:"
    echo -e "$setup_log"
fi
echo ""
echo "To start working:"
echo "  cd $FULL_PATH"

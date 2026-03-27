#!/usr/bin/env bash
#
# Oh My Pi - Fork Verification Script
# =====================================
# Comprehensive verification that all fork features are working correctly.
#
# Usage:
#   ./scripts/verify-fork.sh
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# Paths
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
AGENT_DIR="$REPO_ROOT/agent"
NATIVES_DIR="$REPO_ROOT/packages/natives/native"

# Results
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

log_info()   { echo -e "${BLUE}[INFO]${NC}   $*"; }
log_ok()     { echo -e "${GREEN}[PASS]${NC}   $*"; }
log_warn()   { echo -e "${YELLOW}[SKIP]${NC}   $*"; }
log_error()  { echo -e "${RED}[FAIL]${NC}   $*" >&2; }
log_header() { echo -e "\n${CYAN}${BOLD}$*${NC}"; echo "${CYAN}${BOLD}$(printf '=%.0s' $(seq 1 ${#1}))${NC}"; }

# Test framework
run_test() {
    local name="$1"
    local test_fn="$2"

    if $test_fn; then
        ((TESTS_PASSED++))
        log_ok "$name"
        return 0
    else
        ((TESTS_FAILED++))
        log_error "$name"
        return 1
    fi
}

skip_test() {
    local name="$1"
    local reason="$2"
    ((TESTS_SKIPPED++))
    log_warn "$name - $reason"
}

# ============================================================================
# Tests
# ============================================================================

test_bun_installed() {
    command -v bun >/dev/null 2>&1
}

test_bun_version() {
    local version
    version=$(bun --version 2>/dev/null | head -1)
    [[ -n "$version" ]]
}

test_node_modules() {
    [[ -d "$REPO_ROOT/node_modules" ]]
}

test_native_addon() {
    compgen -G "$NATIVES_DIR/pi_natives.*.node" >/dev/null
}

test_agent_symlink() {
    local link="$HOME/.omp/agent"
    [[ -L "$link" ]]
}

test_agent_symlink_correct() {
    local link="$HOME/.omp/agent"
    local target
    target=$(readlink "$link" 2>/dev/null || true)
    [[ "$target" == "$AGENT_DIR" ]]
}

test_omp_in_path() {
    command -v omp >/dev/null 2>&1
}

test_omp_launcher_symlink() {
    local link="$HOME/.local/bin/omp"
    [[ -L "$link" ]]
}

test_omp_launcher_correct() {
    local link="$HOME/.local/bin/omp"
    local target
    target=$(readlink "$link" 2>/dev/null || true)
    [[ "$target" == "$REPO_ROOT/omp" ]]
}

test_agent_config_exists() {
    [[ -f "$AGENT_DIR/config.yml" ]]
}

test_agent_roles_exists() {
    [[ -f "$AGENT_DIR/roles.yml" ]]
}

test_agents_md_exists() {
    [[ -f "$AGENT_DIR/AGENTS.md" ]]
}

test_agents_orchestrator_exists() {
    [[ -f "$AGENT_DIR/AGENTS-orchestrator.md" ]]
}

test_orchestrator_extension() {
    [[ -f "$AGENT_DIR/extensions/orchestrator-mode/index.ts" ]]
}

test_implementation_engine() {
    [[ -f "$AGENT_DIR/extensions/implementation-engine/index.ts" ]]
}

test_skills_directory() {
    [[ -d "$AGENT_DIR/skills" ]]
}

test_skills_content() {
    local count
    count=$(find "$AGENT_DIR/skills" -name "SKILL.md" 2>/dev/null | wc -l)
    [[ $count -gt 0 ]]
}

test_toon_delegation_skill() {
    [[ -f "$AGENT_DIR/skills/toon-delegation/SKILL.md" ]]
}

test_agents_directory() {
    [[ -d "$AGENT_DIR/agents" ]]
}

test_agents_content() {
    local count
    count=$(find "$AGENT_DIR/agents" -name "*.md" 2>/dev/null | wc -l)
    [[ $count -gt 0 ]]
}

test_implement_agent() {
    [[ -f "$AGENT_DIR/agents/implement.md" ]]
}

test_debug_agent() {
    [[ -f "$AGENT_DIR/agents/debug.md" ]]
}

test_verifier_agent() {
    [[ -f "$AGENT_DIR/agents/verifier.md" ]]
}

test_coderabbit_agent() {
    [[ -f "$AGENT_DIR/agents/coderabbit.md" ]]
}

test_rules_directory() {
    [[ -d "$AGENT_DIR/rules" ]]
}

test_orchestrator_rule() {
    [[ -f "$AGENT_DIR/rules/orchestrator-mode.md" ]]
}

test_worker_protocol() {
    [[ -f "$AGENT_DIR/rules/worker-protocol.md" ]]
}

test_quality_gate() {
    [[ -f "$AGENT_DIR/rules/quality-gate.md" ]]
}

test_planning_protocol() {
    [[ -f "$AGENT_DIR/rules/planning-protocol.md" ]]
}

test_mcp_config() {
    [[ -f "$AGENT_DIR/mcp.json" ]] || [[ -f "$HOME/.omp/mcp.json" ]]
}

test_models_config() {
    [[ -f "$AGENT_DIR/models.yml" ]]
}

test_keybindings() {
    [[ -f "$AGENT_DIR/keybindings.json" ]]
}

test_coding_agent_pkg() {
    [[ -d "$REPO_ROOT/packages/coding-agent" ]]
}

test_coding_agent_cli() {
    [[ -f "$REPO_ROOT/packages/coding-agent/src/cli.ts" ]]
}

test_cli_executable() {
    bun --cwd="$REPO_ROOT/packages/coding-agent" src/cli.ts --help >/dev/null 2>&1
}

test_pi_env_var() {
    [[ -n "${PI_CODING_AGENT_DIR:-}" ]] || [[ -d "$HOME/.omp/agent" ]]
}

test_extensions_directory() {
    [[ -d "$AGENT_DIR/extensions" ]]
}

test_ask_mode_extension() {
    [[ -f "$AGENT_DIR/extensions/ask-mode/index.ts" ]]
}

test_plan_mode_extension() {
    [[ -f "$AGENT_DIR/extensions/plan-mode/index.ts" ]]
}

test_mcp_filter_extension() {
    [[ -f "$AGENT_DIR/extensions/mcp-filter/index.ts" ]]
}

test_worktree_policy() {
    [[ -f "$AGENT_DIR/extensions/worktree-policy/index.ts" ]]
}

test_live_log_watcher() {
    [[ -f "$AGENT_DIR/extensions/live-log-watcher/index.ts" ]]
}

test_global_ssh_hosts() {
    [[ -f "$AGENT_DIR/extensions/global-ssh-hosts.ts" ]]
}

test_commands_directory() {
    [[ -d "$AGENT_DIR/commands" ]]
}

test_autoresearch_command() {
    [[ -f "$AGENT_DIR/commands/autoresearch.md" ]]
}

test_grafana_agent() {
    [[ -f "$AGENT_DIR/agents/grafana.md" ]]
}

test_research_agent() {
    [[ -f "$AGENT_DIR/agents/research.md" ]]
}

test_explore_agent() {
    [[ -f "$AGENT_DIR/agents/explore.md" ]]
}

test_code_reviewer_agent() {
    [[ -f "$AGENT_DIR/agents/code-reviewer.md" ]]
}

test_lint_agent() {
    [[ -f "$AGENT_DIR/agents/lint.md" ]]
}

test_commit_agent() {
    [[ -f "$AGENT_DIR/agents/commit.md" ]]
}

test_merge_agent() {
    [[ -f "$AGENT_DIR/agents/merge.md" ]]
}

test_plan_agent() {
    [[ -f "$AGENT_DIR/agents/plan.md" ]]
}

test_plan_verifier_agent() {
    [[ -f "$AGENT_DIR/agents/plan-verifier.md" ]]
}

test_worktree_setup_agent() {
    [[ -f "$AGENT_DIR/agents/worktree-setup.md" ]]
}

test_curator_agent() {
    [[ -f "$AGENT_DIR/agents/curator.md" ]]
}

test_skills_lock() {
    [[ -f "$AGENT_DIR/skills-lock.json" ]]
}

# ============================================================================
# Main
# ============================================================================

main() {
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║      Oh My Pi - Fork Verification Suite                      ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    log_info "Repository: $REPO_ROOT"
    log_info "Agent dir:  $AGENT_DIR"
    echo ""

    # Prerequisites
    log_header "Prerequisites"
    run_test "Bun installed" test_bun_installed || true
    run_test "Bun version readable" test_bun_version || true
    run_test "Node modules installed" test_node_modules || true
    run_test "Native addon built" test_native_addon || true

    # Installation
    log_header "Installation"
    run_test "Agent symlink exists" test_agent_symlink || true
    run_test "Agent symlink correct" test_agent_symlink_correct || true
    run_test "omp in PATH" test_omp_in_path || true
    run_test "omp launcher symlink exists" test_omp_launcher_symlink || true
    run_test "omp launcher correct" test_omp_launcher_correct || true

    # Core Configuration
    log_header "Core Configuration"
    run_test "Agent config (config.yml)" test_agent_config_exists || true
    run_test "Agent roles (roles.yml)" test_agent_roles_exists || true
    run_test "AGENTS.md exists" test_agents_md_exists || true
    run_test "AGENTS-orchestrator.md exists" test_agents_orchestrator_exists || true
    run_test "MCP config exists" test_mcp_config || true
    run_test "Models config (models.yml)" test_models_config || true
    run_test "Keybindings config" test_keybindings || true

    # Core Extensions
    log_header "Core Extensions"
    run_test "Extensions directory" test_extensions_directory || true
    run_test "Orchestrator extension" test_orchestrator_extension || true
    run_test "Implementation engine" test_implementation_engine || true
    run_test "Ask mode extension" test_ask_mode_extension || true
    run_test "Plan mode extension" test_plan_mode_extension || true
    run_test "MCP filter extension" test_mcp_filter_extension || true
    run_test "Worktree policy" test_worktree_policy || true
    run_test "Live log watcher" test_live_log_watcher || true
    run_test "Global SSH hosts" test_global_ssh_hosts || true

    # Rules
    log_header "Rules System"
    run_test "Rules directory" test_rules_directory || true
    run_test "Orchestrator mode rule" test_orchestrator_rule || true
    run_test "Worker protocol rule" test_worker_protocol || true
    run_test "Quality gate rule" test_quality_gate || true
    run_test "Planning protocol rule" test_planning_protocol || true

    # Skills
    log_header "Skills System"
    run_test "Skills directory" test_skills_directory || true
    run_test "Skills have content" test_skills_content || true
    run_test "toon-delegation skill" test_toon_delegation_skill || true

    # Agents
    log_header "Agent Definitions"
    run_test "Agents directory" test_agents_directory || true
    run_test "Agents have content" test_agents_content || true
    run_test "implement agent" test_implement_agent || true
    run_test "debug agent" test_debug_agent || true
    run_test "verifier agent" test_verifier_agent || true
    run_test "code-reviewer agent" test_code_reviewer_agent || true
    run_test "lint agent" test_lint_agent || true
    run_test "commit agent" test_commit_agent || true
    run_test "merge agent" test_merge_agent || true
    run_test "plan agent" test_plan_agent || true
    run_test "plan-verifier agent" test_plan_verifier_agent || true
    run_test "worktree-setup agent" test_worktree_setup_agent || true
    run_test "curator agent" test_curator_agent || true
    run_test "grafana agent" test_grafana_agent || true
    run_test "research agent" test_research_agent || true
    run_test "explore agent" test_explore_agent || true
    run_test "coderabbit agent" test_coderabbit_agent || true

    # Commands
    log_header "Commands"
    run_test "Commands directory" test_commands_directory || true
    run_test "autoresearch command" test_autoresearch_command || true

    # Coding Agent Package
    log_header "Coding Agent Package"
    run_test "Coding agent package exists" test_coding_agent_pkg || true
    run_test "CLI entry point exists" test_coding_agent_cli || true
    run_test "CLI is executable" test_cli_executable || true

    # Environment
    log_header "Environment"
    run_test "PI_CODING_AGENT_DIR or symlink" test_pi_env_var || true

    # Skills Lock
    log_header "Skills Lock"
    run_test "skills-lock.json" test_skills_lock || true

    # Summary
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}                      Summary${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}${BOLD}✓ All tests passed!${NC}"
        echo "  Passed:  $TESTS_PASSED"
        echo "  Skipped: $TESTS_SKIPPED"
        echo ""
        echo "Your fork is fully configured and ready to use."
        echo "Run 'omp' to get started."
        exit 0
    else
        echo -e "${RED}${BOLD}✗ Some tests failed${NC}"
        echo "  Passed:  $TESTS_PASSED"
        echo "  Failed:  $TESTS_FAILED"
        echo "  Skipped: $TESTS_SKIPPED"
        echo ""
        echo "To fix issues, run: ./scripts/setup-fork.sh"
        exit 1
    fi
}

main

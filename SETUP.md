# Oh My Pi - Fork Setup Guide

This guide ensures your forked oh-my-pi installation is fully configured with all features working: orchestrator delegation, agent configs, custom output structure, and all extensions.

## Quick Start

### Option 1: One-Command Install (Fresh Machine)

```bash
curl -fsSL https://raw.githubusercontent.com/DefaceRoot/oh-my-pi/main/scripts/install-fork.sh | bash
```

### Option 2: Manual Clone + Setup

```bash
# 1. Clone your fork
git clone https://github.com/DefaceRoot/oh-my-pi.git
cd oh-my-pi

# 2. Run the setup script
./scripts/setup-fork.sh

# 3. Verify everything works
./scripts/verify-fork.sh
```

## What Gets Installed

The setup script configures:

1. **Bun runtime** - Installed if not present
2. **Dependencies** - `bun install` for all packages
3. **Agent symlink** - `~/.omp/agent` → your fork's `agent/` directory
4. **Launcher symlink** - `~/.local/bin/omp` → your fork's `omp` script
5. **MCP config** - Environment-based configuration (no hardcoded paths)
6. **Shell integration** - Optionally adds `~/.local/bin` to your PATH

## Verification

After setup, run the verification suite:

```bash
./scripts/verify-fork.sh
```

This checks 56+ aspects of your installation:
- Prerequisites (Bun, node_modules)
- Symlinks (agent, omp launcher)
- Core configuration (config.yml, roles.yml, AGENTS files)
- Extensions (orchestrator, implementation-engine, etc.)
- Rules system
- Skills system
- Agent definitions

## Features Enabled

Once set up, these fork-specific features work:

### Orchestrator Delegation
- `AGENTS-orchestrator.md` defines orchestrator behavior
- Task delegation to subagents via `task` tool
- Quality gate loops with `verifier` and `coderabbit`
- Worktree-based isolated execution

### Agent Configurations
All agent definitions in `agent/agents/`:
- `implement.md` - Implementation worker
- `debug.md` - Root-cause debugging
- `verifier.md` - Phase-end verification
- `code-reviewer.md` - Evidence-first review
- `grafana.md` - Grafana dashboard specialist
- And more...

### Extensions
- `orchestrator-mode/` - Task delegation management
- `implementation-engine/` - Quality gate orchestration
- `plan-mode/` - Structured planning workflows
- `ask-mode/` - Question-answer routing
- `mcp-filter/` - MCP tool filtering
- `worktree-policy/` - Git worktree management
- `live-log-watcher/` - Real-time log monitoring

### Skills
All skills in `agent/skills/` are available:
- `toon-delegation/` - Task delegation envelopes
- `writing-plans/` - Implementation planning
- `autoresearch/` - Autonomous research
- `grafana-dashboards/` - Dashboard creation
- And all others...

### Rules
All rules in `agent/rules/`:
- `orchestrator-mode.md` - Orchestrator boundaries
- `worker-protocol.md` - Worker agent protocol
- `quality-gate.md` - Quality gate requirements
- `planning-protocol.md` - Planning workflow
- `implementation-workflow.md` - Implementation phases
- `btca-usage.md` - Better Context patterns
- `persistent-artifact-language.md` - Writing guidelines

## Troubleshooting

### "omp: command not found"

Add to your shell config:

```bash
# ~/.bashrc or ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
```

Then restart your shell:
```bash
source ~/.bashrc  # or ~/.zshrc
```

### "Agent symlink points to wrong location"

Re-run setup:
```bash
./scripts/setup-fork.sh
```

Or manually fix:
```bash
rm ~/.omp/agent
ln -s /path/to/your/fork/agent ~/.omp/agent
```

### "MCP tools not working"

The MCP config now uses environment variables. Set these in your shell:

```bash
# ~/.bashrc or ~/.zshrc
export BTCA_API_KEY="your_key_here"
export REF_API_KEY="your_key_here"
export GRAFANA_URL="http://your-grafana-instance"
export GRAFANA_PASSWORD="your_password"
```

### Hardcoded paths in old mcp.json

The old `mcp.json` had hardcoded paths. The new version uses environment variables. Run setup to get the updated template:

```bash
./scripts/setup-fork.sh
```

## Updating Your Fork

After pulling updates:

```bash
cd ~/oh-my-pi  # or wherever you cloned

# Pull latest changes
git pull origin main

# Update dependencies
bun install

# Re-run setup if needed
./scripts/setup-fork.sh

# Verify
./scripts/verify-fork.sh
```

## File Structure

```
oh-my-pi/
├── agent/                  # Agent configuration (symlinked to ~/.omp/agent)
│   ├── AGENTS.md           # Main agent rules
│   ├── AGENTS-orchestrator.md  # Orchestrator-specific
│   ├── config.yml          # Agent config
│   ├── roles.yml           # Role definitions
│   ├── agents/             # Individual agent definitions
│   ├── extensions/         # Mode extensions
│   ├── rules/              # Rule files
│   ├── skills/             # Skill definitions
│   └── mcp.json            # MCP server config
├── packages/
│   └── coding-agent/       # Main CLI application
├── omp                     # Launcher script
├── scripts/
│   ├── setup-fork.sh       # Main setup script
│   ├── install-fork.sh     # Fresh clone installer
│   └── verify-fork.sh      # Verification suite
└── node_modules/           # Dependencies
```

## Advanced Usage

### Custom Install Directory

```bash
./scripts/install-fork.sh --dir ~/projects/my-omp
```

### Skip Clone (if already cloned)

```bash
./scripts/install-fork.sh --skip-clone
```

### Verify Only

```bash
./scripts/setup-fork.sh --verify-only
```

### Non-Interactive Setup

```bash
./scripts/setup-fork.sh --no-shell
```

## Support

If verification fails:

1. Check error messages from `./scripts/verify-fork.sh`
2. Ensure all symlinks point correctly: `ls -la ~/.omp/ ~/.local/bin/`
3. Check Bun is working: `bun --version`
4. Re-run setup: `./scripts/setup-fork.sh`

## Why This Setup?

The original oh-my-pi package installs globally via npm/bun. When you fork:

1. Global install uses original package, not your fork
2. Agent configs load from `~/.omp/agent`, not your fork
3. Extensions and skills are missing

This setup ensures:
- `omp` command uses your fork's code
- `~/.omp/agent` symlinks to your fork's agent directory
- All your customizations are active

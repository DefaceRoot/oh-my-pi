# README

This response provides the complete documentation for the `README.md` file of the `DefaceRoot/oh-my-pi` repository, covering all sections, subsections, code examples, file paths, configuration snippets, architecture details, and diagrams as requested.   

## oh-my-pi: AI coding agent for the terminal

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="Pi Monorepo">
</p>


This project is an AI coding agent for the terminal, forked from `badlogic/pi-mono` by `@mariozechner`.  

## Table of Contents

The `README.md` includes the following sections: 

*   [Highlights](#highlights)
*   [Installation](#installation)
*   [Getting Started](#getting-started)
    *   [Terminal Setup](#terminal-setup)
    *   [API Keys & OAuth](#api-keys--oauth)
    *   [First 15 Minutes (Recommended)](#first-15-minutes-recommended)
*   [Usage](#usage)
    *   [Slash Commands](#slash-commands)
    *   [Editor Features](#editor-features)
    *   [Keyboard Shortcuts](#keyboard-shortcuts)
    *   [Bash Mode](#bash-mode)
    *   [Image Support](#image-support)
*   [Sessions](#sessions)
    *   [Session Management](#session-management)
    *   [Context Compaction](#context-compaction)
    *   [Branching](#branching)
    *   [Autonomous Memory](#autonomous-memory)
*   [Configuration](#configuration)
    *   [Project Context Files](#project-context-files)
    *   [Custom System Prompt](#custom-system-prompt)
    *   [Custom Models and Providers](#custom-models-and-providers)
    *   [Settings File](#settings-file)
*   [Extensions](#extensions)
    *   [Themes](#themes)
    *   [Custom Slash Commands](#custom-slash-commands)
    *   [Skills](#skills)
    *   [Hooks](#hooks)
    *   [Custom Tools](#custom-tools)
*   [CLI Reference](#cli-reference)
*   [Tools](#tools)
*   [Programmatic Usage](#programmatic-usage)
    *   [SDK](#sdk)
    *   [RPC Mode](#rpc-mode)
    *   [HTML Export](#html-export)
*   [Philosophy](#philosophy)
*   [Development](#development)
*   [Monorepo Packages](#monorepo-packages)
*   [License](#license)

## Highlights

### + Commit Tool (AI-Powered Git Commits)

This tool provides AI-powered conventional commit generation with intelligent change analysis. 

Key features include: 
*   **Agentic mode**: Uses tools like `git-overview`, `git-file-diff`, and `git-hunk` for detailed analysis.
*   **Split commits**: Automatically separates unrelated changes into atomic commits with dependency ordering.
*   **Hunk-level staging**: Allows staging individual hunks when changes span multiple concerns.
*   **Changelog generation**: Proposes and applies changelog entries to `CHANGELOG.md` files.
*   **Commit validation**: Detects filler words, meta phrases, and enforces conventional commit format.
*   **Legacy mode**: A `--legacy` flag provides a deterministic pipeline.
*   It can be run via `omp commit` with options such as `--push`, `--dry-run`, `--no-changelog`, and `--context`. 

### + Python Tool (IPython Kernel)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/python.webp?raw=true" alt="python">
</p>


This tool allows executing Python code with a persistent IPython kernel and rich helper prelude. 

Features include: 
*   **Streaming output**: Real-time stdout/stderr with image and JSON rendering.
*   **Prelude helpers**: Built-in file I/O, search, find/replace, line operations, shell, and text utilities.
*   **Line operations**: Specific helpers like `lines()`, `insert_at()`, `delete_lines()`, `delete_matching()` for precise edits.
*   **Shared gateway**: Resource-efficient kernel reuse across sessions, configurable via `python.sharedGateway` setting.
*   **Custom modules**: Load extensions from `.omp/modules/` and `~/.omp/agent/modules/`.
*   **Rich output**: Supports `display()` for HTML, Markdown, images, and interactive JSON trees.
*   **Markdown rendering**: Python cell output with Markdown content renders inline.
*   **Mermaid diagrams**: Renders mermaid code blocks as inline graphics in iTerm2/Kitty terminals.
*   Dependencies can be installed via `omp setup python`. 

### + LSP Integration (Language Server Protocol)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/lspv.webp?raw=true" alt="lsp">
</p>


Provides full IDE-like code intelligence with automatic formatting and diagnostics. 

Capabilities include: 
*   **11 LSP operations**: `diagnostics`, `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `rename`, `code_actions`, `status`, `reload`.
*   **Format-on-write**: Auto-formats code using the language server's formatter (e.g., rustfmt, gofmt, prettier).
*   **Diagnostics on write/edit**: Immediate feedback on syntax errors and type issues after file changes.
*   **Workspace diagnostics**: Check the entire project for errors with the `lsp` action `diagnostics`.
*   **40+ language configs**: Out-of-the-box support for many languages including Rust, Go, Python, TypeScript, Java, etc.
*   **Local binary resolution**: Auto-discovers project-local LSP servers in `node_modules/.bin/`, `.venv/bin/`, etc.
*   **Symbol disambiguation**: The `occurrence` parameter resolves repeated symbols on the same line.

### + Time Traveling Streamed Rules (TTSR)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ttsr.webp?raw=true" alt="ttsr">
</p>


These are zero context-use rules that inject themselves only when needed. 

Mechanism: 
*   **Pattern-triggered injection**: Rules define regex triggers that monitor the model's output stream.
*   **Just-in-time activation**: When a pattern matches, the stream aborts, the rule injects as a system reminder, and the request retries.
*   **Zero upfront cost**: TTSR rules consume no context until they are relevant.
*   **One-shot per session**: Each rule triggers only once per session to prevent loops.
*   Rules are defined via the `ttsrTrigger` field in rule files, which specifies a regex pattern. 

Example: A rule preventing deprecated API usage only activates when the model starts writing deprecated code, saving context for other sessions. 

### + Interactive Code Review

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/review.webp?raw=true" alt="review">
</p>


Provides structured code review with priority-based findings. 

Features: 
*   **`/review` command**: Offers interactive mode selection for branch comparison, uncommitted changes, or commit review.
*   **Structured findings**: Uses the `report_finding` tool with priority levels (P0-P3: critical to nit).
*   **Verdict rendering**: Aggregates findings into approve/request-changes/comment.
*   A combined result tree shows the verdict and all findings.

### + Task Tool (Subagent System)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/task.webp?raw=true" alt="task">
</p>


This is a parallel execution framework with specialized agents and real-time streaming. 

Key aspects: 
*   **Bundled specialists**: Includes agents for exploration, implementation, planning, research, design, code review, linting, committing, merging, curation, verification, worktree setup, and ask-mode scouts.
*   **Parallel exploration**: A reviewer agent can spawn explore agents for large codebase analysis.
*   **Real-time artifact streaming**: Task outputs stream as they are created, not just upon completion.
*   **Full output access**: Complete subagent output can be read via `agent://<id>` resources when previews truncate.
*   **Isolation backends**: `isolated: true` runs tasks in git worktrees, Unix fuse-overlay filesystems, or Windows ProjFS (`fuse-projfs`), with patch or branch merge strategies.
*   **Async background jobs**: Supports background execution with configurable concurrency (up to 100 jobs) and an `await` tool for blocking on results.
*   **Agent Control Center**: The `/agents` dashboard allows managing and creating custom agents.
*   **AI-powered agent creation**: Custom agent definitions can be generated with the architect model.
*   **Per-agent model overrides**: Specific models can be assigned to individual agents via the swarm extension. 
*   User-level (`~/.omp/agent/agents/`) and project-level (`.omp/agents/`) custom agents are supported. 

### + Model Roles

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/models.webp?raw=true" alt="models">
</p>


Allows configuring different models for different purposes with automatic discovery. 

Details: 
*   **Role-based routing**: Includes `default`, `orchestrator`, `explore`, `implement`, `plan`, and specialist roles like `commit`, `lint`, `merge`.
*   **Configurable discovery**: Role defaults are auto-resolved and can be overridden per role.
*   **Role-based selection**: Task tool agents can use `model: pi/explore` for cost-effective reconnaissance.
*   CLI arguments (`--explore`, `--orchestrator`, `--plan`) and environment variables (`PI_EXPLORE_MODEL`, `PI_ORCHESTRATOR_MODEL`, `PI_PLAN_MODEL`) can be used for overrides.
*   Roles can be configured interactively via the `/model` selector and assignments can be persisted to settings.

### + Todo Tool (Task Tracking)

Provides structured task management with phased progress tracking. 

## Sessions

### Session Management

Sessions are managed through the `omp` command. 
*   `omp --resume <id-prefix>`: Resumes a session by its ID prefix.
*   `omp --resume <path>`: Resumes a session by its explicit `.jsonl` path.
*   `omp --session <value>`: An alias for `--resume`.
*   `omp --no-session`: Runs in ephemeral mode, preventing session saving.

Session IDs are Snowflake-style hex IDs. 

### Context Compaction

Context compaction summarizes older messages in long sessions to manage context windows, while keeping recent context. 

*   **Manual:** Use `/compact` or `/compact Focus on the API changes`. 
*   **Automatic:** Can be enabled via `/settings`. 
    *   **Overflow recovery**: The model returns context overflow, then compacts and retries. 
    *   **Threshold maintenance**: Context is compacted when it exceeds a configured headroom after a successful turn. 

**Configuration** (`~/.omp/agent/config.yml`): <cite repo="DefaceRoot/oh-my-pi"

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_50fdce44-b7cf-486e-8236-b29307512774


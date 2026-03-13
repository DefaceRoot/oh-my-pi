# CLI Reference

This response provides the complete documentation for the 'CLI Reference' section of the `README.md` file, detailing command-line options, subcommands, file arguments, examples, and environment variables for the `omp` CLI tool.     

## CLI Reference

The `omp` command-line interface follows the structure: 
```bash
omp [options] [@files...] [messages...]
omp <command> [args] [flags]
``` 

### Options

The following options are available for the `omp` command: 

| Option | Description |
|---|---|
| `--provider <name>` | Provider hint (legacy; prefer `--model`) |
| `--model <id>` | Model ID (supports fuzzy match) |
| `--explore <id>` | Override the `explore` role model for this run |
| `--orchestrator <id>` | Override the `orchestrator` role model for this run |
| `--plan <id>` | Override the `plan` role model for this run |
| `--models <patterns>` | Comma-separated model patterns for role cycling |
| `--list-models [pattern]` | List available models (optional fuzzy filter) |
| `--thinking <level>` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--api-key <key>` | API key (overrides environment/provider lookup) |
| `--system-prompt <text\|file>` | Replace system prompt |
| `--append-system-prompt <text\|file>` | Append to system prompt |
| `--mode <mode>` | Output mode: `text`, `json`, `rpc` |
| `--print`, `-p` | Non-interactive: process prompt and exit |
| `--continue`, `-c` | Continue most recent session |
| `--resume`, `-r [id\|path]` | Resume by ID prefix/path (or open picker if omitted) |
| `--session <value>` | Alias of `--resume` |
| `--session-dir <dir>` | Directory for session storage and lookup |
| `--no-session` | Don't save session |
| `--tools <tools>` | Restrict to comma-separated built-in tool names |
| `--no-tools` | Disable all built-in tools |
| `--no-lsp` | Disable LSP integration |
| `--no-pty` | Disable PTY-based interactive bash execution |
| `--extension <path>`, `-e` | Load extension file (repeatable) |
| `--hook <path>` | Load hook/extension file (repeatable) |
| `--no-extensions` | Disable extension discovery (`-e` paths still load) |
| `--no-skills` | Disable skills discovery and loading |
| `--skills <patterns>` | Comma-separated glob patterns to filter skills |
| `--no-rules` | Disable rules discovery and loading |
| `--allow-home` | Allow starting from home dir without auto-chdir |
| `--no-title` | Disable automatic session title generation |
| `--export <file> [output]` | Export session to HTML |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

### Subcommands

`omp` includes several dedicated subcommands: 

*   `commit`
*   `config`
*   `grep`
*   `jupyter`
*   `plugin`
*   `search` (alias: `q`)
*   `setup`
*   `shell`
*   `ssh`
*   `stats`
*   `update`

### File Arguments

Files can be included in prompts using the `@` prefix: 
```bash
omp @prompt.md "Answer this"
omp @screenshot.png "What's in this image?"
omp @requirements.md @design.png "Implement this"
``` 
Text files are embedded within `<file ...>` blocks, while images are attached. 

### Examples

Here are some examples of `omp` usage: 
```bash
# Interactive mode
omp
# Non-interactive
omp -p "List all .ts files in src/"
omp -c "What did we discuss?"
# Resume by ID prefix
omp -r abc123

# Model cycling with patterns
omp --models "sonnet:high,haiku:low"

# Restrict toolset for read-only review
omp --tools read,grep,find -p "Review the architecture"
# Export session
omp --export session.jsonl output.html
``` 

### Environment Variables

Key environment variables for configuring `omp` include: 

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. | Provider credentials |
| `PI_CODING_AGENT_DIR` | Override agent data directory (default: `~/.omp/agent`) |
| `PI_PACKAGE_DIR` | Override package directory resolution |
| `PI_EXPLORE_MODEL`, `PI_ORCHESTRATOR_MODEL`, `PI_PLAN_MODEL` | Role-model overrides |
| `PI_NO_PTY` | Disable PTY-based bash execution |
| `VISUAL`, `EDITOR` | External editor command (editor binding is configurable) |

A complete reference for environment variables is available in `docs/environment-variables.md`. 

## Notes

The provided context focuses specifically on the 'CLI Reference' section of the `README.md` file. Other sections of the `README.md` such as 'Highlights', 'Installation', 'Usage' (for in-chat slash commands), 'Sessions', 'Configuration', and 'Extensions' were not included as they fall outside the scope of the 'CLI Reference'.  The `CHANGELOG.md` and `DEVELOPMENT.md` files, while related to the `pi-coding-agent` package, do not directly contribute to the CLI reference documentation.  

Wiki pages you might want to explore:
- [Overview (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#1)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_5f6f90ab-ed73-45e9-a8a8-242b8e673541


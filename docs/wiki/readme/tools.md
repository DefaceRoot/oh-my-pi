# Tools

You're asking for the complete documentation of the 'Tools' section within the `README.md` file of the `DefaceRoot/oh-my-pi` repository. This section details the built-in tools available, how to restrict them, and provides examples. 

## Tools Documentation

The 'Tools' section in the `README.md` provides an overview of the built-in tools and how to manage their availability. 

### Restricting Tools

You can restrict the available built-in tools using the `--tools <list>` command-line option. 

### Built-in Tool Names (`--tools`)

The following table lists the built-in tools, along with a brief description of each: 

| Tool | Description |
|---|---|
| `ask` | Ask the user structured follow-up questions (interactive mode)  |
| `bash` | Execute shell commands  |
| `python` | Execute Python code in IPython kernel  |
| `calc` | Deterministic calculator/evaluator  |
| `ssh` | Execute commands on configured SSH hosts  |
| `edit` | In-place file editing with LINE#ID anchors  |
| `find` | Find files by glob pattern  |
| `grep` | Search file content  |
| `ast_grep` | Structural code search using AST matching (ast-grep)  |
| `ast_edit` | Structural AST-aware code rewrites (ast-grep)  |
| `lsp` | Language server actions (11 operations)  |
| `notebook` | Edit Jupyter notebooks  |
| `read` | Read files/directories (default text cap: 3000 lines)  |
| `browser` | Browser automation tool (model-facing name: `puppeteer`)  |
| `task` | Launch subagents for parallel execution  |
| `await` | Block on async background jobs  |
| `todo_write` | Phased task tracking with progress management  |
| `fetch` | Fetch and extract URL content  |
| `web_search` | Multi-provider web search  |
| `deep_search` | AI-powered deep research with synthesized results (Exa)  |
| `code_search` | Search code snippets and technical documentation (Exa)  |
| `write` | Create/overwrite files  |
| `generate_image` | Generate or edit images using Gemini image models  |

### Notes on Tool Availability

*   Some tools are gated by settings, such as `calc` and `browser`. 
*   The `ask` tool requires an interactive UI. 
*   The `ssh` tool requires configured SSH hosts. 

### Example Usage

To restrict the toolset for a read-only review, you can use the following command: 

```bash
omp --tools read,grep,find -p "Review this codebase"
``` 

### Adding New Tools

For information on adding new tools, refer to the "Custom Tools" section. 

## Notes

The provided context focuses on the `README.md` file's "Tools" section. Other snippets, such as `packages/coding-agent/src/prompts/system/system-prompt.md` , `packages/coding-agent/DEVELOPMENT.md` , and `.omp/skills/system-prompts/SKILL.md` , discuss how tools are integrated into system prompts, how to add new built-in tools, and tool documentation templates, respectively. While related to tools, they are not part of the "Tools" section within the `README.md` as requested. The `packages/coding-agent/src/exa/search.ts`  and `packages/coding-agent/src/discovery/codex.ts`  files provide implementation details for specific tools and tool discovery, but again, are not part of the `README.md` documentation.

Wiki pages you might want to explore:
- [Core Concepts (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_8bd819b9-5d3c-41b5-beb6-be81126c3cc0


# Configuration

This response provides detailed documentation for the 'Configuration' section of the `README.md` file, covering project context files, custom system prompts, custom models and providers, and the settings file. It includes relevant file paths, configuration snippets, and architectural details as described in the provided context.

## Configuration

The system's behavior is highly configurable, allowing for customization of various aspects, including project context, system prompts, models, and general settings. 

### Project Context Files

Project context is discovered from supported configuration directories such as `.omp`, `.claude`, `.codex`, and `.gemini`. 

Common files used for project context include:
*   `AGENTS.md` 
*   `CLAUDE.md` 

These files are utilized for:
*   Project instructions and guardrails 
*   Common commands and workflows 
*   Architecture documentation 
*   Coding/testing conventions 

### Custom System Prompt

You can replace the default system prompt by creating a `SYSTEM.md` file. 

The system prioritizes `SYSTEM.md` files in the following order:
1.  **Project-local:** `.omp/SYSTEM.md` (takes precedence) 
2.  **Global:** `~/.omp/agent/SYSTEM.md` (fallback) 

The `--system-prompt` command-line argument overrides both files, and `--append-system-prompt` can be used to add additional instructions. 

### Custom Models and Providers

Custom providers and models can be added via `~/.omp/agent/models.yml`.  While `models.json` is still supported for legacy configurations, `models.yml` is the modern format. 

An example `models.yml` configuration for an Ollama provider is shown below: 
```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: OLLAMA_API_KEY
    api: openai-completions
    models:
      - id: llama-3.1-8b
        name: Llama 3.1 8B (Local)
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 32000
``` 

Supported API types for providers include: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, and `google-vertex`. 

### Settings File

Global settings are stored in `~/.omp/agent/config.yml`.  Project-specific overrides can be loaded from discovered project settings files, typically `.omp/settings.json`. 

An example of a global `config.yml` is provided: 
```yaml
theme:
  dark: titanium
  light: light

modelRoles:
  default: anthropic/claude-sonnet-4-20250514
  orchestrator: anthropic/claude-opus-4-1:high
  explore: anthropic/claude-sonnet-4-20250514
defaultThinkingLevel: high
enabledModels:
  - anthropic/*
  - "*gpt*"
  - gemini-2.5-pro:high

steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

shellPath: C:\\path\\to\\bash.exe
hideThinkingBlock: false
collapseChangelog: false

disabledProviders: []
disabledExtensions: []
``` 

The `settings-schema.ts` file defines the structure and default values for various settings, including those related to tools like `checkpoint.enabled`.  For instance, `checkpoint.enabled` is a boolean setting that enables the checkpoint and rewind tools, with a default value of `false`.  Other settings like `commit.mapReduceEnabled` and `thinkingBudgets.minimal` are also defined within this schema. 

## Notes

The user's prompt specifically asked for the 'Configuration' wiki page under the 'README' section. The provided context included a `README.md` file with a 'Configuration' section, which was used as the primary source for this documentation. Additionally, the 'Context Management' wiki page provided details on `compaction` settings, which are also a form of configuration. While the prompt did not explicitly ask for `compaction` configuration, it is a significant part of the overall configuration system and was included for completeness.  

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_5446ad8f-bc66-4eb4-a76d-f7690aa7874e


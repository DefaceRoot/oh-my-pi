# Project Context Files

This document outlines the functionality and configuration of Project Context Files within the `oh-my-pi` system, based on the provided `README.md` and related source files. Project Context Files are used to provide instructions, guardrails, and other relevant information to the agent during its operation.  They are discovered from specific configuration directories and integrated into the system prompt. 

## Project Context Files Overview

`oh-my-pi` automatically discovers project context from designated configuration directories.  These files serve as a crucial mechanism for providing the agent with project-specific guidance. 

### Common Files

The most common Project Context Files include:
*   `AGENTS.md` 
*   `CLAUDE.md` 

### Use Cases

Project Context Files are utilized for various purposes, such as:
*   Defining project instructions and guardrails. 
*   Documenting common commands and workflows. 
*   Providing architecture documentation. 
*   Outlining coding and testing conventions. 

## Discovery and Loading

Project Context Files are discovered by various providers within the `oh-my-pi` system. The `loadProjectContextFiles` function in `packages/coding-agent/src/system-prompt.ts` is responsible for loading these files.  It uses the `contextFileCapability` to find relevant files. 

### Supported Configuration Directories and Files

The system supports discovery from several configuration directories and specific filenames:

*   **`.omp`**: This is a general configuration directory. 
    *   `AGENTS.md`: Discovered in project-level `.omp/agents/` directories and user-level `~/.omp/agent/` directories.  
*   **`.claude`**: Specific to Claude-related configurations. 
    *   `CLAUDE.md`: Discovered in user-level `~/.claude/` and project-level `.claude/` directories.  
*   **`.codex`**: Specific to OpenAI Codex configurations. 
    *   `AGENTS.md`: Discovered in user-level `~/.codex/` directories. 
*   **`.gemini`**: Specific to Google Gemini configurations. 
    *   `GEMINI.md`: Discovered in user-level `~/.gemini/` and project-level `.gemini/` directories.  
*   **`.github`**: Used for GitHub Copilot related instructions. 
    *   `copilot-instructions.md`: Discovered in project-level `.github/` directories. 
*   **`.opencode`**: Used for OpenCode configurations. 
    *   `AGENTS.md`: Discovered in user-level `~/.config/opencode/` directories. 

### Discovery Process

The `loadProjectContextFiles` function performs the following steps:
1.  It calls `loadCapability` for `contextFileCapability.id` to retrieve all discovered context files. 
2.  The results, which are `ContextFile` items, are mapped to an array of objects containing `path`, `content`, and `depth`. 
3.  These files are then sorted by `depth` in descending order, ensuring that files closer to the current working directory appear later and are considered more prominent. 
4.  If a `mode` is provided in the options, the `mergeModeSpecificAgentsGuidance` function is called to merge mode-specific content from `AGENTS.md` files.  This function specifically looks for `AGENTS.md` files and loads mode-specific content if available, merging it with the existing content. 

### Example of Context File Inclusion in System Prompt

The content of these context files is injected into the system prompt. For instance, the `custom-system-prompt.md` template includes a section for `contextFiles`: 

```handlebars
{{#ifAny contextFiles.length git.isRepo}}
<project>
{{#if contextFiles.length}}
## Context
<instructions>
{{#list contextFiles join="\n"}}
<file path="{{path}}">
{{content}}
</file>
{{/list}}
</instructions>
{{/if}}
{{#if git.isRepo}}
## Version Control
Snapshot; does not update during conversation.
Current branch: {{git.currentBranch}}
Main branch: {{git.mainBranch}}
{{git.status}}
### History
{{git.commits}}
{{/if}}
</project>
{{/ifAny}}
``` 

This snippet demonstrates how the `path` and `content` of each discovered context file are formatted and included within an `<instructions>` block under a "Context" heading. 

## Notes

The `README.md` provides a high-level overview of Project Context Files.  The detailed implementation of how these files are discovered and loaded can be found in the `packages/coding-agent/src/discovery/` directory, with specific providers for different configuration types (e.g., `agents.ts`, `claude.ts`, `codex.ts`, `gemini.ts`, `github.ts`, `opencode.ts`, and `builtin.ts`).        The `packages/coding-agent/src/system-prompt.ts` file orchestrates the loading and merging of these files into the final system prompt. 

Wiki pages you might want to explore:
- [Core Concepts (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_50d743fa-b68e-4977-bcf3-e63c145d0931


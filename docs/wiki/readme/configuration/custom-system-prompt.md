# Custom System Prompt

This document outlines how to customize the system prompt in `oh-my-pi`, allowing you to replace the default system prompt or append additional instructions. You can achieve this through project-local or global files, or by using command-line interface (CLI) flags. The system prompt is constructed using a Handlebars template, which dynamically includes various contextual elements such as project files, Git information, skills, and rules.

## Custom System Prompt Configuration 

You can customize the system prompt by creating `SYSTEM.md` files in specific locations or by using CLI flags. 

### File Locations and Precedence 

The system checks for `SYSTEM.md` files in the following order of precedence (highest to lowest):
1.  **Project-local:** `.omp/SYSTEM.md`  
2.  **Global:** `~/.omp/agent/SYSTEM.md`  

If a project-local `SYSTEM.md` is found, it will be used. Otherwise, the global `SYSTEM.md` will be used as a fallback. 

### CLI Overrides 

You can override file-based custom system prompts using CLI flags:
*   `--system-prompt <text|file>`: This flag completely replaces any `SYSTEM.md` file content.  
*   `--append-system-prompt <text|file>`: This flag appends additional instructions to the system prompt, regardless of whether it's from a file or the `--system-prompt` flag.  

The `buildSystemPrompt` function in `packages/coding-agent/src/system-prompt.ts` is responsible for loading these customization files.  It first attempts to load `SYSTEM.md` files from user and project levels using `loadSystemPromptFiles`.  The `discoverSystemPromptFile` function in `packages/coding-agent/src/main.ts` handles the discovery of these files.  Similarly, `discoverAppendSystemPromptFile` handles `APPEND_SYSTEM.md`. 

## System Prompt Template Structure 

The custom system prompt is rendered using a Handlebars template, which allows for dynamic inclusion of various contextual elements.  The template file is located at `packages/coding-agent/src/prompts/system/custom-system-prompt.md`. 

The template includes the following sections:

### Customization and Appended Prompts 
*   `{{#if systemPromptCustomization}} {{systemPromptCustomization}} {{/if}}`: This block includes the content from discovered `SYSTEM.md` files. 
*   `{{customPrompt}}`: This inserts the content provided via the `--system-prompt` CLI flag. 
*   `{{#if appendPrompt}} {{appendPrompt}} {{/if}}`: This includes content from `APPEND_SYSTEM.md` files or the `--append-system-prompt` CLI flag. 

### Project Context 
The `<project>` section is included if there are `contextFiles` or if the current directory is a Git repository. 
*   **Context Files**: If `contextFiles` are present, they are listed with their paths and content. 
*   **Version Control**: If the current directory is a Git repository, information such as the current branch, main branch, Git status, and commit history is included.  The `test/system-prompt-templates.test.ts` file contains tests verifying the conditional rendering of these sections. 

### Skills 
If skills are available, the template includes a section describing them, emphasizing that the agent **MUST** scan descriptions and read `skill://<name>` if a skill covers the task domain. 

### Rules 
If rules are defined, they are included with a directive that the agent **MUST** read `rule://<name>` when working in that domain.  Rules can be configured to `alwaysApply` or apply based on `globs` matching file patterns. 

### Environment Information 
The current date and time (`{{dateTime}}`) and the current working directory (`{{cwd}}`) are also included in the system prompt. 

## Programmatic System Prompt Construction 

The `buildSystemPrompt` function in `packages/coding-agent/src/system-prompt.ts` is the core logic for constructing the system prompt.  It takes an `BuildSystemPromptOptions` object  that allows for various customizations:
*   `customPrompt`: Replaces the default system prompt. 
*   `appendSystemPrompt`: Text to append to the system prompt. 
*   `tools`: Tools to include in the prompt. 
*   `skills`: Skills provided directly or discovered based on `skillsSettings`. 
*   `contextFiles`: Pre-loaded context files. 
*   `rules`: Pre-loaded rulebook rules. 

The `buildSystemPrompt` function orchestrates the loading of custom system prompt files, context files, and skills, and then renders the final prompt using the `customSystemPromptTemplate` or `systemPromptTemplate` based on whether a `customPrompt` is provided.  

The `sdk.ts` file also exposes a `buildSystemPrompt` function, which acts as a wrapper around the internal `buildSystemPromptInternal` (which is the same as `buildSystemPrompt` in `system-prompt.ts`) for programmatic usage.  This SDK function allows you to construct the system prompt with various options, including custom prompts, appended prompts, tools, skills, and context files. 

## Notes

The `Configuration` wiki page also mentions `APPEND_SYSTEM.md` as a file that can be used to append to the default system prompt.  This is handled similarly to `SYSTEM.md` but appends content rather than replacing it. 

Wiki pages you might want to explore:
- [Configuration (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#8)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_8970160a-1107-433c-becc-3760b2ce2d18


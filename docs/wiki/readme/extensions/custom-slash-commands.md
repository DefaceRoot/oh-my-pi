# Custom Slash Commands

This document provides detailed information about "Custom Slash Commands" within the `oh-my-pi` codebase, based on the provided wiki page and code snippets. Custom slash commands allow you to define reusable prompt commands using Markdown files or programmable TypeScript modules, extending the agent's capabilities.  They can be defined globally for the user or locally within a project. 

## Custom Slash Commands

Custom slash commands enable you to extend the agent's functionality by defining your own commands.  These commands can be implemented as Markdown files for simple prompt expansions or as TypeScript modules for more complex, programmable logic. 

### Markdown Custom Commands

Markdown files can be used to define reusable prompt commands. 

#### Locations 
Markdown custom commands are loaded from specific directories:
*   **Global**: `~/.omp/agent/commands/*.md` 
*   **Project**: `.omp/commands/*.md` 
*   **Claude-specific**: `~/.claude/commands/` and `.claude/commands/` 
*   **Codex-specific**: `~/.codex/commands/` and `.codex/commands/` 

The filename (without the `.md` extension) becomes the command name. 

#### Example 
```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
``` 

#### Argument Placeholders 
Markdown commands support argument placeholders:
*   `$1`, `$2`, ...: Positional arguments 
*   `$@` and `$ARGUMENTS`: All arguments joined 

The `expandSlashCommand` function in `packages/coding-agent/src/extensibility/slash-commands.ts` handles the substitution of these arguments into the command content.  It parses the command name and arguments from the input text, finds the corresponding file command, and then substitutes the arguments into the command's content. 

### TypeScript Custom Commands

For more advanced functionality, custom commands can be written in TypeScript.  These commands can execute arbitrary logic and have full access to the hook context. 

#### Locations 
TypeScript custom commands are loaded from:
*   `~/.omp/agent/commands/<name>/index.ts` 
*   `.omp/commands/<name>/index.ts` 

#### Structure and API 
A TypeScript custom command is defined by an `interface CustomCommand`  which includes:
*   `name`: The command name, which can include namespaces like "git:commit". 
*   `description`: A description shown in command autocomplete. 
*   `execute(args: string[], ctx: HookCommandContext)`: The function that executes the command.  It can return a string to be sent to the LLM as a prompt, or `void`/`undefined` for fire-and-forget actions. 

Commands are created via a `CustomCommandFactory` function, which receives a `CustomCommandAPI` object.  The `CustomCommandAPI` provides utilities such as:
*   `cwd`: Current working directory. 
*   `exec(command: string, args: string[], options?: ExecOptions)`: To execute shell commands. 
*   `typebox`: Injected `@sinclair/typebox` module. 
*   `pi`: Injected `pi-coding-agent` exports. 

The `HookCommandContext` passed to the `execute` method provides UI dialogs, session control, and shell execution capabilities. 

#### Examples 
**Fire-and-forget action:**
```typescript
const factory: CustomCommandFactory = (pi) => ({
	  name: "deploy",
	  description: "Deploy current branch to staging",
	  async execute(args, ctx) {
		 const env = args[0] || "staging";
		 const confirmed = await ctx.ui.confirm("Deploy", `Deploy to ${env}?`);
		 if (!confirmed) return;

		 const result = await pi.exec("./deploy.sh", [env]);
		 if (result.exitCode !== 0) {
			ctx.ui.notify(`Deploy failed: ${result.stderr}`, "error");
			return;
		 }

		 ctx.ui.notify("Deploy successful!", "info");
		 // No return = no prompt sent to LLM
	  }
});
``` 

**Returning a prompt to the LLM:**
```typescript
// Return a prompt to send to the LLM
const factory: CustomCommandFactory = (pi) => ({
	  name: "git:status",
	  description: "Show git status and suggest actions",
	  async execute(args, ctx) {
		 const result = await pi.exec("git", ["status", "--porcelain"]);
		 return `Here's the git status:\n\`\`\`\n${result.stdout}\`\`\`\nSuggest what to do next.`;
	  }
});
``` 

### Command Discovery and Loading

The system discovers and loads custom slash commands from various sources. 

#### Markdown Command Discovery
Markdown commands are discovered by functions like `loadSlashCommands` in `packages/coding-agent/src/discovery/agents.ts`, `packages/coding-agent/src/discovery/claude-plugins.ts`, `packages/coding-agent/src/discovery/codex.ts`, and `packages/coding-agent/src/discovery/opencode.ts`.     These functions scan predefined directories (user-level, project-level, and specific to Claude/Codex configurations) for `.md` files.     The `transform` function extracts the command name from the filename and the content from the Markdown file, including frontmatter for metadata like `description`. 

#### TypeScript Command Discovery
TypeScript custom commands are discovered by `discoverCustomTSCommands` in `packages/coding-agent/src/sdk.ts`.  This function loads commands from the current working directory and the agent directory. 

#### Integration with Interactive Mode
In `InteractiveMode`, custom commands, hook commands, and skill commands are gathered and stored in `this.pendingSlashCommands` for use in the UI.  The `UiHelpers.isKnownSlashCommand` function checks if a given input text corresponds to a known built-in, extension, custom, or file-based slash command. 

### Overriding Commands
Bundled commands can be overridden by user or project-defined commands with the same name.  The `discoverCommands` function in `packages/coding-agent/src/task/commands.ts` handles this precedence, where project-level commands take precedence over user-level, and both override bundled commands. 

## Notes

The `User Interface` wiki page provides a high-level overview of the UI architecture, including execution modes, component hierarchy, and the controller pattern.  While it mentions `CommandController` handling slash command execution,  the detailed implementation of custom slash commands is found in the `extensibility` and `discovery` packages. The `Context Management` wiki page is not directly relevant to custom slash commands. 

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)
- [User Interface (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#5)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_c8c8da22-3489-4461-81a8-970ec846f521


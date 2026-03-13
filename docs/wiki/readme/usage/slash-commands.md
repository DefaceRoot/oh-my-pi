# Slash Commands

This response provides documentation for "Slash Commands" within the "Usage" section, detailing both built-in and custom slash commands, their functionalities, and how they are discovered and executed.

## Usage 
### Slash Commands 

Slash commands are in-chat commands used to interact with the AI coding agent . They are processed by the `CommandController` .

#### Built-in Slash Commands
The system includes a registry of built-in slash commands . These commands are defined in `BUILTIN_SLASH_COMMAND_REGISTRY`  and can be executed using the `executeBuiltinSlashCommand` function . The `parseBuiltinSlashCommand` function is used to extract the command name and arguments from the input text .

Here is a list of some built-in slash commands and their descriptions:
| Command | Description |
| ------- | ----------- |
| `/settings` | Open settings menu  |
| `/plan` | Toggle plan mode  |
| `/model` (`/models`) | Open model selector  |
| `/fast` | Toggle fast mode  |
| `/export [path]` | Export session to HTML file  |
| `/dump` | Copy session transcript to clipboard  |
| `/share` | Share session as a secret GitHub gist  |
| `/browser [headless|visible]` | Toggle browser headless vs visible mode  |
| `/copy` | Copy last agent message to clipboard  |
| `/session` | Show session info and stats  |
| `/jobs` | Show async background jobs status  |
| `/usage` | Show provider usage and limits  |
| `/merge-omp` | Fetch upstream OMP changes, merge safely, install dependencies, and relaunch  |
| `/background` (`/bg`) | Detach UI and continue running in background  |
| `/debug` | Open debug tools selector  |
| `/memory` | Inspect and operate memory maintenance  |
| `/move <path>` | Move session to a different working directory  |
| `/exit` (`/quit`) | Exit the application  |

The `shutdownHandler` is used by `/exit` and `/quit` to clear the editor text and initiate application shutdown .

#### Custom Slash Commands
You can define custom slash commands using Markdown or TypeScript . These commands are discovered from specific directories .

##### Markdown Custom Commands
Markdown files can be used to define simple prompt commands .
- **Global commands**: Located in `~/.omp/agent/commands/*.md` .
- **Project-specific commands**: Located in `.omp/commands/*.md` .

The filename (without the `.md` extension) becomes the command name . Arguments can be passed using placeholders like `$1`, `$2`, or `$@` for all arguments .

Example Markdown command structure:
```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
``` 

These Markdown commands are loaded by functions like `loadSlashCommands` in `packages/coding-agent/src/discovery/opencode.ts` , `packages/coding-agent/src/discovery/builtin.ts` , `packages/coding-agent/src/discovery/claude.ts` , and `packages/coding-agent/src/discovery/codex.ts` .

##### TypeScript Custom Commands
More complex custom commands can be implemented using TypeScript .
- **Global commands**: `~/.omp/agent/commands/<name>/index.ts` .
- **Project-specific commands**: `.omp/commands/<name>/index.ts` .

These commands can execute arbitrary logic and have full access to the hook context . They can either return a string to be sent to the LLM as a prompt or return `void`/`undefined` for fire-and-forget operations . The `CustomCommandAPI` provides access to the current working directory, shell execution, and other modules .

Example TypeScript custom command:
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

The `InteractiveMode` initializes `CommandController`  and loads file commands for autocomplete . The `UiHelpers` class includes a method `isKnownSlashCommand` to check if a given text corresponds to a built-in, extension, or custom slash command .

## Notes
The provided context primarily focuses on the implementation and discovery of slash commands. While the prompt asks for a "complete, detailed documentation for the 'Slash Commands' wiki page (under the 'Usage' section)", the provided wiki page "User Interface" does not contain a dedicated "Slash Commands" section under "Usage". Instead, the `README.md` file contains a "Slash Commands" subsection under "Usage" . The information provided above is a synthesis of the relevant sections from the `README.md` and the code snippets related to slash command implementation and discovery.

Wiki pages you might want to explore:
- [User Interface (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#5)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_6f8dda1a-4d20-410f-ac32-af83c783e10c


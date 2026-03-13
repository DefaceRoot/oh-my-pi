# Extensions

You're asking for the complete documentation of the 'Extensions' section from the `README.md` file in the `DefaceRoot/oh-my-pi` repository, including all details like code examples, file paths, and architecture. 

## Extensions 

Extensions are the primary and preferred mechanism for customizing the `oh-my-pi` agent.  They are written in TypeScript and provide a rich API for interacting with the agent's lifecycle and UI. 

### Directory Structure 

Extensions can be single files or directory-based. 

```
<fork-root>/agent/                 # Repo-managed source of truth for this fork
├── extensions/                    # Extensions (preferred customization mechanism)
│   ├── my-extension.ts            # Single-file extension
│   └── implementation-engine/       # Directory extension
│       └── index.ts
```


Project-level extensions can also be defined: 
```
.omp/                             # Project-level (repo-specific)
├── extensions/*.ts
```


Extensions are loaded at startup, so `omp` must be restarted to pick up changes. 

### Capabilities of Extensions 

Extensions receive an `ExtensionAPI` object and can perform various actions: 
*   Subscribe to lifecycle events (session, agent, tool, input). 
*   Prompt users with interactive UI dialogs. 
*   Inject messages into conversations. 
*   Modify the system prompt per-turn. 
*   Register custom slash commands. 
*   Execute shell commands. 
*   Switch the session working directory. 
*   Persist state across sessions. 

### Extension Structure and Key Types 

A basic extension exports a default function that receives an `ExtensionAPI` object. 

```typescript
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Subscribe to events
  pi.on("before_agent_start", async (event, ctx) => {
    // ...
  });

  // Register slash commands
  pi.registerCommand("mycommand", {
    description: "Does something",
    handler: async (args, ctx) => {
      // ctx here is ExtensionCommandContext (superset of ExtensionContext)
    },
  });
}
```


Key types involved are: 

*   `ExtensionAPI`: The main API object available for the extension's entire lifetime.  It includes methods like `on`, `registerCommand`, `registerTool`, `exec`, `sendMessage`, `appendEntry`, and `logger`. 
*   `ExtensionContext`: Passed to event handlers as the second argument.  It provides access to UI methods (`ui`), current working directory (`cwd`), agent idle status (`isIdle`), and session management (`sessionManager`). 
*   `ExtensionCommandContext`: A superset of `ExtensionContext`, passed to command handlers.  It adds methods for session management like `newSession`, `branch`, and `waitForIdle`. 

### Available Events 

Extensions can subscribe to various lifecycle events: 

| Event              | Use For                                         | Return Type                 |
|--------------------|-------------------------------------------------|-----------------------------|
| `before_agent_start` | Intercept prompts, inject context, modify system prompt | `{ message?, systemPrompt? }` |
| `tool_call`        | Block tool execution (cannot modify inputs)     | `{ block?, reason? }`       |
| `tool_result`      | Modify tool output                              | `{ content?, isError? }`    |
| `session_start`    | Initialize on session load                      | —                           |
| `session_switch`   | Reset state on session change                   | —                           |
| `turn_end`         | Post-turn actions (checkpoints)                 | —                           |



### UI Methods (`ctx.ui`) 

The `ExtensionContext` provides UI methods for interaction: 

```typescript
ctx.ui.select("Question", ["A", "B", "C"])  // string | undefined
ctx.ui.confirm("Title", "Message")             // boolean
ctx.ui.input("Prompt:", "default")             // string | undefined
ctx.ui.editor("Edit:", "prefill")              // string | undefined
ctx.ui.notify("Message", "info")               // "info" | "warning" | "error"
ctx.ui.setStatus("key", "Text")                // undefined to clear
ctx.ui.setEditorText("Prefill input")
```


Note that UI methods return `undefined` if the user cancels. 

### Shell Execution 

Extensions can execute shell commands using `pi.exec`. 

```typescript
const res = await pi.exec("git", ["status"], { cwd: "/path" });
```


For background contexts, `Bun.spawn` should be used instead of `pi.exec` as `pi.exec` stdout can be unreliable. 

### Available Imports 

Extensions can import types from `@oh-my-pi/pi-coding-agent`, UI components, Node.js built-ins, and Bun APIs. 

```typescript
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

// UI components for custom message renderers
import { BorderedLoader, Text } from "@oh-my-pi/pi-coding-agent";
import { Container, Markdown, Spacer } from "@oh-my-pi/pi-tui";

// Node.js built-ins work
import * as fs from "node:fs";
import * as path from "node:path";

// Bun APIs available (extensions run inside omp's Bun runtime)
// Bun.spawn, Bun.file, Bun.glob, etc.
```


### Extension Control Center 

You can manage extensions using the `/extensions` slash command.  This opens the Extension Control Center, which allows you to: 
*   Browse provider tabs (`Tab` / `Shift+Tab`). 
*   Inspect each item source (`via <provider>` + file path). 
*   Disable full providers or specific items (`Space`). 

The `ExtensionDashboard` class is responsible for rendering this UI.  It initializes the state, creates a list of extensions, and an inspector panel. 

### Comparison with Hooks 

Extensions (`<fork-root>/agent/extensions/`) are loaded by the `ExtensionRunner` and receive `ExtensionAPI`.  Hooks (`<fork-root>/agent/hooks/`) are loaded by the `HookRunner` and receive `HookAPI`.  They are separate systems, and extensions are recommended for new work. 

## Notes

The prompt specifically asked for the 'Extensions' wiki page under the 'README' section. While `README.md` does have an 'Extensions' section in its Table of Contents , the detailed documentation for extensions is primarily found in `agent/skills/oh-my-pi-customization/SKILL.md` <cite repo="Def

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_6e354e12-9130-4fcb-9d3f-07483965c521


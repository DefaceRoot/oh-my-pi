# Custom Tools

This document provides detailed documentation for "Custom Tools" within the codebase, covering their definition, lifecycle, integration, and discovery. Custom tools allow you to extend the agent's capabilities with custom logic and UI rendering.  They are defined as TypeScript modules and can interact with the user interface and maintain state across sessions. 

## Custom Tool Definition

A custom tool is defined by the `CustomTool` interface, which specifies its name, label, description, parameters, execution logic, and optional rendering functions. 

### `CustomTool` Interface
The `CustomTool` interface includes the following properties:
- `name`: The tool's name, used in LLM tool calls. 
- `label`: A human-readable label for the UI. 
- `description`: A description for the LLM. 
- `parameters`: A TypeBox schema defining the tool's input parameters. 
- `hidden`: A boolean indicating if the tool is excluded unless explicitly listed. 
- `deferrable`: A boolean indicating if the tool may stage deferred changes. 
- `execute`: An asynchronous function that contains the core logic of the tool.  It receives `toolCallId`, `params`, `onUpdate` callback, `CustomToolContext`, and an optional `AbortSignal`. 
- `onSession`: An optional callback invoked on session lifecycle events for state reconstruction or cleanup. 
- `renderCall`: An optional function for custom rendering of the tool call display in the TUI. 
- `renderResult`: An optional function for custom rendering of the tool result display in the TUI. 

### `CustomToolFactory`
Custom tools are created using a `CustomToolFactory` function, which receives a `CustomToolAPI` object. 

```typescript
export type CustomToolFactory = (
	pi: CustomToolAPI,
) => CustomTool<any, any> | CustomTool<any, any>[] | Promise<CustomTool<any, any> | CustomTool<any, any>[]>;
``` 

### `CustomToolAPI`
The `CustomToolAPI` provides utilities and context to the custom tool factory:
- `cwd`: Current working directory. 
- `exec`: Function to execute shell commands. 
- `ui`: UI methods for user interaction (select, confirm, input, notify, custom). 
- `hasUI`: Boolean indicating UI availability. 
- `logger`: File logger for messages. 
- `typebox`: Injected `@sinclair/typebox` module. 
- `pi`: Injected `pi-coding-agent` exports. 
- `pushPendingAction`: Function to push a preview action that can be resolved later. 

### `CustomToolContext`
The `CustomToolContext` is passed to the `execute` and `onSession` callbacks, providing access to session state and model information:
- `sessionManager`: Read-only session manager. 
- `modelRegistry`: Model registry for API key resolution and model retrieval. 
- `model`: Current model. 
- `isIdle()`: Checks if the agent is idle. 
- `hasQueuedMessages()`: Checks for queued messages. 
- `abort()`: Aborts the current agent operation. 

### `CustomToolSessionEvent`
The `onSession` callback receives a `CustomToolSessionEvent` which can be one of several types, including:
- Session lifecycle events (`"start"`, `"switch"`, `"branch"`, `"tree"`, `"shutdown"`). 
- Auto-compaction events (`"auto_compaction_start"`, `"auto_compaction_end"`). 
- Auto-retry events (`"auto_retry_start"`, `"auto_retry_end"`). 
- TTSR triggered events (`"ttsr_triggered"`). 
- Todo reminder events (`"todo_reminder"`). 

## Custom Tool Discovery and Loading

Custom tools are discovered and loaded from specific directories. 

### File Paths
Custom tools are typically located in subdirectories with an `index.ts` file.  For example, `~/.omp/agent/tools/mytool/index.ts`.  Explicit paths can also be provided via `--tool` or `settings.json`. 

The `loadTools` function in `packages/coding-agent/src/discovery/builtin.ts` handles the discovery of custom tools.  It scans configuration directories for `tools` subdirectories and looks for `.json`, `.md`, `.ts`, `.js`, `.sh`, `.bash`, or `.py` files.  For directories, it specifically looks for an `index.ts` file within them. 

### Integration with Extensions
Discovered custom tools are wrapped and registered as extensions.  The `createCustomToolsExtension` function in `packages/coding-agent/src/sdk.ts` converts `CustomTool` instances into `ExtensionFactory` instances, which then register the tools with the extension API.  This allows custom tools to leverage the extension runner's capabilities, including session lifecycle events. 

## Example
A basic example of a custom tool factory:
```typescript
const factory: CustomToolFactory = (pi) => ({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({ input: Type.String() }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    // Access session state via ctx.sessionManager
    // Access model registry via ctx.modelRegistry
    // Current model via ctx.model
    return { content: [{ type: "text", text: "Done" }] };
  },

  onSession(event, ctx) {
    if (event.reason === "shutdown") {
      // Cleanup
    }
    // Reconstruct state from ctx.sessionManager.getEntries()
  }
});
``` 

More examples can be found in `examples/custom-tools/`. 

## Notes
The `CHANGELOG.md` indicates that custom tools now require an `index.ts` entry point within a subdirectory for auto-discovery.  This change allows multi-file tools to import helper modules.  The `sdk.ts` file plays a crucial role in integrating custom tools by converting them into `ToolDefinition` objects and registering them with the extension runner.  

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_ad5a2355-36f4-4eb5-a26b-dd9f3ce997da


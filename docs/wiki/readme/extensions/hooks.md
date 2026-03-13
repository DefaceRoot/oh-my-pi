# Hooks

This document provides detailed documentation for "Hooks" within the `oh-my-pi` system, covering their purpose, structure, configuration, and available APIs. Hooks are TypeScript modules that extend agent behavior by subscribing to lifecycle events, allowing for interception of tool calls, modification of results, and injection of messages . While still functional, "Extensions" are the preferred mechanism for new customizations .

## Overview of Hooks

Hooks are a system for extending the functionality of the `oh-my-pi` agent . They are TypeScript modules that can subscribe to various lifecycle events within the agent's operation . This allows them to:
*   Intercept and potentially modify agent behavior .
*   Interact with the user through UI primitives .
*   Inject messages into the agent session .

## Hook Locations and Loading

Hooks are auto-discovered from specific directories and can also be loaded via a CLI flag .

### Discovery Paths 
*   **Global**: `~/.omp/agent/hooks/pre/*.ts`, `~/.omp/agent/hooks/post/*.ts` 
*   **Project**: `.omp/hooks/pre/*.ts`, `.omp/hooks/post/*.ts` 

The `loadHooks` function in `packages/coding-agent/src/discovery/builtin.ts` is responsible for discovering built-in hooks . It iterates through configured directories and `pre`/`post` subdirectories to find `.ts` or `.js` files . Similarly, `packages/coding-agent/src/discovery/codex.ts` handles loading hooks from Codex-specific paths .

### CLI Flag
*   `--hook <path>`: Load hook files directly for testing without modifying settings .

### Module Loading
The `discoverAndLoadHooks` function in `packages/coding-agent/DEVELOPMENT.md` is the key entry point for loading hooks . It uses dynamic `import()` to load the hook modules and expects a default export function (`HookFactory`) . This factory function receives a `HookAPI` object to register event handlers, message renderers, and commands .

## Hook API

The `HookAPI` interface provides methods for hooks to interact with the agent .

### Event Subscription (`pi.on()`)
Hooks subscribe to events using `pi.on(event, handler)` . The handler function receives an event object and a `HookContext` .

#### Session Events 
*   `session_start`: After session initialization, before the first prompt .
*   `session_before_switch`: Before switching sessions .
*   `session_switch`: After a session switch .
*   `session_before_branch`: Before branching a session .
*   `session_branch`: After a session branch .
*   `session_before_compact`: Before compaction occurs . Hooks can provide a custom summary or cancel compaction .
*   `session_compact`: After a compaction entry is written .
*   `session_shutdown`: When the session is shutting down .
*   `session_before_tree`: Before tree navigation .
*   `session_tree`: After tree navigation .

#### Context and Agent Events
*   `context`: Modify messages non-destructively before each LLM call .
*   `before_agent_start`: Inject messages before the agent loop starts .
*   `agent_start`: When the agent starts its turn .
*   `agent_end`: When the agent finishes its turn .
*   `turn_start`: At the beginning of an agent turn .
*   `turn_end`: At the end of an agent turn .
*   `auto_compaction_start`: When automatic compaction begins .
*   `auto_compaction_end`: When automatic compaction ends .
*   `auto_retry_start`: When an automatic retry starts .
*   `auto_retry_end`: When an automatic retry ends .
*   `ttsr_triggered`: When a "time to stop reasoning" event is triggered .
*   `todo_reminder`: For todo reminders .
*   `tool_call`: Can block a tool call .
*   `tool_result`: Can modify tool results .

### Message Injection (`pi.sendMessage()`)
Hooks can inject messages into the agent session using `pi.sendMessage()` . These messages create `CustomMessageEntry` objects that participate in the LLM context and can be displayed in the TUI .

```typescript
pi.sendMessage(message, { triggerTurn: true }); 
```

### State Persistence (`pi.appendEntry()`)
For hook-specific data that should persist across sessions but *not* be sent to the LLM, `pi.appendEntry(customType, data)` can be used . This creates a `CustomEntry` .

### Custom TUI Rendering (`pi.registerMessageRenderer()`)
Hooks can register custom renderers for `CustomMessageEntry` types to control how their messages appear in the TUI .

### Custom Slash Commands (`pi.registerCommand()`)
Hooks can register custom slash commands with `pi.registerCommand(name, options)` . The handler for these commands receives a `HookCommandContext` .

### Shell Execution (`pi.exec()`)
The `pi.exec()` method allows hooks to execute shell commands and retrieve their output .

### Logger and Utility Modules
The `HookAPI` also provides access to a logger (`pi.logger`), `@sinclair/typebox` (`pi.typebox`), and `pi-coding-agent` exports (`pi.pi`) .

## Hook Contexts

### `HookContext`
This context is passed to all hook event handlers . It provides:
*   `ui`: Methods for user interaction (e.g., `confirm`, `select`, `input`, `notify`) .
*   `hasUI`: Indicates if a UI is available .
*   `cwd`: Current working directory .
*   `sessionManager`: A read-only session manager .
*   `modelRegistry`: For API key resolution and model retrieval .
*   `model`: The currently selected model <cite

Wiki pages you might want to explore:
- [Data Flow (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#2.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_cdede2dd-c488-49c2-908d-e9ef1e69e0eb


# SDK

This document provides detailed documentation for the SDK under the "Programmatic Usage" section, as requested. It covers how to embed the `omp` agent in Node.js/TypeScript applications, including session management, model selection, and extensibility options. The SDK is designed to offer fine-grained control over the agent's behavior .

## SDK

The SDK allows for programmatic interaction with the `omp` agent within Node.js/TypeScript applications .

### Usage Example

To use the SDK, you can import necessary modules like `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage` from `@oh-my-pi/pi-coding-agent` . The following example demonstrates how to create an in-memory agent session and interact with it:

```typescript
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});
session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("What files are in the current directory?");
``` 

This example initializes `authStorage` and `modelRegistry`, then creates an agent session using an in-memory `SessionManager` . It also subscribes to session events to stream assistant messages to standard output . Finally, it sends a prompt to the session .

### Control and Customization

The SDK provides extensive control over various aspects of the agent's operation :

*   **Model selection and thinking level**: Configure which models the agent uses and their "thinking" intensity .
*   **System prompt**: Replace or append to the default system prompt to guide the agent's behavior .
*   **Built-in/custom tools**: Manage the set of tools available to the agent, including both built-in and custom-defined tools .
*   **Hooks, skills, context files, slash commands**: Integrate custom logic, specialized knowledge, contextual information, and custom commands .
*   **Session persistence (`SessionManager`)**: Control how sessions are saved and loaded . The `SessionManager` offers static factories like `create()`, `open()`, `continueRecent()`, `inMemory()`, and `list()` for flexible session management .
*   **Settings (`Settings`)**: Override default settings programmatically . The `SettingsManager` provides `create(cwd?, agentDir?)` for file-based settings and `inMemory(settings?)` for testing, along with `applyOverrides()` for programmatic adjustments .
*   **API key and OAuth resolution**: Manage authentication credentials for various providers . The `ModelRegistry` class handles model discovery and API key resolution, combining built-in models with custom models from `models.json` and resolving API keys via `AuthStorage` .

### Model Registry

The `ModelRegistry` is a new class that centralizes model discovery and API key resolution . It replaces the older `resolveApiKey` callback pattern . Hooks and custom tools can access it via `ctx.modelRegistry` .

Example usage of `ModelRegistry` :
```typescript
import { discoverAuthStorage, discoverModels } from "@oh-my-pi/pi-coding-agent";

const authStorage = discoverAuthStorage(); // ~/.omp/agent/auth.json
const modelRegistry = discoverModels(authStorage); // + ~/.omp/agent/models.json

// Get all models (built-in + custom)
const allModels = modelRegistry.getAll();

// Get only models with valid API keys
const available = await modelRegistry.getAvailable();

// Find specific model
const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");

// Get API key for a model
const apiKey = await modelRegistry.getApiKey(model);
``` 

### Core Exports

The main entry point for the SDK is `packages/coding-agent/src/index.ts` . It re-exports various modules for programmatic usage, including:

*   `StringEnum` from `@oh-my-pi/pi-ai` for TypeBox helper for string enums .
*   TUI components like `Container`, `Markdown`, `Spacer`, `Text` from `@oh-my-pi/pi-tui` for custom tool rendering .
*   Logging utilities such as `getAgentDir`, `logger`, `VERSION` from `@oh-my-pi/pi-utils` .
*   Configuration related exports like `keybindings`, `model-registry`, `prompt-templates`, `settings` .
*   Extensibility features including `custom-commands`, `custom-tools`, `extensions`, and `skills` .
*   `discoverSlashCommands` for loading slash commands .
*   `lsp` types .
*   Run modes for programmatic SDK usage .
*   UI components for extensions, such as `ExtensionEditorComponent`, `ExtensionInputComponent`, `ExtensionSelectorComponent` .
*   Theme utilities for custom tools .
*   The SDK itself is exported from `./sdk` .
*   Session management components like `agent-session`, `auth-storage`, `compaction`, `messages`, and `session-manager` .
*   Task executor and types .
*   Tools details and utilities .

## Notes

The prompt specifically asked for the "SDK" wiki page under "Programmatic Usage". The provided context did not include a wiki page named "SDK". However, the `README.md` file contains a section "Programmatic Usage" with a subsection "SDK" . This response is based on the information found in the `README.md` and related `CHANGELOG.md` entries, as well as the `packages/coding-agent/src/index.ts` file which serves as the main entry point for the SDK .

The "Context Management" wiki page was not directly relevant to the SDK documentation, but it provides background on how context is handled within the agent, which is an underlying mechanism that the SDK interacts with .

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_8ba9bf6a-dd59-466e-916a-e0aecd10417f


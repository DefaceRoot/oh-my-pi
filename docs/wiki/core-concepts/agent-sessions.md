# Agent Sessions: The Central Abstraction

The user is asking for the complete documentation of the 'Agent Sessions: The Central Abstraction' wiki page, which is part of the 'Core Concepts' section. This page describes the `AgentSession` class, its responsibilities, and how it interacts with other components like `SessionManager` and `Settings` for managing the agent's lifecycle and conversation history.

The `AgentSession` class, defined in , is the core abstraction for agent lifecycle and session management. It is shared across all run modes (interactive, print, rpc) . Its key responsibilities include agent state access, event subscription with automatic session persistence, model and thinking level management, compaction (manual and auto), Bash execution, and session switching and branching .

## Agent Sessions: The Central Abstraction

The `AgentSession` class, located at `packages/coding-agent/src/session/agent-session.ts` , serves as the central coordinator for the agent's runtime. It bridges the core `Agent` runtime with durable storage mechanisms like `SessionManager` and `Settings` .

### Key Responsibilities

The `AgentSession` handles several critical aspects of the agent's operation :
*   **Event Subscription and Persistence**: It subscribes to agent events and automatically persists them to the session log .
*   **State Management**: It manages operational state not directly stored in the model history, such as abort controllers, retry counters, and queued messages .
*   **Compaction**: It orchestrates context management, including automatic and manual compaction of conversation history .
*   **Session Lifecycle**: It manages session switching, branching, and creation of new sessions .
*   **Model and Thinking Level Management**: It handles the selection and changes of models and thinking levels .

### Session Configuration

The `AgentSession` is initialized with an `AgentSessionConfig` interface , which includes various settings and dependencies :
*   `agent`: The core `Agent` instance .
*   `sessionManager`: Manages session persistence .
*   `settings`: Configuration settings for the agent .
*   `modelRegistry`: For API key resolution and model discovery .
*   `extensionRunner`: For handling extensions and hooks .

An example of `AgentSession` creation can be found in `createAgentSession` in `packages/coding-agent/src/sdk.ts` .

### Session State and Properties

The `AgentSession` maintains various internal states and exposes properties for external access :
*   `isCompacting`: Indicates if auto-compaction is currently running .
*   `messages`: All agent messages, including custom types .
*   `steeringMode`, `followUpMode`, `interruptMode`: Control how the agent interacts with the user .
*   `sessionFile`: The current session file path .

### Session Persistence and Management

The `AgentSession` relies on `SessionManager` for durable storage. The `SessionManager` uses an append-only tree structure in a JSONL file format .

#### SessionManager File Model
*   **Format**: NDJSON with a `SessionHeader` and typed `SessionEntry` records .
*   **Versioning**: `CURRENT_SESSION_VERSION = 3`, with migration functions for older versions .
*   **Tree Structure**: Entries are linked by `id` and `parentId`, supporting branching with a mutable leaf pointer .
*   **Append Operations**: Type-specific appends for messages, thinking level changes, model changes, compaction, and custom entries .

#### Session Restore and Switching
*   **`switchSession(sessionPath)`**: Aborts current work, flushes the writer, loads the target session file, rebuilds the branch-resolved context, replaces in-memory conversation, and restores the model and thinking level .
*   **`newSession(options)`**: Resets agent messages and creates a fresh session file .
*   **`fork()`**: Duplicates the current persisted session file and artifact directory .
*   **`branch(entryId)`**: Creates a branched session path from a selected user message .

### Settings Management

The `Settings` class, defined in `packages/coding-agent/src/config/settings.ts`, manages durable configuration separate from conversation content .
*   **Source Layers**: Global config (`<agentDir>/config.yml`), project capability settings, and runtime overrides .
*   **Persistence**: Settings are updated and saved to the global config file, with debounced writes and file locking .

### Relationship with other components

The `AgentSession` integrates with various other components:
*   **`Agent`**: The core runtime that `AgentSession` orchestrates .
*   **`SessionManager`**: Handles the persistence and retrieval of session data .
*   **`Settings`**: Provides configuration for the session .
*   **`ModelRegistry`**: Used for managing models and API keys .
*   **`HistoryStorage`**: Stores prompt history in SQLite, separate from session history .

## Notes

The provided context primarily focuses on the `AgentSession` class within the `packages/coding-agent` directory. While other files like `agent/skills/agent-browser/references/session-management.md` and various test files mention "session," they refer to different types of sessions (e.g., browser sessions or test setups) and are not directly related to the `AgentSession` as the central abstraction for agent lifecycle management. The `DEVELOPMENT.md` file provides a high-level overview and confirms the role of `AgentSession` as the runtime coordinator .

Wiki pages you might want to explore:
- [Context Management (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#3.2)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_d74e04b6-ea27-48ba-8a2b-08d4ff29dcfd


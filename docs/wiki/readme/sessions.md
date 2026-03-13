# Sessions

This response provides detailed documentation for the 'Sessions' section of the `README.md` file, covering session management, context compaction, branching, and autonomous memory. It includes descriptions, code examples, file paths, configuration snippets, and architectural details as requested.

## Sessions

The `oh-my-pi` agent provides robust session management capabilities, allowing you to save, resume, branch, and manage the context of your interactions. 

### Session Management

Sessions are managed through CLI flags and are identified by Snowflake-style hex IDs. 

**CLI Commands for Session Management:**
*   `omp --resume <id-prefix>`: Resumes a session using a prefix of its ID. 
*   `omp --resume <path>`: Resumes a session by providing the explicit path to its `.jsonl` file. 
*   `omp --session <value>`: An alias for `--resume`. 
*   `omp --no-session`: Starts the agent in an ephemeral mode, preventing the session from being saved. 

The `SessionManager` class in `packages/coding-agent/src/session/session-manager.ts` is responsible for persistence, handling the loading, saving, and manipulation of session data.  It uses an append-only tree structure in NDJSON format, with a `SessionHeader` and typed `SessionEntry` records. 

The `createAgentSession` function in `packages/coding-agent/src/sdk.ts` is used to create new agent sessions, with options for continuing previous sessions or full control over session parameters.  For example, to continue a previous session, you can use `createAgentSession({ continueSession: true })`. 

### Context Compaction

Context compaction helps manage long sessions by summarizing older messages to prevent exhausting the context window, while retaining recent context. 

**Compaction Methods:**
*   **Manual:** Use the `/compact` slash command, optionally with a focus message like `/compact Focus on the API changes`. 
*   **Automatic:** Can be enabled via `/settings`. 
    *   **Overflow recovery:** Automatically compacts and retries when the model returns a context overflow error. 
    *   **Threshold maintenance:** Compaction triggers when the context exceeds a configured headroom after a successful turn. 

**Configuration:**
Compaction settings are configured in `~/.omp/agent/config.yml`: 
```yaml
compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000
  autoContinue: true
``` 

### Branching

The agent supports branching to manage different lines of inquiry or development within a session. 

**In-place Navigation:**
*   Use the `/tree` command to navigate the session tree without creating new files. 
*   You can search by typing, page with `←`/`→`, and filter modes with `Ctrl+O`. 
*   Press `Shift+L` to label entries as bookmarks. 

**Creating New Sessions:**
*   The `/branch` or `/fork` commands allow you to create a new session file from a selected previous message. 
*   The `SessionManager` class provides methods like `createBranchedSession` to handle the creation of new session files based on a specific leaf ID.  This involves creating a new session ID, timestamp, and writing the relevant entries to a new `.jsonl` file. 

### Autonomous Memory

When enabled, the agent extracts durable knowledge from past sessions and injects it at startup.  This process runs in the background and does not block the active session. 

*   Memory is isolated per project (working directory) and stored under `~/.omp/agent/memories/`. 
*   A compact summary is injected into the system prompt at session start. 
*   The agent can access deeper context via `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`. 

**Managing Autonomous Memory:**
Use the `/memory` slash command: 
*   `/memory view`: Shows the current injection payload. 
*   `/memory clear`: Deletes all memory data and artifacts. 
*   `/memory enqueue`: Forces consolidation at the next startup. 

## Notes

The prompt specifically asked for the 'Sessions' wiki page under the 'README' section. The provided context included a `README.md` file with a "Sessions" section, which was used as the primary source for this documentation. Additionally, the `packages/coding-agent/DEVELOPMENT.md` file provided architectural details about `AgentSession` and `SessionManager`, which are highly relevant to understanding how sessions are handled internally. The `agent/skills/agent-browser/references/session-management.md` file was also considered, but it pertains to browser session management within a specific tool (`agent-browser`) rather than the general agent session management, so it was not included in the main answer to maintain focus on the core agent's session functionality.

Wiki pages you might want to explore:
- [Configuration (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#8)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_91bcdc18-7316-4bf1-af06-f287dc51e583


# Programmatic Usage

This document outlines the programmatic usage of `omp`, covering its SDK, RPC mode, and HTML export capabilities. You can embed `omp` into Node.js/TypeScript applications using the SDK, interact with it from other languages via RPC, or export session data to HTML.

## Programmatic Usage

### SDK

The SDK allows you to embed `omp` within Node.js/TypeScript applications. It provides control over various aspects of the agent's behavior.

**Example Usage:**
The following TypeScript code demonstrates how to create an agent session, subscribe to events, and prompt the session:
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


**Capabilities:**
The SDK provides control over the following aspects:
*   Model selection and thinking level
*   System prompt (replace or append)
*   Built-in/custom tools
*   Hooks, skills, context files, slash commands
*   Session persistence (`SessionManager`)
*   Settings (`Settings`)
*   API key and OAuth resolution

For more detailed information, refer to the [SDK Documentation](docs/sdk.md) and the examples located in `packages/coding-agent/examples/sdk/`.

### RPC Mode

RPC mode is suitable for embedding `omp` from other languages or for process isolation.

**Starting RPC Mode:**
You can start `omp` in RPC mode using the following command:
```bash
omp --mode rpc --no-session
```


**Sending Commands:**
JSON commands are sent via standard input (stdin).
```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
```


**Receiving Responses:**
Responses are emitted as `type: "response"`, and session events stream on stdout as they occur.

For the complete protocol details, refer to the [RPC Documentation](docs/rpc.md).

### HTML Export

You can export session files and JSON event logs to HTML.

**Export Commands:**
*   To export with an auto-generated filename:
    ```bash
    omp --export session.jsonl
    ```
    
*   To specify a custom filename:
    ```bash
    omp --export session.jsonl output.html
    ```
    

## Notes

The provided context focuses specifically on the "Programmatic Usage" section of the `README.md` file. Other sections of the `README.md` such as "Highlights", "Installation", "Configuration", and "Monorepo Packages" were not included as they fall outside the scope of programmatic usage.

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_d1cf8933-3bda-437b-b475-4e6804a2804d


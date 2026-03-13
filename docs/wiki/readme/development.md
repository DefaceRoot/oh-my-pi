# Development

The user is asking for the complete documentation of the 'Development' section from the `README.md` file . This section points to `packages/coding-agent/DEVELOPMENT.md` for detailed development information .

## Development Documentation

This document outlines the development workflow and architecture for the `packages/coding-agent` package .

### Subagent Execution and Isolation

The `runSubprocess` function in `packages/coding-agent/src/task/executor.ts` executes subagents in-process, not as separate child processes . Isolation is achieved through execution context and artifacts, not process memory .

#### Filesystem Isolation 
Filesystem isolation is controlled by the `task.isolation.mode` setting, which can be `"none"`, `"worktree"`, `"fuse-overlay"`, or `"fuse-projfs"` .
*   **`worktree`**: Uses `ensureWorktree(...)`, `applyBaseline(...)`, `captureDeltaPatch(...)`, and `cleanupWorktree(...)` . It handles nested non-submodule git repositories independently .
*   **`fuse-overlay`**: Employs `ensureFuseOverlay(...)`, `captureDeltaPatch(...)`, `cleanupFuseOverlay(...)` with `fuse-overlayfs` on Unix . On Windows, it falls back to `worktree` .
*   **`fuse-projfs`**: Utilizes `ensureProjfsOverlay(...)`, `captureDeltaPatch(...)`, `cleanupProjfsOverlay(...)` with ProjFS on Windows . Missing prerequisites or startup errors will cause a fallback to `worktree` or task failure .

#### Change Integration 
The `task.isolation.merge` setting dictates how isolated changes are integrated .
*   **`patch` (default)**: Captures a diff via `captureDeltaPatch(...)`, combines patches, and applies them with `git apply` .
*   **`branch`**: Each task commits to a temporary branch (`omp/task/<id>`) using `commitToBranch(...)`, and then `mergeTaskBranches(...)` cherry-picks them onto HEAD . If `git apply` fails, the agent result is preserved with a `merge failed` status .

#### Commit Messages 
The `task.isolation.commits` setting (`generic` or `ai`) controls commit messages . `ai` mode generates conventional commit messages from diffs . Nested repository patches are applied after the parent merge, grouped by repository . Child session outputs are written to the task artifacts directory .

### Tooling Surface in Child Sessions 
`runSubprocess(...)` determines active tools based on agent frontmatter and runtime rules .
*   The `task` tool is added if `agent.spawns` is set and recursion depth allows .
*   It's removed when `task.maxRecursionDepth` is reached .
*   The `exec` alias expands to `python` and/or `bash` based on `python.toolMode` .
*   `requireSubmitResultTool: true` is enforced in `createAgentSession(...)` .
*   Parent-owned tools like `todo_write` are filtered out of child tools .
*   If parent MCP connections exist, in-process MCP proxy tools are created to reuse parent connectivity .

### Submit/Result Contract and Completion Semantics 
`executor.ts` enforces structured completion around `submit_result` .
*   Tool events and extracted data are tracked via `subprocessToolRegistry` handlers .
*   Reminder prompts for `submit_result` are retried up to 3 times using `subagent-submit-reminder.md` .
*   `finalizeSubprocessOutput(...)` centralizes final output normalization .
    *   If `submit_result.status === "aborted"`, the task is converted to an aborted result payload .
    *   If `submit_result` is missing, a fallback attempts JSON parse/validation .
    *   Warnings are emitted if `submit_result` is missing/null and fallback validation fails .
*   Token/cost usage is accumulated from `message_end` events, and output is truncated with `truncateTail(...)` using `MAX_OUTPUT_BYTES` and `MAX_OUTPUT_LINES` .

### Parallelization Model 
`packages/coding-agent/src/task/parallel.ts` provides `mapWithConcurrencyLimit(...)` .
*   It uses worker-pool scheduling with ordered result slots .
*   Concurrency is normalized and bounded .
*   A parent abort signal stops new tasks, but running tasks complete their abort path .
*   The first non-abort worker error fails fast .
*   The return shape is `{ results: (R | undefined)[], aborted: boolean }` .
*   `TaskTool.execute(...)` post-processes partial results into explicit failed/aborted placeholders .

### Subprocess Tool Registry Hooks 
`packages/coding-agent/src/task/subprocess-tool-registry.ts` defines `subprocessToolRegistry` .
*   `register(toolName, handler)` attaches optional hooks :
    *   `extractData(event)` for structured extraction .
    *   `shouldTerminate(event)` for early child termination .
    *   `renderInline(...)` and `renderFinal(...)` for UI rendering .
*   The executor uses these hooks during `tool_execution_end` processing to build structured task outputs . This decouples tool-specific logic from generic task execution .

### Web I/O and Retrieval Architecture (`fetch`, `puppeteer`, `web_search`, scrapers) 

#### ASCII overview 
```text
fetch tool
  │
  ├── specialHandlers (web/scrapers)
  ├── generic fetch/convert/render pipeline
  └── truncation/artifact metadata

browser tool (puppeteer)
  ├── stateful page/session control
  ├── observe/interact/extract actions
  └── screenshot/readability outputs

web_search
  ├── resolveProviderChain(...)
  ├── provider attempts + fallback order
  └── formatted response for LLM
```

#### Responsibility boundaries 
*   `packages/coding-agent/src/tools/fetch.ts` implements the `fetch` tool (`FetchTool`) for URL retrieval and content transformation .
*   `packages/coding-agent/src/tools/browser.ts` implements the `puppeteer` tool (`BrowserTool`) for stateful browser automation .
*   `packages/coding-agent/src/web/search/index.ts` + `packages/coding-agent/src/web/search/provider.ts` handle web search orchestration, abstraction, and fallback .
*   `packages/coding-agent/src/web/scrapers/index.ts` is the special-handler registry used by `fetch` for site-specific extraction .
These are distinct pipelines for HTTP/content extraction, interactive browser control, and answer synthesis over external search APIs <cite repo="DefaceRoot/oh-my-pi" path="packages/coding-agent/DEVELOPMENT.md" start="998" end="9

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_1a57c352-8f78-4f60-935f-d85ff347784f


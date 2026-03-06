---
name: oh-my-pi-customization
description: Customize and extend Oh My Pi (omp) coding agent with extensions, rules, custom agents, and slash commands. Use this skill when creating custom workflows, intercepting tool calls, adding UI interactions, modifying agent behavior, or integrating external tools into omp.
---

# Oh My Pi Customization

Extend omp's behavior through **extensions**, rules, system prompts, and custom agents.

Definitions for this skill:
- `<fork-root>` = the local clone of your custom OMP fork
- live agent config = `~/.omp/agent -> <fork-root>/agent`

Edit the repo files directly and use `UPDATING.md` for the supported refresh loop.

Refresh rules for this fork:
- If you change files under `<fork-root>/packages/`, run `bun --cwd=<fork-root> run reinstall:fork` and restart `omp`.
- If you only change files under `<fork-root>/agent/`, restart `omp`.
- Git commit and push do not update the live local `omp` install.

## Extension Points Overview

| Type | Location | Purpose |
|------|----------|---------|
| **Extensions** | `<fork-root>/agent/extensions/*.{ts,js}` or `<fork-root>/agent/extensions/*/index.ts` | Full lifecycle events, UI prompts, commands, tools, process control |
| **Hooks (legacy)** | `<fork-root>/agent/hooks/{pre,post}/*.ts` | Older lifecycle hooks (still loaded, but prefer extensions) |
| **Rules** | `<fork-root>/agent/rules/*.md` | Inject context/constraints into system prompt |
| **System Prompt** | `<fork-root>/agent/AGENTS.md` or `.omp/SYSTEM.md` | Global instructions for all sessions |
| **Custom Agents** | `<fork-root>/agent/agents/*.md` | Subagent definitions spawned via Task tool |

## Directory Structure

```
<fork-root>/agent/                 # Repo-managed source of truth for this fork
├── extensions/                    # Extensions (preferred customization mechanism)
│   ├── my-extension.ts            # Single-file extension
│   └── plan-worktree/             # Directory extension
│       └── index.ts
├── hooks/                         # Legacy hooks
│   ├── pre/*.ts
│   └── post/*.ts
├── agents/                        # Custom agent definitions
│   ├── worktree-setup.md
│   ├── task.md                    # User override: worker with explore fan-out policy
│   └── explore.md                 # User override: read-only reconnaissance agent
├── rules/
│   └── my-rule.md
├── AGENTS.md                      # Global system prompt additions
├── config.yml                     # Agent configuration
└── settings.json                  # User settings

~/.omp/agent -> <fork-root>/agent

.omp/                             # Project-level (repo-specific)
├── extensions/*.ts
├── hooks/{pre,post}/*.ts
├── rules/*.md
└── SYSTEM.md                      # Project system prompt
```

---

## Extensions (TypeScript)

### Explore Delegation Pattern (Recommended)

For context-heavy tasks, keep parent/subagent context lean:

1. Use `task` agent for implementation work.
2. Have `task` spawn `explore` agents in parallel (typically 1-5) for independent discovery tracks.
3. Synthesize explore results, then implement with focused context.
4. Keep `explore` read-only and output-structured for reliable handoff.

Model roles:
- Set worker model via `/model` -> **Set as Subagent**
- Set scout model via `/model` -> **Set as Explore**

This split keeps reconnaissance cheap/fast while preserving stronger models for implementation and decisions.

Extensions are the **primary and preferred** customization mechanism. They receive an `ExtensionAPI` object and can:
- Subscribe to lifecycle events (session, agent, tool, input)
- Prompt users with interactive UI dialogs
- Inject messages into conversations
- Modify the system prompt per-turn
- Register custom slash commands
- Execute shell commands
- Switch the session working directory
- Persist state across sessions

### Extension Structure

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

### Key Types

```typescript
// The main API object — available for the extension's entire lifetime
interface ExtensionAPI {
  on(event, handler): void;           // Subscribe to events
  registerCommand(name, opts): void;  // Register /commands
  registerTool(def): void;            // Register custom tools
  exec(cmd, args, opts?): Promise<ExecResult>;  // Run shell commands
  sendMessage(msg, opts?): void;      // Inject messages into conversation
  appendEntry(type, data?): void;     // Persist state (not sent to LLM)
  logger: Logger;                     // File logger
  // ... more (see types.ts)
}

// Passed to event handlers as second argument
interface ExtensionContext {
  ui: ExtensionUIContext;     // UI methods (select, input, notify, etc.)
  hasUI: boolean;             // false in print/RPC mode
  cwd: string;                // Current working directory
  isIdle(): boolean;          // Whether agent is idle
  abort(): void;              // Abort current operation
  sessionManager: ReadonlySessionManager;
  // ...
}

// Superset of ExtensionContext, passed to command handlers
interface ExtensionCommandContext extends ExtensionContext {
  newSession(opts?): Promise<{ cancelled: boolean }>;
  branch(entryId): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
  // ...
}
```

### Available Events

#### Lifecycle Events
| Event | When | Can Modify |
|-------|------|------------|
| `session_start` | Session loads | No |
| `session_switch` | `/new`, `/resume`, `/fork` | Cancel via `session_before_switch` |
| `session_shutdown` | Exit (Ctrl+C/D) | No |

#### Agent Events
| Event | When | Can Modify |
|-------|------|------------|
| `before_agent_start` | User submits prompt, before agent loop | Return `{ message?, systemPrompt? }` |
| `agent_start` | Agent loop begins | No |
| `agent_end` | Agent loop ends | No |
| `turn_start` | Each LLM turn starts | No |
| `turn_end` | Each LLM turn ends | No |
| `context` | Before each LLM call | Modify messages |

#### Tool Events
| Event | When | Can Modify |
|-------|------|------------|
| `tool_call` | Before tool executes | **Block** with `{ block: true, reason }` (cannot modify inputs) |
| `tool_result` | After tool executes | Modify result content |

#### Input Events
| Event | When | Can Modify |
|-------|------|------------|
| `input` | User types in input box | Modify/replace text |

### UI Methods (ctx.ui)

```typescript
// Selection dialog — returns selected string or undefined if cancelled
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirmation dialog — returns true/false
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input — returns string or undefined if cancelled
const name = await ctx.ui.input("Name:", "default value");

// Multi-line editor (Ctrl+Enter to submit)
const text = await ctx.ui.editor("Edit:", "prefilled content");

// Notification (non-blocking toast)
ctx.ui.notify("Done!", "info"); // "info" | "warning" | "error"

// Status bar text (persistent until cleared)
ctx.ui.setStatus("my-key", "Processing...");
ctx.ui.setStatus("my-key", undefined); // Clear

// Pre-fill the input editor
ctx.ui.setEditorText("Generated prompt...");
```

### Injecting Messages

```typescript
// From before_agent_start handler — return a message
pi.on("before_agent_start", async (event, ctx) => {
  return {
    message: {
      customType: "my-extension/status",
      content: "Context for the LLM to see",
      display: true, // Show in TUI
      details: { /* metadata, not sent to LLM */ },
    },
  };
});

// From anywhere — use pi.sendMessage()
pi.sendMessage(
  { customType: "my-ext", content: "Injected message", display: true },
  { deliverAs: "steer" },  // "steer" | "followUp" | "nextTurn"
);

// triggerTurn: true will cause the LLM to respond to the message
pi.sendMessage(
  { customType: "result", content: "...", display: true },
  { triggerTurn: true },
);
```

### Modifying the System Prompt

`before_agent_start` can return a `systemPrompt` string to replace/extend it:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: event.systemPrompt + "\n\n## Extra Context\nYou are in a special mode.",
  };
});
```

### Blocking Tool Calls

```typescript
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // Can ONLY block — cannot modify event.input
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
    if (!ok) {
      return { block: true, reason: "Blocked by user" };
    }
  }
});
```

### Executing Shell Commands

```typescript
// pi.exec — works reliably DURING event handlers (before handler returns)
const result = await pi.exec("git", ["status"], { cwd: "/path/to/repo" });
// result: { stdout, stderr, code, killed }
```

<critical>
### pi.exec has broken stdout in background/post-return contexts

`pi.exec()` has a known issue: **stdout capture breaks when called after the event handler has returned** (e.g., in a fire-and-forget `void doBackground()` promise).

Symptoms: commands return `code: 0` but `stdout` is empty, even though the command ran.

**Workaround**: Use `Bun.spawn` directly for any commands that run outside the synchronous handler flow:

```typescript
async function run(cmd: string[], cwd: string, timeoutMs = 30_000) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`\`${cmd.join(" ")}\` failed (code ${code}): ${(stderr || stdout).trim()}`);
  }
  return { stdout, stderr, code };
}
```

**Rule of thumb**: Use `pi.exec` for anything that runs *during* `before_agent_start` (before you return). Use `Bun.spawn` for anything that runs *after* (background tasks, or synchronous work that happens after UI prompts if the agent loop has started).
</critical>

### Switching the Session Working Directory

`process.chdir()` changes the working directory for all subsequent tool operations. Call it in `before_agent_start` (before the agent loop starts) for reliable behavior:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // ... do setup work ...
  process.chdir("/path/to/new/working/directory");

  return {
    message: { customType: "switched", content: "Switched to new dir", display: true },
    systemPrompt: event.systemPrompt + "\n\nYou are now working in /path/to/new/working/directory.",
  };
});
```

This updates the TUI status bar (branch, path) and all tool cwd resolution.

### Persisting State

```typescript
// Save state (creates CustomEntry, not sent to LLM)
pi.appendEntry("my-extension-state", { count: 42 });

// Restore on session load
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-extension-state") {
      // Restore from entry.data
    }
  }
});
```

### Registering Custom Commands

```typescript
pi.registerCommand("worktree", {
  description: "Show worktree status",
  handler: async (args, ctx) => {
    // ctx is ExtensionCommandContext (has newSession, waitForIdle, etc.)
    const name = args.trim() || await ctx.ui.input("Branch name:");
    if (!name) return;

    ctx.ui.setStatus("worktree", "Creating...");
    await run(["git", "worktree", "add", `.worktrees/${name}`, "-b", name, "master"], process.cwd());
    ctx.ui.setStatus("worktree", undefined);
    ctx.ui.notify(`Created worktree: ${name}`, "info");
  },
});
```

---

<critical>
### Logger API

The `pi.logger` object has **only three methods**: `error`, `warn`, `debug`. There is **no `info` level**.

Signature: `(message: string, context?: Record<string, unknown>) => void`

This is NOT pino-style. The message is the **first** argument (string), optional context object is **second**.

```typescript
// CORRECT
pi.logger.debug("my-ext: something happened", { key: "value" });
pi.logger.error("my-ext: failed to do thing", { error: msg });
pi.logger.warn("my-ext: deprecated feature used");

// WRONG — will crash at runtime
pi.logger.info("...");                              // info does not exist
pi.logger.debug({ key: "value" }, "message");       // wrong argument order (pino-style)
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log`.
</critical>

---

## Hooks (TypeScript) — Legacy

Hooks still work but use the older `HookAPI` type from `@oh-my-pi/pi-coding-agent/hooks`. They support the same events and UI methods. For new work, use extensions.

```typescript
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
}
```

Test in isolation: `omp --hook ./my-hook.ts`

---

## Rules (Markdown)

Rules inject context into the system prompt. Use frontmatter to control when they apply.

```markdown
---
description: Short description shown in rule list
alwaysApply: true  # Always include in system prompt
# OR
globs: ["*.py", "src/**/*.ts"]  # Apply when these files are in context
---

# Rule Content

Instructions injected into the system prompt.

<critical>
Critical instructions the agent MUST follow.
</critical>
```

| Frontmatter | Type | Description |
|-------------|------|-------------|
| `description` | string | Description for rule listing |
| `alwaysApply` | boolean | Always inject into system prompt |
| `globs` | string[] | File patterns that trigger this rule |

---

## System Prompt (AGENTS.md / SYSTEM.md)

- **User-level for this fork**: `<fork-root>/agent/AGENTS.md` (exposed at runtime through the `~/.omp/agent` symlink)
- **Project-level**: `.omp/SYSTEM.md` — applies to one repo

Use `<critical>` tags for instructions the agent must follow. Use `<important>` for strong suggestions.

---

## Custom Agents

Custom agent definitions for this fork live in `<fork-root>/agent/agents/*.md`. They are exposed at runtime through the `~/.omp/agent` symlink and can be spawned via the Task tool.

```markdown
---
name: worktree-setup
description: Sets up isolated git worktree
tools: read, bash, find
model: pi/smol, haiku-4.5, gemini-3-flash
thinking-level: minimal
output:
  properties:
    worktree_path:
      type: string
    branch_name:
      type: string
---

<role>Git worktree setup specialist.</role>

<procedure>
## Inputs
- branch_name, base_branch, repo_root

## Steps
1. Validate git repo
2. Create worktree
3. Run setup
4. Submit result
</procedure>
```

---

## Common Pitfalls and Hard-Won Learnings

### 1. Extensions vs Hooks
Extensions (`<fork-root>/agent/extensions/`) are loaded by the `ExtensionRunner` and receive `ExtensionAPI`. Hooks (`<fork-root>/agent/hooks/`) are loaded by the `HookRunner` and receive `HookAPI`. They are **separate systems**. Use extensions for new work.

### 2. pi.exec stdout is unreliable in background contexts
See the critical section above. If you fire-and-forget a promise from `before_agent_start` and call `pi.exec` inside it, stdout will often be empty. Use `Bun.spawn` instead.

### 3. Logger has no `info` and uses (message, context) signature
`pi.logger.info(...)` will crash. Only `debug`, `warn`, `error` exist. Arguments are `(message: string, context?: Record)`, not pino-style `(context, message)`.

### 4. tool_call can only block, not modify
`ToolCallEventResult` only has `{ block?: boolean; reason?: string }`. You cannot rewrite tool inputs from an extension. To influence tool behavior, modify the system prompt or inject steering messages.

### 5. process.chdir() works for switching session cwd
Call it in `before_agent_start` before returning. The TUI status bar, bash tool cwd, and relative path resolution all update. The session's internal `cwd` field (stored in the session file header) does NOT update, but runtime behavior does.

### 6. before_agent_start can return message + systemPrompt
```typescript
return {
  message: { customType: "...", content: "...", display: true },
  systemPrompt: event.systemPrompt + "\n\nExtra instructions...",
};
```
Both are optional. `systemPrompt` replaces the entire system prompt for that turn (chain with `event.systemPrompt +` to append).

### 7. UI methods return undefined on cancel
`ctx.ui.select()`, `ctx.ui.input()` return `undefined` if the user cancels. Always check for falsy returns.

### 8. ctx.abort() stops the current operation
Call it when the user cancels a required prompt. The agent will not start its turn.

### 9. Avoid emoji and special Unicode in status/notification strings
The TUI has known width-calculation issues with emoji. Stick to ASCII in `ctx.ui.setStatus()` and `ctx.ui.notify()` to avoid rendering glitches and crashes (`omp-crash.log` will show "Rendered line exceeds terminal width").

### 10. Extensions are loaded at startup — restart omp to pick up changes
There is no hot-reload. After editing an extension file, you must restart omp.

### 11. sendMessage delivery modes
```typescript
pi.sendMessage(msg);                              // Default delivery
pi.sendMessage(msg, { deliverAs: "steer" });      // Injected as steering (high priority)
pi.sendMessage(msg, { deliverAs: "followUp" });   // Queued after current turn
pi.sendMessage(msg, { deliverAs: "nextTurn" });   // Delivered on next user message
pi.sendMessage(msg, { triggerTurn: true });        // Triggers an LLM response
```

### 12. Clickable footer buttons can launch full workflows (not just one command)
You can drive a multi-stage workflow by setting `ctx.ui.setStatus(<key>, <ansi button text>)` from an extension and patching `interactive-mode.ts` to map those ANSI labels to slash commands.

Practical pattern:
- Stage machine in extension (example: `plan -> implement -> submit-pr -> cleanup`)
- One shared status key (example: `implement-workflow`)
- Runtime click + hover mapping in patched `ACTION_BUTTONS`

### 13. Button click handlers must allow file slash commands
`extensionRunner.getCommand(name)` only resolves extension-registered commands. It does **not** include markdown/file slash commands like `/plan-new`.

If a clickable button should run file commands, validate with both:
- `extensionRunner.getCommand(name)`
- `isKnownSlashCommand('/name')`

Otherwise clicks appear to work visually but silently no-op for file commands.

### 14. Plan metadata capture is reliable via tool_call path observation
For workflows where planning writes docs to disk, capture metadata in `pi.on('tool_call')` by watching mutating tools (`edit`, `write`, `notebook`) and matching resolved paths (e.g., `docs/plans/*.md`).

This is robust even when plan mode internals change, because it keys off actual file writes.

### 15. Adding a new `/model` role is centralized
To add a new role like `Subagent`, update `src/config/model-registry.ts` in three places:
- `ModelRole` union
- `MODEL_ROLES` (name/tag/color for UI badge + menu label)
- `MODEL_ROLE_IDS` (drives `/model` action list and badge iteration order)

If you miss `MODEL_ROLE_IDS`, the role will exist in types but not appear correctly in `/model` menus.

### 16. Task subagent model selection is controlled in `src/task/index.ts`
Task tool subagent model resolution is determined by `modelOverride` precedence. For Subagent workflows, wire role lookup there (e.g., `settings.getModelRole("subagent")`) between explicit agent model and generic active/default fallback.

Recommended precedence:
1. explicit agent frontmatter model
2. Subagent role model (`/model` -> `Set as Subagent`)
3. current active session model
4. session default fallback

Important implementation detail: resolve this value at **task launch time** (inside the per-task runner), not once at Task tool start. That makes `/model` role changes apply immediately for newly spawned subagents without restarting OMP.

### 17. Thinking level is independent from `/model` roles
Model roles choose **which model** runs. Thinking level comes from agent frontmatter (`thinkingLevel` / `thinking-level`) in agent definitions.

For Task subagents:
- Bundled default lives in `src/task/agents.ts` (`task` agent)
- User override path for this fork: `<fork-root>/agent/agents/task.md`

Set `thinking-level: high` (or `xhigh`) in that user agent file if you want persistent local override without re-patching runtime files.

### 18. Footer hook statuses render in lexicographic key order
`StatusLineComponent.render()` sorts `hookStatuses` by key, then joins values. Use key prefixes when you need placement control.

Practical convention for clickable workflow buttons:
- left-most: `aaa-...`
- primary lifecycle: `implement-workflow`
- right-most destructive action: `zzzz-...`

### 19. Multi-button hover/click handling needs per-button status keys
If multiple clickable footer buttons can exist at once, each `ACTION_BUTTONS` entry should carry a `statusKey`.

When hover changes, restore/set using that button's own key (`setHookStatus(button.statusKey, ...)`) instead of a single shared key, or hover state will corrupt neighboring button text.

### 20. Add explicit manual fallback for metadata-driven workflows
For workflows that usually auto-read session metadata (e.g., `/plan-new` output), keep a manual path when metadata is absent:
- perform setup normally (worktree/deps/indexing)
- prefill editor with `ctx.ui.setEditorText(...)`
- ask user to attach source doc with `@...`

This prevents restarts/session loss from blocking implementation.

### 21. Treat repo source as the customization surface and reinstall globally after edits
For this fork, do not patch files inside the global Bun install. Edit repo files under `<fork-root>` and `<fork-root>/agent`, then follow `UPDATING.md`:
- `bun install`
- `bun run reinstall:fork`
- `command -v omp && bun pm bin -g`

If you change files under `<fork-root>/packages/`, run `bun --cwd=<fork-root> run reinstall:fork` and restart `omp`. If you only change files under `<fork-root>/agent/`, restart `omp`. Commit and push are for source control only; they do not refresh the live local install.

### 22. Use `effectiveAgent` when spawning subagents
If Task tool mutates an agent for runtime mode behavior (e.g., plan-mode system prompt/tool restrictions), pass that **effective** agent object into `runSubprocess`. Passing the original agent can silently ignore mode-specific behavior and confuse debugging.

### 23. Subagent token displays should use uncached tokens
For progress/status-line/subagent-header token counts, prefer `input + output` tokens. Including `cacheRead/cacheWrite` can produce huge, misleading numbers that look like runaway usage.

Recommended rule:
- display/progress: uncached tokens (`input + output`)
- optional diagnostics: show cache tokens separately

### 24. Keep subagent transcript rendering structured during live writes
Subagent `.jsonl` files are often read while still being appended. `SessionManager.open(...).buildSessionContext()` can occasionally fail or return sparse context during partial writes.

Use a two-stage strategy:
1. Primary: `SessionManager.open(...).buildSessionContext()` and render via `renderSessionContext(...)`
2. Fallback: parse raw transcript with `parseJsonlLenient(...)`, reconstruct a minimal `SessionContext`, and still render with `renderSessionContext(...)`

Avoid raw-text dump fallback as the default user path — it becomes unreadable wall-of-text under active subagent execution.

### 25. Show requested vs actual subagent model in viewer metadata
When debugging model routing, include both:
- requested model override (from Task result metadata)
- actual model seen in the subagent transcript (`model_change`)

If they differ, display both in the header/status line. This makes model-routing bugs immediately visible.

### 26. Persist workflow-critical source paths in extension state
For metadata-driven workflows (implement/review), persist canonical source paths (for example `planFilePath`, `planWorkspaceDir`) in extension state entries and restore them on `/resume`.

Do not rely only on "latest metadata in session" for follow-on actions. Binding workflow actions to persisted paths prevents mismatches across restarts, forks, and older sessions.

### 27. Add command-argument + UI fallback for metadata-dependent commands
If a command usually auto-resolves metadata (example: `/review-complete`), still support manual path input:
- parse optional slash-command args (including `@path` mention form)
- if metadata is missing, prompt with `ctx.ui.input(...)`
- continue the workflow (do not hard-fail unless no valid path is provided)

This keeps old sessions usable and avoids forcing manual chat-based workarounds.

### 28. Phase extraction from markdown must be section-aware and deduplicated
Simple `^#* Phase N` regex over the whole file can overcount phases when the plan has summaries, repeated headings, or references.

Use a robust extractor:
- prefer `Phase N` headings inside `## Phased Implementation Plan` section
- prefer direct child headings of that section when present
- dedupe by numeric phase id (first occurrence wins)

This prevents "detected 16 phases" bugs when the real plan has 8 phases.

### 29. Orchestrator review prompts must hard-constrain agent type and fan-out
For review/audit workflows, be explicit in the kickoff prompt:
- require `agent: "task"` for delegated phase reviewers (not `explore`)
- state parallel fan-out policy (`N phases => N task subagents in one Task call`)
- specify required review skills per task (for example `verification-before-completion`, `security-review`)

If you leave this ambiguous, orchestrators may pick cheaper but incorrect delegation patterns.

### 30. Runtime patch bundles must track moved utility exports
When OMP moved directory helpers out of `src/config.ts`, patched files still importing `APP_NAME`/`getAgentDir` from `../config` started failing module linking during `manage.sh apply` smoke checks.

Practical guardrails:
- Import path/directory helpers directly from `@oh-my-pi/pi-utils/dirs` in patch bundle files.
- Keep `manage.sh` `EXPECTED_VERSION` aligned to the tested OMP release.
- Keep a Bun module-import smoke check over patched entry files so apply fails fast and auto-restores on export drift.

---

## Reference Implementation

See `<fork-root>/agent/extensions/plan-worktree/index.ts` for a complete, production extension that:
- Keeps planning in the primary checkout via `/plan-new`, then launches implementation with `/implement`
- Captures strict `/plan-new` metadata by observing writes under `docs/plans/**/*.md`
- Shows dual initial footer actions (`Plan` + `Implement`) and stage-aware lifecycle buttons (`Implement` -> `Submit PR` (+ optional `Review Complete`) -> `Cleanup`)
- Adds a far-right destructive footer action (`Delete Worktree`) only during `Submit PR`, with confirmation modal
- Prompts for base branch + new branch name via `ctx.ui.select()` / `ctx.ui.input()`
- Creates a git worktree synchronously using `Bun.spawn` (not `pi.exec`)
- Verifies worktree creation (branch ref, directory, `git worktree list`)
- Dynamically discovers and installs project dependencies (`find` + lock file detection)
- Switches session cwd via `process.chdir()`
- Returns both a message and modified system prompt
- Registers `/implement`, `/review-complete`, `/submit-pr`, `/cleanup`, and `/worktree` commands
- Persists/restores worktree state so `/resume` re-enters the correct worktree context
- Falls back to manual implementation handoff (`@plan` attachment) when in-session metadata is missing
- Persists active plan file path/workspace metadata in worktree state so follow-on workflow actions (like review) use the exact plan bound to that worktree
- Supports manual review-plan selection via `/review-complete @docs/plans/...md` and UI input fallback when metadata is missing
- Uses section-aware + deduplicated phase extraction to avoid double-counting phases in review kickoff
- Includes startup patch-guard logic to detect/reapply runtime patch drift after upgrades
- Adds a dedicated `Subagent` model role (red badge) and routes phase Task subagents to it by default
- Uses high thinking level for bundled `task` subagents, with user override via `<fork-root>/agent/agents/task.md`
- Resolves `Subagent` model role at per-task launch so `/model` updates apply immediately (no restart required)
- Shows uncached token counts for subagent progress/view (`input + output`) to avoid cache-inflated metrics
- Preserves normal OMP message/tool formatting in subagent view even during partial transcript writes (lenient JSONL structured fallback)

---

## Available Imports

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

---

## Adding Newly Released Models (Updating the Built-in Model Catalog)

OMP's `/model` list comes from **built-in models shipped in** `@oh-my-pi/pi-ai` (plus optional `models.yml/models.json` overrides). If a newly released model doesn't show up, it's almost always one of these:

1. The model isn't shipped yet in your installed `@oh-my-pi/pi-ai` version.
2. `/model` only shows **available** models (providers you have auth for).
3. The upstream registry (`models.dev`) has the model, but the generator missed it.
4. The provider itself doesn't offer the model yet.

### How the model list is built

- Source of truth: `packages/ai/src/models.generated.ts` (auto-generated)
- Generator: `packages/ai/scripts/generate-models.ts`
- Primary upstream registry: `https://models.dev`
- OMP loads built-ins via `getProviders()/getModels()` from `@oh-my-pi/pi-ai`, then filters by auth.

### Normal workflow

1. Update the generator if needed (`packages/ai/scripts/generate-models.ts`)
2. Regenerate: `cd packages/ai && bun run generate-models`
3. Verify: `bun -e "import { getModels } from './src/models'; console.log(getModels('anthropic').map(m=>m.id))"`
4. Publish or run from source

### Temporary workaround while iterating on model definitions

Edit `packages/ai/src/models.generated.ts` in this repo, then reinstall from the fork with `bun run reinstall:fork`.

---

## Debugging

1. Check extension load: look for your extension name in `~/.omp/logs/omp.YYYY-MM-DD.log`
2. Use `pi.logger.debug("my-ext: description", { context })` (NOT console.log)
3. Check `~/.omp/agent/omp-crash.log` for TUI crashes
4. Extension errors are logged but typically don't crash the agent (the error message appears in the TUI)
5. `config.yml` → `disabledExtensions` can disable specific extensions without deleting them

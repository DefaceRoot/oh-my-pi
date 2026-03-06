# Oh My Pi Customization Quick Reference

## File Locations

```
~/.omp/agent/extensions/*.ts       # Extensions (preferred, auto-loaded)
~/.omp/agent/extensions/*/index.ts # Directory extensions (auto-loaded)
~/.omp/agent/hooks/{pre,post}/*.ts # Hooks (legacy, auto-loaded)
~/.omp/agent/agents/*.md           # Custom agent definitions
~/.omp/agent/rules/*.md            # Rules (auto-loaded)
~/.omp/agent/AGENTS.md             # Global system prompt
.omp/SYSTEM.md                     # Project system prompt
.omp/extensions/*.ts               # Project-level extensions
```

## Extension Skeleton

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // event.prompt, event.systemPrompt
    // ctx.ui, ctx.cwd, ctx.hasUI, ctx.abort()
    return { message: { ... }, systemPrompt: "..." };
  });
  
  pi.registerCommand("mycmd", {
    description: "...",
    handler: async (args, ctx) => { /* ctx is ExtensionCommandContext */ },
  });
}
```

## Events

| Event | Use For | Return Type |
|-------|---------|-------------|
| `before_agent_start` | Intercept prompts, inject context, modify system prompt | `{ message?, systemPrompt? }` |
| `tool_call` | Block tool execution (cannot modify inputs) | `{ block?, reason? }` |
| `tool_result` | Modify tool output | `{ content?, isError? }` |
| `session_start` | Initialize on session load | — |
| `session_switch` | Reset state on session change | — |
| `turn_end` | Post-turn actions (checkpoints) | — |

## UI Methods (ctx.ui)

```typescript
ctx.ui.select("Question", ["A", "B", "C"])  // string | undefined
ctx.ui.confirm("Title", "Message")          // boolean
ctx.ui.input("Prompt:", "default")          // string | undefined
ctx.ui.editor("Edit:", "prefill")           // string | undefined
ctx.ui.notify("Message", "info")            // "info" | "warning" | "error"
ctx.ui.setStatus("key", "Text")             // undefined to clear
ctx.ui.setEditorText("Prefill input")
```

## Shell Execution

```typescript
// DURING handler — pi.exec works fine
const res = await pi.exec("git", ["status"], { cwd: "/path" });
// res: { stdout, stderr, code, killed }

// AFTER handler returns (background) — use Bun.spawn
const proc = Bun.spawn(["git", "status"], { cwd: "/path", stdout: "pipe", stderr: "pipe" });
const stdout = await new Response(proc.stdout).text();
const code = await proc.exited;
```

## Messages

```typescript
// From handler return
return { message: { customType: "x", content: "...", display: true, details: {} } };

// From anywhere
pi.sendMessage({ customType: "x", content: "...", display: true });
pi.sendMessage(msg, { deliverAs: "steer" });      // high priority
pi.sendMessage(msg, { triggerTurn: true });         // triggers LLM response
```

## Switch Session Working Directory

```typescript
process.chdir("/new/path");  // Call in before_agent_start, before returning
```

## Logger (pi.logger)

```typescript
pi.logger.debug("msg", { context });  // Only: debug, warn, error
pi.logger.warn("msg");                // NO .info() — it doesn't exist
pi.logger.error("msg", { err });      // Signature: (message: string, context?: Record)
// Logs → ~/.omp/logs/omp.YYYY-MM-DD.log
```

## Rule Frontmatter

```yaml
---
description: What this rule does
alwaysApply: true           # OR
globs: ["*.py", "src/**/*"] # File patterns that trigger
---
```

## Subagent Model + Thinking Controls

- `/model` role assignments decide model selection (e.g., `Set as Subagent`, `Set as Explore`).
- Add new roles in `src/config/model-registry.ts` by updating:
  - `ModelRole`
  - `MODEL_ROLES`
  - `MODEL_ROLE_IDS`
- Task subagent model routing is selected in `src/task/index.ts` (`modelOverride` precedence).
- Resolve subagent model override at **per-task launch time** (inside `runTask`) so `/model` role changes apply immediately without restarting OMP.
- Use role-aware routing in task runtime:
  - `explore` agent runs -> `Explore` model role
  - other worker subagents -> `Subagent` model role
- If task execution mutates agent config for runtime mode behavior, pass `effectiveAgent` (not original `agent`) to `runSubprocess`.
- Thinking level is defined in agent frontmatter (`thinking-level`), not in `/model` roles.
- For persistent local overrides, define user agents in `~/.omp/agent/agents/` (commonly `task.md` + `explore.md`).

## Pitfalls

| Pitfall | Fix |
|---------|-----|
| `pi.logger.info(...)` | Doesn't exist. Use `debug`, `warn`, or `error` |
| `pi.logger.debug({ctx}, "msg")` | Wrong order. Use `pi.logger.debug("msg", {ctx})` |
| `pi.exec` in background promise | Stdout is empty. Use `Bun.spawn` instead |
| `tool_call` modify inputs | Can't. Only `{ block, reason }`. Use systemPrompt to steer |
| Clickable button only checks `extensionRunner.getCommand` | Also validate with `isKnownSlashCommand('/cmd')` so file commands (like `/plan-new`) can be clicked |
| Footer workflow needs stage transitions | Drive status text from extension state machine (e.g., `Plan -> Implement -> Submit PR (+ optional Review Complete) -> Cleanup`) |
| Metadata-driven command fails in older sessions | Add slash-arg parsing (`/review-complete @docs/plans/...md`) plus `ctx.ui.input(...)` fallback |
| Review kickoff says wrong phase count | Use section-aware phase extraction (`Phased Implementation Plan`) and dedupe by phase number |
| Orchestrator picked `explore` for heavy review | Hard-require `agent: "task"` in kickoff prompt and specify required skills per phase task |
| New `/model` role doesn't appear in selector | Update all three: `ModelRole`, `MODEL_ROLES`, and `MODEL_ROLE_IDS` |
| Setting `Subagent` model doesn't change reasoning depth | Thinking level comes from agent frontmatter (`thinking-level`), not model roles |
| Subagent token count looks absurdly high | For display/progress use uncached tokens (`input + output`), not cache-inclusive totals |
| Subagent transcript view becomes raw wall-of-text | Use `SessionManager.open(...).buildSessionContext()` first, then lenient JSONL fallback that still renders via `renderSessionContext(...)` |
| Subagent model seems ignored after `/model` change | Recompute modelOverride per task spawn and compare requested-vs-actual model in subagent header |
| Explore runs still use default scout model | Add `explore` role to model registry and route `agent.name === "explore"` to `getModelRole("explore")` in task runtime |
| Emoji in status strings | TUI width bugs. Use ASCII only |
| Extension not loading | Restart omp. Check `config.yml` → `disabledExtensions` |
| `ctx.ui.select()` returns undefined | User cancelled. Always check |

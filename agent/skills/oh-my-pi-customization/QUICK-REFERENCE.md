# Oh My Pi Customization Quick Reference

For this fork, `~/.omp/agent` should be a symlink to `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent`. Edit the repo files directly, then follow `UPDATING.md` to reinstall the fork into `omp`.

## File Locations

```
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/extensions/*.ts        # Extensions (preferred, auto-loaded)
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/extensions/*/index.ts  # Directory extensions (auto-loaded)
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/hooks/{pre,post}/*.ts  # Hooks (legacy, auto-loaded)
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/agents/*.md            # Custom agent definitions
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/rules/*.md             # Rules (auto-loaded)
/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/AGENTS.md              # Global system prompt
.omp/SYSTEM.md                                                             # Project system prompt
.omp/extensions/*.ts                                                       # Project-level extensions
```

## Reinstall Loop

1. `git fetch upstream && git rebase upstream/main`
2. `bun install`
3. `bun run reinstall:fork`
4. `command -v omp && bun pm bin -g`

`bun run reinstall:fork` packs the local workspace packages into tarballs and reinstalls those tarballs globally. Use that instead of `bun link` or `bun install -g /path/to/packages/coding-agent`.

See `UPDATING.md` for the full workflow, PATH checks, and smoke verification steps.

## Extension Skeleton

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    return { message: { ... }, systemPrompt: "..." };
  });

  pi.registerCommand("mycmd", {
    description: "...",
    handler: async (args, ctx) => {
      // ctx is ExtensionCommandContext
    },
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
ctx.ui.confirm("Title", "Message")             // boolean
ctx.ui.input("Prompt:", "default")             // string | undefined
ctx.ui.editor("Edit:", "prefill")              // string | undefined
ctx.ui.notify("Message", "info")               // "info" | "warning" | "error"
ctx.ui.setStatus("key", "Text")                // undefined to clear
ctx.ui.setEditorText("Prefill input")
```

## Shell Execution

```typescript
const res = await pi.exec("git", ["status"], { cwd: "/path" });

const proc = Bun.spawn(["git", "status"], { cwd: "/path", stdout: "pipe", stderr: "pipe" });
const stdout = await new Response(proc.stdout).text();
const code = await proc.exited;
```

## Messages

```typescript
return { message: { customType: "x", content: "...", display: true, details: {} } };

pi.sendMessage({ customType: "x", content: "...", display: true });
pi.sendMessage(msg, { deliverAs: "steer" });
pi.sendMessage(msg, { triggerTurn: true });
```

## Switch Session Working Directory

```typescript
process.chdir("/new/path");
```

## Logger (pi.logger)

```typescript
pi.logger.debug("msg", { context });
pi.logger.warn("msg");
pi.logger.error("msg", { err });
```

## Rule Frontmatter

```yaml
---
description: What this rule does
alwaysApply: true
globs: ["*.py", "src/**/*"]
---
```

## Subagent Model + Thinking Controls

- `/model` role assignments decide model selection (e.g., `Set as Subagent`, `Set as Explore`).
- Add new roles in `src/config/model-registry.ts` by updating `ModelRole`, `MODEL_ROLES`, and `MODEL_ROLE_IDS`.
- Task subagent model routing is selected in `src/task/index.ts` (`modelOverride` precedence).
- Resolve subagent model override at per-task launch time so `/model` role changes apply immediately without restarting OMP.
- Use role-aware routing in task runtime:
  - `explore` agent runs -> `Explore` model role
  - other worker subagents -> `Subagent` model role
- If task execution mutates agent config for runtime mode behavior, pass `effectiveAgent` to `runSubprocess`.
- Thinking level is defined in agent frontmatter (`thinking-level`), not in `/model` roles.
- For persistent local overrides in this fork, edit `/home/colin/devpod-repos/DefaceRoot/oh-my-pi/agent/agents/`.

## Pitfalls

| Pitfall | Fix |
|---------|-----|
| `pi.logger.info(...)` | Doesn't exist. Use `debug`, `warn`, or `error` |
| `pi.logger.debug({ctx}, "msg")` | Wrong order. Use `pi.logger.debug("msg", {ctx})` |
| `pi.exec` in background promise | Stdout is empty. Use `Bun.spawn` instead |
| `tool_call` modify inputs | Can't. Only `{ block, reason }`. Use systemPrompt to steer |
| Clickable button only checks `extensionRunner.getCommand` | Also validate with `isKnownSlashCommand('/cmd')` so file commands can be clicked |
| Footer workflow needs stage transitions | Drive status text from extension state machine |
| Metadata-driven command fails in older sessions | Add slash-arg parsing plus `ctx.ui.input(...)` fallback |
| Review kickoff says wrong phase count | Use section-aware phase extraction and dedupe by phase number |
| Orchestrator picked `explore` for heavy review | Require `agent: "task"` and specify review skills per phase |
| New `/model` role doesn't appear in selector | Update `ModelRole`, `MODEL_ROLES`, and `MODEL_ROLE_IDS` |
| Setting `Subagent` model doesn't change reasoning depth | Thinking level comes from agent frontmatter |
| Extension not loading | Restart omp. Check `config.yml` → `disabledExtensions` |
| `ctx.ui.select()` returns undefined | User cancelled. Always check |

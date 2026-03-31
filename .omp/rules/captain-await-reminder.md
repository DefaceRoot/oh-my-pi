---
description: Remind captain agents to use await after delegating to subagents
condition: ["_i\\":\\s*\\"Delegating"]
scope: ["tool:task"]
interruptMode: "always"
---

**You just delegated tasks to subagents. Now you MUST monitor them with `await`.**

## Why This Matters

When you delegate work via `task`, those subagents run asynchronously. If you don't monitor them:
- **Silent failures** — Subagents may error and you'll never know
- **Workflow stalls** — Sessions freeze waiting for results that never arrive  
- **Wasted tokens** — You continue planning unaware that critical tasks failed

## What You Must Do Now

**Immediately after delegating, use `await` to check subagent status:**

```typescript
// 1. First — delegate the work
const delegation = task({
  agent: "implement",
  context: "...",
  tasks: [{ id: "feature-x", description: "...", assignment: "..." }]
});

// 2. Then — AWAIT the results (don't just continue!)
const results = await await({ jobs: [delegation] });

// 3. Verify — Check status before proceeding
if (results.some(r => r.status === "error")) {
  // Handle failures — retry, re-delegate, or escalate
}
```

## Critical Rules

- **Never delegate without awaiting** — Every `task()` call must have a corresponding `await()`
- **Check for errors** — Always inspect the job results for failure states
- **Don't assume success** — Subagents can fail silently; verify before using their outputs
- **Use appropriate timeout** — Set a reasonable timeout on `await` for your workload

## Remember

Your role as a captain is to **oversee and coordinate**. Delegation without monitoring is abandonment. Use `await` to ensure your subagents succeed.

---
description: "Better Context (BTCA) usage patterns. Read ONLY when using mcp_better_context_* tools."
alwaysApply: false
---

## BTCA (Better Context) Usage

BTCA clones repos and provides semantic search against the actual source — use it before grepping manually for known repos.

**Available resources** (call `mcp_better_context_listresources` to see current list):
- oh-my-pi — OMP upstream source code
- dragonglass — Dragonglass project

**Pattern:**
1. `mcp_better_context_listresources` → confirm resource name
2. `mcp_better_context_ask` with specific question about the codebase
3. Only fall back to grep/read if BTCA doesn't have the repo

Prefer BTCA over manual grep for any OMP internals question (extension API, slash commands, model roles, session format, etc.).

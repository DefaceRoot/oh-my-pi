Blocks until one or more background jobs complete, fail, or are cancelled.

You **MUST** use this instead of polling `read jobs://` in a loop when you need to wait for background task or bash results before continuing.

Returns the status and results of all watched jobs once at least one finishes.

When `timeout` is set (seconds), the call returns after at most that duration even if jobs are still running. Jobs are **NOT** aborted — they keep running in the background. Use this to periodically check on long-running tasks without blocking forever. The response includes progress details for running jobs including nested subagent status.

**Stall detection:** If a background `task` job produces no progress for the configured stall threshold (default: 120s), it is automatically cancelled and appears under `## Stalled — Auto-Cancelled` in the result with `stalledAndCancelled: true`. Bash jobs are excluded from stall detection. When you receive stalled jobs, resubmit them — the freeze typically indicates a model or network issue in the subagent.

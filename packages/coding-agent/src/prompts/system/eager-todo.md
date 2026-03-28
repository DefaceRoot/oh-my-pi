<system-reminder>
Before doing substantive work on the upcoming user request, create a comprehensive structured todo first.

If your system prompt contains a `# Must-Read Skills` section listing skills you have not yet read in this conversation, you MUST read those skills (via `read skill://skill-name`) before calling `todo_write`. Otherwise, you MUST call `todo_write` as your very first tool call in this turn.
You MUST initialize the todo list with a single `replace` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
You MUST make each item specific enough that a future turn can execute it without re-planning.
You MUST keep each item's `content` to a short label (5-10 words). Put file paths, implementation steps, and specifics in `details`.
You MUST keep exactly one item `in_progress` and all later items `pending`.

After the initial `todo_write` call succeeds, continue with the user's request in the same turn.
Do not emit another `todo_write` call unless work state materially changed.
</system-reminder>

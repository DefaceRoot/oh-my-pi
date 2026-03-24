Maintain a phased task list via incremental `ops`.

Primary operation: `update` (status/content/notes changes). Use structural ops only when plan shape changes.

<critical>
You must call this tool around each tracked task:
1. Before starting: `{op:"update", id:"task-N", status:"in_progress"}`
2. After finishing: `{op:"update", id:"task-N", status:"completed"}`

Keep exactly one task `in_progress` at a time, and mark completion immediately (no batching delays).
</critical>

<when-to-use>
Create/update a todo list when work has 3+ meaningful steps, the user asks for one, or new mid-task requirements must be tracked.
Skip for single-step trivial actions or purely conversational replies.
</when-to-use>

<ops>
- `update`: mark status (`pending` | `in_progress` | `completed` | `abandoned`) and/or edit content/notes
- `replace`: initialize or fully restructure the whole phased plan
- `add_phase`: append a new phase discovered mid-task
- `add_task`: add task to existing phase
- `remove_task`: remove irrelevant task
</ops>

|op|When to use|
|---|——|
|`update`|Mark a task in_progress / completed / abandoned, or edit content/notes|
|`replace`|Initial setup, or full restructure when the plan changes significantly|
|`add_phase`|Add a new phase of work discovered mid-task|
|`add_task`|Add a task to an existing phase|
|`remove_task`|Remove a task that is no longer relevant|

## Statuses

|Status|Meaning|
|---|---|
|`pending`|Not started|
|`in_progress`|Currently working — exactly one at a time|
|`completed`|Fully done|
|`abandoned`|Dropped intentionally|

## Rules
- You **MUST** mark `in_progress` **before** starting work, not after
- You **MUST** mark `completed` **immediately** — never defer
- You **MUST** keep exactly **one** task `in_progress`
- You **MUST** complete phases in order — do not mark later tasks `completed` while earlier ones are `pending`
- On blockers: keep `in_progress`, add a new task describing the blocker
- Multiple ops can be batched in one call (e.g., complete current + start next)
</protocol>

## Task Anatomy
- `content`: Short label (5-10 words). What is being done, not how.
- `details`: File paths, implementation steps, edge cases. Shown only when task is active.
- `notes`: Runtime observations added during execution.

<avoid>
- Single-step tasks — act directly
- Conversational or informational requests
- Tasks completable in under 3 trivial steps
</avoid>

<example name="start-task">
Mark task-2 in_progress before beginning work:
ops: [{op: "update", id: "task-2", status: "in_progress"}]
</example>

<example name="complete-and-advance">
Finish task-2 and start task-3 in one call:
ops: [
  {op: "update", id: "task-2", status: "completed"},
  {op: "update", id: "task-3", status: "in_progress"}
]
</example>

<example name="add_task">
Add a follow-up task with implementation specifics in `details`:
ops: [{op: "add_task", phase: "Implementation", after: "task-2", task: {content: "Handle retries", details: "Update retry.ts to cap exponential backoff and preserve AbortSignal handling", status: "pending"}}]
</example>

<example name="initial-setup">
Replace is for setup only. Prefer add_phase / add_task for incremental additions.
ops: [{op: "replace", phases: [
  {name: "Investigation", tasks: [{content: "Read source"}, {content: "Map callsites"}]},
  {name: "Implementation", tasks: [{content: "Apply fix", details: "Update parser.ts to handle edge case in line 42"}, {content: "Run tests"}]}
]}]
</example>

<example name="skip">
User: "What does this function do?" / "Add a comment" / "Run npm install"
→ Do it directly. No list needed.
</example>

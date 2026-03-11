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

<rules>
- Set `in_progress` before beginning work.
- Set `completed` immediately after finishing.
- Keep one-and-only-one `in_progress` task.
- Complete tasks in phase order unless you intentionally restructure the plan.
- On blockers, keep the current task `in_progress` and add a blocker task/note.
</rules>

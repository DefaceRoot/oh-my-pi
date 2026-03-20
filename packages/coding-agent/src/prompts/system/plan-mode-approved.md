<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`

## Plan

{{planContent}}

<instruction>
You **MUST** execute this plan from `{{finalPlanFilePath}}` according to its explicit unit dependencies. You have full tool access.
You **MUST** verify each completed unit before proceeding to dependent work.
When the plan marks sibling units `(P)`, you **MUST** re-check their `Parallel safety` assumptions against current repo state before running them together.
If any parallel-safety or verification assumption is stale, you **MUST** fall back to sequential execution and preserve the plan's safety intent.
{{#has tools "todo_write"}}
Before execution, you **MUST** initialize todo tracking for this plan with `todo_write`.
After each completed unit, you **MUST** immediately update `todo_write` so progress stays visible.
If a `todo_write` call fails, you **MUST** fix the todo payload and retry before continuing silently.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>
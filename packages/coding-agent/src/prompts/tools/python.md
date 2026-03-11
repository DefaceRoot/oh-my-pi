Runs Python cells in a persistent IPython kernel.

<instruction>
- Kernel state persists across calls (imports/variables/functions).
- Prefer small cells and incremental execution.
- Keep explanations in assistant text or cell titles, not inside code.
- If a call fails, rerun only the corrected cell(s).
</instruction>

{{#if categories.length}}
<prelude>
Helpers auto-print and return values for chaining.

{{#each categories}}
### {{name}}

```
{{#each functions}}
{{name}}{{signature}}
    {{docstring}}
{{/each}}
```
{{/each}}
</prelude>
{{/if}}

<output>
Notebook-style output is rendered for users (`display(...)`, markdown/html/json, figures).
</output>

<caution>
- Per-call mode starts a fresh kernel each call.
- In session mode, use `reset: true` when you need a clean state.
</caution>

<critical>
- Use `run()` for shell commands; do not use raw `subprocess`.
</critical>

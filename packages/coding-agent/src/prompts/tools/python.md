Runs Python cells in a persistent IPython kernel.

<instruction>
Kernel persists across calls and cells; **imports, variables, and functions survive—use this.**
**Work incrementally:**
- You **SHOULD** use one logical step per cell (imports, define function, test it, use it)
- You **SHOULD** pass multiple small cells in one call
- You **SHOULD** define small functions you can reuse and debug individually
- You **MUST** put workflow explanations in assistant message or cell title
**When something fails:**
- Errors tell you which cell failed (e.g., "Cell 3 failed")
- You **SHOULD** resubmit only the fixed cell (or fixed cell + remaining cells)
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
Notebook-style output is rendered for users (`display(…)`, markdown/html/json, figures).
</output>

<caution>
- Per-call mode starts a fresh kernel each call.
- In session mode, use `reset: true` when you need a clean state.
</caution>

<critical>
- Use `run()` for shell commands; do not use raw `subprocess`.
</critical>
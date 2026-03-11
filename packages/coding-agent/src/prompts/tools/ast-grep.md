Structural code search using native ast-grep.

<instruction>
- Use when syntax shape matters (calls, declarations, constructs), not plain text.
- Scope with `path` (file/dir/glob) to keep results deterministic.
- In mixed-language trees, set `lang` explicitly.
- `patterns` is required and must contain at least one AST pattern.
- `selector` is only for contextual matching.
- Use `$$$NAME` for variadic captures; repeated metavariables must match identical code.
</instruction>

<output>
Returns matches grouped by file with ranges/captures, plus summary counts and parse issues.
</output>

<critical>
- Always provide `patterns`.
- Avoid repo-root AST scans when a narrower language/path scope is known.
- For broad open-ended subsystem exploration, use Task with explore subagents first.
</critical>

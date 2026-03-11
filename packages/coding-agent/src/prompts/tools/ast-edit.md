Structural AST rewrites using native ast-grep.

<instruction>
- Use for codemods where text replace is unsafe.
- Narrow scope with `path` (file/dir/glob), and set `lang` in mixed-language trees.
- Treat parse issues as a scoping problem: tighten `path`/`lang` and retry.
- Captured metavariables (`$A`, `$$$ARGS`) are substituted in each op's `out` template.
- Rewrites are 1:1 substitutions per match.
</instruction>

<output>
Returns replacement summary, per-file counts, diffs, and parse issues.
</output>

<critical>
- `ops` must include at least one `{ pat, out }` entry.
- If path spans multiple languages, set `lang` for deterministic rewrites.
- For one-off local text edits, prefer `edit`.
</critical>
